import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { t } from "elysia-v2";
import { Type } from "typebox";

import { buildRuntime, type BusMethod } from "../../src/index.ts";
import { standardSchema } from "../../src/typebox-v1.ts";
import { dispatchkitImportLine, repoRoot, withTempProject } from "../test-helpers.ts";

describe("Elysia 2 / TypeBox 1 Standard Schema adapter", () => {
  it("validates both plain TypeBox types and Elysia's Numeric/BooleanString/Date codecs", async () => {
    const schema = standardSchema(
      t.Object({
        count: t.Numeric({ minimum: 1 }),
        enabled: t.BooleanString(),
        created: t.Date(),
        tags: Type.Array(Type.String()),
      }),
    );
    const raw = { count: "42", enabled: "true", created: "2026-09-07", tags: ["hello"] };
    const typedInput: StandardSchemaV1.InferInput<typeof schema> = raw;
    const typedOutput: StandardSchemaV1.InferOutput<typeof schema> = {
      count: 42,
      enabled: true,
      created: new Date(),
      tags: [],
    };
    // @ts-expect-error Numeric's encoded input accepts strings and numbers, not booleans.
    const badInput: StandardSchemaV1.InferInput<typeof schema> = { ...raw, count: false };
    // @ts-expect-error Numeric is decoded to a number.
    const badOutput: StandardSchemaV1.InferOutput<typeof schema> = { ...typedOutput, count: "42" };
    void [typedInput, badInput, badOutput];
    expect(await schema["~standard"].validate(raw)).toEqual({
      value: { count: 42, enabled: true, created: new Date("2026-09-07"), tags: ["hello"] },
    });
    expect(raw).toEqual({ count: "42", enabled: "true", created: "2026-09-07", tags: ["hello"] });
    const invalid = await schema["~standard"].validate({ ...raw, count: "0" });
    expect(invalid.issues?.some((issue) => issue.path?.[0] === "count")).toBe(true);
  });

  it("decodes explicit TypeBox codecs and rejects implicit conversions", async () => {
    const schema = standardSchema(
      Type.Object({
        length: Type.Decode(Type.String(), (value) => value.length),
        amount: Type.Number(),
      }),
    );
    expect(await schema["~standard"].validate({ length: "hello", amount: 3 })).toEqual({
      value: { length: 5, amount: 3 },
    });
    expect(
      (await schema["~standard"].validate({ length: "hello", amount: "3" })).issues,
    ).toBeDefined();
    const strict = standardSchema(
      Type.Object({ name: Type.String({ default: "fallback" }) }, { additionalProperties: false }),
    );
    expect((await strict["~standard"].validate({})).issues).toBeDefined();
    expect((await strict["~standard"].validate({ name: "ok", extra: true })).issues).toBeDefined();
  });

  it("supports named references and preserves unusual validation paths", async () => {
    const schema = standardSchema(Type.Ref("Payload"), {
      Payload: Type.Object({ "a/b~c": Type.Number() }),
    });
    expect(await schema["~standard"].validate({ "a/b~c": 2 })).toEqual({ value: { "a/b~c": 2 } });
    const result = await schema["~standard"].validate({ "a/b~c": "bad" });
    expect(result.issues?.[0]?.path).toEqual(["a/b~c"]);
  });

  it("preserves constructor properties and clones frozen data before decoding", async () => {
    const schema = standardSchema(
      Type.Object({
        count: Type.Decode(Type.String(), Number),
        constructor: Type.String(),
      }),
    );
    const input = Object.freeze({ count: "2", constructor: "payload" });
    expect(await schema["~standard"].validate(input)).toEqual({
      value: { count: 2, constructor: "payload" },
    });
    expect(input).toEqual({ count: "2", constructor: "payload" });
  });

  it("propagates codec exceptions instead of reporting unrelated errors as schema issues", () => {
    const failure = new Error("decoder bug");
    const schema = standardSchema(
      Type.Decode(Type.String(), () => {
        throw failure;
      }),
    );
    expect(() => schema["~standard"].validate("ok")).toThrow(failure);
  });

  it("rejects Elysia's deferred file-content refinements, including nested and referenced files", () => {
    const file = t.File({ type: "image/png" });
    for (const schema of [file, t.Object({ files: t.Array(file) })]) {
      expect(() => standardSchema(schema)).toThrow("DISPATCHKIT_TYPEBOX_ASYNC_REFINE_UNSUPPORTED");
    }
    expect(() => standardSchema(Type.Ref("Upload"), { Upload: t.Object({ file }) })).toThrow(
      "DISPATCHKIT_TYPEBOX_ASYNC_REFINE_UNSUPPORTED",
    );
    // Basic Blob/size validation is synchronous and remains supported.
    const sized = standardSchema(t.File({ minSize: 2 }));
    expect(sized["~standard"].validate(new File(["ok"], "file.txt"))).toEqual({
      value: expect.any(File),
    });
  });

  it("uses Elysia 2 schemas in config and operation input/output validation", async () => {
    const adapterImport = JSON.stringify(join(repoRoot, "src/typebox-v1.ts"));
    await withTempProject(
      {
        "src/config.ts": `${dispatchkitImportLine()}\nimport { t } from "elysia-v2";\nimport { standardSchema } from ${adapterImport};\nexport default defineConfig(standardSchema(t.Object({ PORT: t.Numeric() })));`,
        "src/modules/length.query.ts": `${dispatchkitImportLine()}\nimport { t } from "elysia-v2";\nimport { Type } from "typebox";\nimport { standardSchema } from ${adapterImport};\nexport default defineQuery({ input: standardSchema(t.Object({ count: t.Numeric() })), return: standardSchema(Type.Decode(Type.String(), value => value.length)), handler: ({ input }) => "x".repeat(input.count) });`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({
          rootDir,
          config: { PORT: "3000" },
          generateArtifacts: false,
          mountGlobal: false,
        });
        try {
          const length = runtime.bus.query.length as BusMethod<
            { count: string | number },
            number,
            { count: number },
            string
          >;
          expect(runtime.config.PORT).toBe(3000);
          expect(await length({ count: "4" })).toBe(4);
          expect(await length.$unsafe({ count: 2 })).toBe("xx");
          await expect(length({ count: "bad" })).rejects.toThrow("DISPATCHKIT_VALIDATION_ERROR");
        } finally {
          await runtime.dispose();
        }
      },
    );
  });
});
