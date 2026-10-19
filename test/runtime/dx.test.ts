/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- runtime.bus is untyped here: these tests do not load generated types */
import { describe, expect, it } from "bun:test";

import { buildRuntime, DispatchkitError, StandardSchemaError } from "../../src/index.ts";
import { dispatchkitImportLine, runtimeImport, withTempProject } from "../test-helpers.ts";

const imp = dispatchkitImportLine();
const typedImport = `import { typed } from ${JSON.stringify(runtimeImport)};`;

describe("developer experience", () => {
  it("skips runtime validation for typed<T>() schemas", async () => {
    await withTempProject(
      {
        "src/modules/echo.query.ts": `${imp}\n${typedImport}
export default defineQuery({ input: typed<{ id: string }>(), return: typed<number>(), handler: (ctx) => ctx.input });`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        const echo = (runtime.bus as any).query.echo;
        expect(await echo({ anything: true })).toEqual({ anything: true });
        expect(echo.$input["~standard"].vendor).toBe("@orria/dispatchkit/typed");
        await runtime.dispose();
      },
    );
  });

  it("exposes error codes on DispatchkitError", async () => {
    await withTempProject(
      {
        "src/modules/write.mutation.ts": `${imp}\nexport default defineMutation({ handler: () => 1 });`,
        "src/modules/read.query.ts": `${imp}\nexport default defineQuery({ handler: (ctx) => ctx.bus.mutation.write() });`,
        "src/modules/strict.query.ts": `${imp}
import { z } from "zod";
export default defineQuery({ input: z.object({ n: z.number() }), handler: () => 1 });`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        const query = (runtime.bus as any).query;

        const guard = await query.read().catch((error: unknown) => error);
        expect(guard).toBeInstanceOf(DispatchkitError);
        expect(guard.code).toBe("DISPATCHKIT_CQRS_GUARD");

        const invalid = await query.strict({ n: "x" }).catch((error: unknown) => error);
        expect(invalid).toBeInstanceOf(DispatchkitError);
        expect(invalid.code).toBe("DISPATCHKIT_VALIDATION_ERROR");
        expect(invalid.cause).toBeInstanceOf(StandardSchemaError);
        expect(invalid.cause).toBeInstanceOf(DispatchkitError);
        expect(invalid.cause.code).toBe("DISPATCHKIT_SCHEMA_VALIDATION_ERROR");
        await runtime.dispose();
      },
    );
  });

  it("keeps the full console API on the mounted fallback console", async () => {
    await withTempProject({}, async (rootDir) => {
      const runtime = await buildRuntime({ rootDir });
      expect(typeof console.table).toBe("function");
      expect(typeof console.time).toBe("function");
      expect(typeof console.group).toBe("function");
      await runtime.dispose();
    });
  });

  it("orders generated artifacts independently of the locale", async () => {
    await withTempProject(
      {
        "src/transport/alpha.ts": `${imp}\nexport default defineTransport(() => ({}));`,
        "src/transport/Zeta.ts": `${imp}\nexport default defineTransport(() => ({}));`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        const manifest = (await Bun.file(
          `${rootDir}/src/generated/runtime/manifest.json`,
        ).json()) as {
          transport: Array<{ key: string }>;
        };
        expect(manifest.transport.map((module) => module.key)).toEqual(["Zeta", "alpha"]);
        await runtime.dispose();
      },
    );
  });
});
