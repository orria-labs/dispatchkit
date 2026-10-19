/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- runtime.bus/transport are untyped here: these tests do not load generated types */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { t } from "elysia";

import { buildRuntime } from "../../src/index.ts";
import { standardSchema } from "../../src/typebox.ts";
import { dispatchkitImportLine, repoRoot, withTempProject } from "../test-helpers.ts";

describe("TypeBox Standard Schema adapter", () => {
  it("preserves transformed input/output types and decoded values", async () => {
    const schema = standardSchema(
      Type.Object({
        count: Type.Transform(Type.String()).Decode(Number).Encode(String),
      }),
    );
    const input: StandardSchemaV1.InferInput<typeof schema> = { count: "12" };
    const output: StandardSchemaV1.InferOutput<typeof schema> = { count: 12 };
    // @ts-expect-error The encoded input is a string.
    const invalidInput: StandardSchemaV1.InferInput<typeof schema> = { count: 12 };
    // @ts-expect-error The decoded output is a number.
    const invalidOutput: StandardSchemaV1.InferOutput<typeof schema> = { count: "12" };

    expect(await schema["~standard"].validate(input)).toEqual({ value: output });
    expect(input).toEqual({ count: "12" });
    expect((await schema["~standard"].validate(invalidInput)).issues).toBeDefined();
    void invalidOutput;
  });

  it("returns all validation issues with decoded JSON pointer paths", async () => {
    const schema = standardSchema(
      Type.Object({
        "a/b": Type.Object({ "~name": Type.String() }),
        count: Type.Number(),
      }),
    );
    const result = await schema["~standard"].validate({ "a/b": { "~name": 1 }, count: "2" });

    expect(result.issues?.map(({ path }) => path)).toEqual([["a/b", "~name"], ["count"]]);
  });

  it("supports external references", async () => {
    const item = Type.Object({ id: Type.String() }, { $id: "Item" });
    const schema = standardSchema(Type.Array(Type.Ref(item)), [item]);

    expect(await schema["~standard"].validate([{ id: "one" }])).toEqual({ value: [{ id: "one" }] });
    expect((await schema["~standard"].validate([{ id: 1 }])).issues?.[0]?.path).toEqual([
      "0",
      "id",
    ]);
  });

  it("reports errors raised by a Decode transform", async () => {
    const schema = standardSchema(
      Type.Object({
        value: Type.Transform(Type.String())
          .Decode((value) => {
            if (value === "invalid") throw new Error("Cannot decode this value");
            return value.length;
          })
          .Encode(String),
      }),
    );

    expect(await schema["~standard"].validate({ value: "invalid" })).toEqual({
      issues: [{ message: "Cannot decode this value", path: ["value"] }],
    });
  });

  it("preserves raw Decode paths for keys containing slashes and tildes", async () => {
    const failing = Type.Transform(Type.String())
      .Decode(() => {
        throw new Error("Cannot decode this value");
      })
      .Encode(String);
    const schema = standardSchema(Type.Object({ "a/b": Type.Object({ "~1": failing }) }));

    expect(await schema["~standard"].validate({ "a/b": { "~1": "value" } })).toEqual({
      issues: [{ message: "Cannot decode this value", path: ["a/b", "~1"] }],
    });
  });

  it("supports Elysia objects, registered formats and Numeric transforms", async () => {
    const schema = standardSchema(
      t.Object({
        email: t.String({ format: "email" }),
        count: t.Numeric({ minimum: 2 }),
      }),
    );

    expect(await schema["~standard"].validate({ email: "a@example.com", count: "3" })).toEqual({
      value: { email: "a@example.com", count: 3 },
    });
    expect(
      (await schema["~standard"].validate({ email: "invalid", count: "3" })).issues,
    ).toBeDefined();
    expect(
      (await schema["~standard"].validate({ email: "a@example.com", count: "1" })).issues?.[0]
        ?.path,
    ).toEqual(["count"]);
  });

  it("uses adapted schemas for runtime config, operation input and return", async () => {
    const imports = `${dispatchkitImportLine()}
import { t } from "elysia";
import { Type } from "@sinclair/typebox";
import { standardSchema } from ${JSON.stringify(join(repoRoot, "src", "typebox.ts"))};`;
    await withTempProject(
      {
        "src/config.ts": `${imports}
export default defineConfig(standardSchema(t.Object({ PORT: t.Numeric() })));`,
        ".env": "PORT=3001",
        "src/modules/convert.query.ts": `${imports}
export default defineQuery({
  input: standardSchema(t.Object({ count: t.Numeric() })),
  return: standardSchema(Type.Transform(Type.String()).Decode(Number).Encode(String)),
  handler: ({ input, config }) => String(input.count + config.PORT),
});`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
        const bus = runtime.bus as any;

        expect(runtime.config.PORT).toBe(3001);
        await expect(bus.query.convert({ count: "4" })).resolves.toBe(3005);
        await expect(bus.query.convert({ count: "invalid" })).rejects.toThrow("input validation");
      },
    );
  });
});
