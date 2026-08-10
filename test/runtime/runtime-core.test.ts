import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildRuntime } from "../../src/index.ts";
import { dispatchkitImportLine, withTempProject } from "../test-helpers.ts";

describe("runtime logger", () => {
  it("mounts global console and supports fallback logger", async () => {
    await withTempProject(
      {
        "src/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({
          rootDir,
          srcDir: join(rootDir, "src"),
        });
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, "console");

        expect(runtime.logger).toBeDefined();
        expect(typeof runtime.logger.info).toBe("function");
        expect(descriptor?.configurable).toBe(true);
        expect(descriptor?.writable).toBe(true);
      },
    );
  });

  it("replaces the mounted console when a new runtime is built", async () => {
    const customConsole = {
      log: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    } as unknown as Console;

    await withTempProject(
      {
        "src/logger.ts": `${dispatchkitImportLine()}\nconst logger = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };\nexport default defineLogger(() => ({ logger, console: globalThis.customConsole }));`,
      },
      async (rootDir) => {
        (globalThis as typeof globalThis & { customConsole?: typeof customConsole }).customConsole = customConsole;
        await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });

        expect(globalThis.console).toBe(customConsole);
        delete (globalThis as typeof globalThis & { customConsole?: typeof customConsole }).customConsole;
      },
    );
  });
});

describe("runtime infra mapping", () => {
  it("exposes infra by domain key from file name and module context", async () => {
    await withTempProject(
      {
        "src/infra/database.ts": `${dispatchkitImportLine()}
class DatabaseClient {
  kind = "database";
}
export default defineInfra(async () => new DatabaseClient());`,
        "src/modules/read.query.ts": `${dispatchkitImportLine()}
export default defineQuery({
  handler: async () => ({ kind: getModuleCtx().infra.database.kind }),
});`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
        const bus = runtime.bus as any;

        expect((runtime.infra as any).database.kind).toBe("database");
        await expect(bus.query.read({})).resolves.toEqual({ kind: "database" });
      },
    );
  });

  it("uses folder name for infra index.ts modules", async () => {
    await withTempProject(
      {
        "src/infra/database/index.ts": `${dispatchkitImportLine()}
export default defineInfra(async () => ({ client: "ok" }));`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
        expect((runtime.infra as any).database).toEqual({ client: "ok" });
      },
    );
  });
});

describe("runtime cqrs guards", () => {
  it("blocks query->mutation and mutation->action, allows valid chains", async () => {
    await withTempProject(
      {
        "src/modules/base.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => 1 });`,
        "src/modules/do.mutation.ts": `${dispatchkitImportLine()}\nexport default defineMutation({ handler: async (ctx) => ctx.bus.query.base({}) });`,
        "src/modules/start.action.ts": `${dispatchkitImportLine()}\nexport default defineAction({ handler: async (ctx) => ctx.bus.mutation.do({}) });`,
        "src/modules/forbidden-query.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async (ctx) => ctx.bus.mutation.do({}) });`,
        "src/modules/forbidden-mutation.mutation.ts": `${dispatchkitImportLine()}\nexport default defineMutation({ handler: async (ctx) => ctx.bus.action.start({}) });`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({
          rootDir,
          srcDir: join(rootDir, "src"),
        });
        const bus = runtime.bus as any;

        await expect(bus.action.start({})).resolves.toBe(1);
        await expect(bus.query.forbiddenQuery({})).rejects.toThrow(
          "DISPATCHKIT_CQRS_GUARD",
        );
        await expect(bus.mutation.forbiddenMutation({})).rejects.toThrow(
          "DISPATCHKIT_CQRS_GUARD",
        );
      },
    );
  });
});

describe("runtime validation", () => {
  it("validates input/return and supports $unsafe", async () => {
    await withTempProject(
      {
        "src/modules/check.mutation.ts": `${dispatchkitImportLine()}\nimport { z } from "zod";\nexport default defineMutation({\n  input: z.object({ value: z.number() }),\n  return: z.object({ value: z.number() }),\n  handler: async (ctx) => ctx.input.value === 13 ? ({ value: "bad" } as unknown as { value: number }) : ({ value: ctx.input.value })\n});`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({
          rootDir,
          srcDir: join(rootDir, "src"),
        });
        const bus = runtime.bus as any;

        await expect(bus.mutation.check({ value: "1" })).rejects.toThrow(
          "input validation",
        );
        await expect(bus.mutation.check({ value: 13 })).rejects.toThrow(
          "return validation",
        );
        await expect(
          bus.mutation.check.$unsafe({ value: "1" } as unknown as { value: number }),
        ).resolves.toEqual({
          value: "1",
        });
      },
    );
  });
});
