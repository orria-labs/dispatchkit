/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- runtime.bus/transport are untyped here: these tests do not load generated types */
import { describe, expect, it } from "bun:test";

import { buildRuntime, StandardSchemaError } from "../../src/index.ts";
import { dispatchkitImportLine, withTempProject } from "../test-helpers.ts";

const imp = dispatchkitImportLine();

describe("Standard Schema validation", () => {
  it("combines Zod input transformations with Valibot return transformations", async () => {
    await withTempProject(
      {
        "src/modules/convert.query.ts": `${imp}
import { z } from "zod";
import * as v from "valibot";
export default defineQuery({
  input: z.string().transform(s => s.length),
  return: v.pipe(v.string(), v.transform(Number)),
  handler: ctx => String(ctx.input * 2),
});`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        expect(await (runtime.bus as any).query.convert("abc")).toBe(6);
        expect(await (runtime.bus as any).query.convert.$unsafe(3)).toBe("6");
        expect((runtime.bus as any).query.convert.$input["~standard"].vendor).toBe("zod");
        expect((runtime.bus as any).query.convert.$return["~standard"].vendor).toBe("valibot");
        await runtime.dispose();
      },
    );
  });

  it("awaits asynchronous validation and retains issue paths and phase", async () => {
    await withTempProject(
      {
        "src/modules/check.query.ts": `${imp}
import * as v from "valibot";
export default defineQuery({
  input: v.objectAsync({ name: v.pipeAsync(v.string(), v.checkAsync(async value => value === "ok", "Expected ok")) }),
  return: v.string(),
  handler: ctx => ctx.input.name,
});`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        expect(await (runtime.bus as any).query.check({ name: "ok" })).toBe("ok");
        try {
          await (runtime.bus as any).query.check({ name: "bad" });
          throw new Error("Expected validation to fail");
        } catch (error) {
          expect((error as Error).message).toContain("input validation");
          expect((error as Error).cause).toBeInstanceOf(StandardSchemaError);
          const cause = (error as Error).cause as StandardSchemaError;
          expect(cause.issues[0]?.message).toBe("Expected ok");
          expect(cause.issues[0]?.path?.[0]).toMatchObject({ key: "name" });
        }
        await runtime.dispose();
      },
    );
  });

  it("accepts a plain JavaScript Standard Schema including undefined successful output", async () => {
    await withTempProject(
      {
        "src/modules/plain.query.ts": `${imp}
const schema = { "~standard": { version: 1, vendor: "custom", validate: async () => ({ value: undefined }) } };
export default defineQuery({ input: schema, return: schema, handler: ctx => ctx.input });`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        expect(await (runtime.bus as any).query.plain("anything")).toBeUndefined();
        await runtime.dispose();
      },
    );
  });

  it("validates Valibot config and merges transformed fields with builtin defaults", async () => {
    await withTempProject(
      {
        ".env": "PORT=4321\n",
        "src/config.ts": `${imp}
import * as v from "valibot";
export default defineConfig(v.object({ PORT: v.pipe(v.string(), v.transform(Number)) }));`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        expect(runtime.config.PORT).toBe(4321);
        expect(runtime.config.SERVICE_NAME).toBe("dispatchkit-test-service");
        expect(runtime.config.LOG_LEVEL).toBe("info");
        expect("mountGlobal" in runtime.config).toBe(false);
        await runtime.dispose();
      },
    );
  });

  it("rejects validators without the Standard Schema contract at startup", async () => {
    await withTempProject(
      {
        "src/modules/invalid.query.ts": `${imp} export default defineQuery({ input: { parse: x => x }, handler: ctx => ctx.input });`,
      },
      async (rootDir) => {
        await expect(buildRuntime({ rootDir })).rejects.toThrow("DISPATCHKIT_INVALID_SCHEMA");
      },
    );
  });

  it("keeps CQRS restrictions active during validation and unsafe invocation", async () => {
    await withTempProject(
      {
        "src/modules/write.mutation.ts": `${imp} export default defineMutation({ handler: () => "written" });`,
        "src/modules/read.query.ts": `${imp}
const schema = { "~standard": { version: 1, vendor: "custom", validate: async value => {
  await getModuleCtx().bus.mutation.write.$unsafe();
  return { value };
} } };
export default defineQuery({ input: schema, handler: () => "read" });`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        let failure: Error | undefined;
        try {
          await (runtime.bus as any).query.read();
        } catch (error) {
          failure = error as Error;
        }
        expect(failure?.message).toContain("input validation");
        expect(String(failure?.cause)).toContain("DISPATCHKIT_CQRS_GUARD");
        await runtime.dispose();
      },
    );
  });
});
