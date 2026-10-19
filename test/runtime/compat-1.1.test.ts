/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- runtime.bus/transport are untyped here: these tests do not load generated types */
import { describe, expect, it } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildRuntime, watchRuntime } from "../../src/index.ts";
import { dispatchkitImportLine, runtimeImport, withTempProject } from "../test-helpers.ts";

// Behaviour of 1.1.0 that the optimized runtime must keep.
const imp = dispatchkitImportLine();
const api = JSON.stringify(runtimeImport);

describe("1.1 compatibility", () => {
  it("rejects issues from validators returning promises of another realm", async () => {
    await withTempProject(
      {
        "src/modules/check.query.ts": `${imp}
import { runInNewContext } from "node:vm";
export default defineQuery({
  input: { "~standard": { version: 1, vendor: "realm", validate: () => runInNewContext('Promise.resolve({ issues: [{ message: "invalid" }] })') } },
  handler: () => "HANDLER_RAN",
});`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        const error = await (runtime.bus as any).query.check(1).catch((cause: unknown) => cause);
        expect(error.message).toContain("check failed input validation");
        expect(error.cause.issues[0].message).toBe("invalid");
        await runtime.dispose();
      },
    );
  });

  it("keeps the CQRS frame for infra of a runtime built inside a query", async () => {
    await withTempProject(
      {
        "inner/package.json": "{}",
        "inner/src/modules/write.mutation.ts": `${imp}
export default defineMutation({ handler: () => { (globalThis as any).__dkWrites = ((globalThis as any).__dkWrites ?? 0) + 1; } });`,
        "inner/src/infra/start.ts": `${imp}
export default defineInfra(async () => ({ result: await getModuleCtx().bus.mutation.write() }));`,
        "src/modules/trigger.query.ts": `import { defineQuery, buildRuntime } from ${api};
export default defineQuery({ handler: async () => {
  const inner = await buildRuntime({ rootDir: new URL("../../inner", import.meta.url).pathname, mountGlobal: false, generateArtifacts: false });
  await inner.dispose();
  return "BUILT";
} });`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        await expect((runtime.bus as any).query.trigger()).rejects.toThrow(
          'DISPATCHKIT_CQRS_GUARD: query "trigger" cannot call mutation "write"',
        );
        expect((globalThis as any).__dkWrites ?? 0).toBe(0);
        await runtime.dispose();
      },
    );
  });

  it("gives every call its own context, built from the current runtime fields", async () => {
    await withTempProject(
      {
        "src/modules/poison.query.ts": `${imp}
export default defineQuery({ handler: () => { getModuleCtx().config = { SERVICE_NAME: "changed" } as never; return getModuleCtx().config.SERVICE_NAME; } });`,
        "src/modules/read.query.ts": `${imp}
export default defineQuery({ handler: (ctx) => ({ name: ctx.config.SERVICE_NAME, infra: (ctx.infra as any).value }) });`,
        "src/modules/self.query.ts": `${imp}
export default defineQuery({ handler: function (this: { kind: string }) { return this.kind; } });`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        const query = (runtime.bus as any).query;
        expect(await query.poison()).toBe("changed");
        expect((await query.read()).name).toBe("dispatchkit-test-service");

        (runtime as any).infra = { value: "replacement" };
        expect((await query.read()).infra).toBe("replacement");
        expect(await query.self()).toBe("query");
        await runtime.dispose();
      },
    );
  });

  it("honours the get trap of transports that are proxies themselves", async () => {
    await withTempProject(
      {
        "src/transport/computed.ts": `${imp}
const target = { owner: "raw" };
export default defineTransport(() => new Proxy(target, {
  get: (object, key) => key === "owner" ? "computed-owner" : Reflect.get(object, key),
}));`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        expect((runtime.transport as any).computed.owner).toBe("computed-owner");
        await runtime.dispose();
      },
    );
  });

  it("regenerates on renames of directories with dots and on changes during startup", async () => {
    const op = `${imp}\nexport default defineQuery({ handler: () => 1 });`;
    await withTempProject({ "src/modules/v1.0/a.query.ts": op }, async (rootDir) => {
      const srcDir = join(rootDir, "src");
      const controller = new AbortController();
      let regenerated = 0;
      const watching = watchRuntime({
        rootDir,
        debounceMs: 20,
        signal: controller.signal,
        onInfo: (message) => {
          // Changed right after the initial generation, before "watching" is reported.
          if (
            message.includes("generated runtime artifacts:") &&
            !message.includes("regenerated")
          ) {
            writeFileSync(join(srcDir, "modules/b.query.ts"), op);
          }
          if (message.includes("watching")) {
            setTimeout(
              () => renameSync(join(srcDir, "modules/v1.0"), join(srcDir, "modules/v2.0")),
              100,
            );
          }
          if (message.includes("regenerated")) regenerated += 1;
        },
      });
      const deadline = Date.now() + 3000;
      let files: string[] = [];
      while (Date.now() < deadline) {
        await Bun.sleep(50);
        const manifest = (await Bun.file(
          join(srcDir, "generated/runtime/manifest.json"),
        ).json()) as {
          modules: Array<{ filePath: string }>;
        };
        files = manifest.modules.map((module) => module.filePath);
        if (files.includes("v2.0/a.query.ts") && files.includes("b.query.ts")) break;
      }
      controller.abort();
      await watching;
      expect(files).toEqual(["b.query.ts", "v2.0/a.query.ts"]);
      expect(regenerated).toBeGreaterThan(0);
    });
  });
});
