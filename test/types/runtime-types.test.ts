import { beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type FileMap, repoRoot, runCommand, writeProjectFiles } from "../test-helpers.ts";

function checkedCommand(command: string[], cwd: string): ReturnType<typeof runCommand> {
  const result = runCommand(command, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function withPackagedConsumer(files: FileMap, run: (rootDir: string) => void): Promise<void> {
  const rootDir = mkdtempSync(join(tmpdir(), "dispatchkit-consumer-"));
  try {
    const nodeModules = join(rootDir, "node_modules");
    mkdirSync(nodeModules);
    for (const name of readdirSync(join(repoRoot, "node_modules"))) {
      if (name !== "@orria") {
        symlinkSync(join(repoRoot, "node_modules", name), join(nodeModules, name));
      }
    }
    const packageDir = join(nodeModules, "@orria", "dispatchkit");
    mkdirSync(packageDir, { recursive: true });
    cpSync(join(repoRoot, "package.json"), join(packageDir, "package.json"));
    cpSync(join(repoRoot, "dist"), join(packageDir, "dist"), { recursive: true });
    writeProjectFiles(rootDir, {
      "package.json": JSON.stringify({ name: "dispatchkit-type-consumer", type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          strict: true,
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          skipLibCheck: false,
          types: ["bun"],
        },
        include: ["src/**/*.ts"],
      }),
      ...files,
    });
    checkedCommand(["bun", join(packageDir, "dist", "cli.js"), "generate"], rootDir);
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

const imports = `import { defineAction, defineConfig, defineInfra, defineMutation, defineQuery, defineTransport } from "@orria/dispatchkit";`;

const consumerFiles: FileMap = {
  "src/config.ts": `${imports}
import { z } from "zod";
export default defineConfig(z.object({
  PORT: z.string().transform(Number),
  HOST: z.string(),
}));`,
  "src/infra/db.ts": `${imports}
export default defineInfra(({ config, onDispose }) => {
  const port: number = config.PORT;
  onDispose(async () => {});
  return { get: () => ({ id: "1", port }) };
});`,
  "src/transport/http.ts": `${imports}
class Server {
  listen(options: { hostname: string; port: number }) { return options; }
}
export default defineTransport(({ config, onDispose }) => {
  const port: number = config.PORT;
  onDispose(() => {});
  return new Server();
});`,
  "src/modules/transformed.query.ts": `${imports}
import { z } from "zod";
export default defineQuery({
  input: z.string().transform(value => value.length),
  return: z.string().transform(value => value.length),
  handler: ({ input, config, infra }) => {
    const length: number = input;
    const port: number = config.PORT;
    const id: string = infra.db.get().id;
    // @ts-expect-error The handler receives the transformed number.
    const text: string = input;
    return String(length + port + id.length);
  },
});`,
  "src/modules/inferred.query.ts": `${imports}
export default defineQuery({
  handler: ({ infra }) => ({ id: infra.db.get().id, count: 1 }),
});`,
  "src/modules/recursive.query.ts": `${imports}
import { z } from "zod";
export default defineQuery({
  input: z.number(),
  return: z.number(),
  handler: ({ input, bus }): number | Promise<number> => input > 0 ? bus.query.recursive(input - 1) : 0,
});`,
  "src/modules/nested.query.ts": `${imports}
export default defineQuery({ handler: async ({ bus }) => {
  const other = await bus.query.inferred();
  const id: string = other.id;
  // @ts-expect-error Nested bus calls retain the other handler's inferred result.
  const wrong: number = other.id;
  return { id, count: other.count };
} });`,
  "src/modules/async.mutation.ts": `${imports}
export default defineMutation({ handler: async () => ({ saved: true }) });`,
  "src/modules/notify.action.ts": `${imports}
export default defineAction({ handler: () => "sent" });`,
  "src/modules/valibot.query.ts": `${imports}
import * as v from "valibot";
export default defineQuery({
  input: v.pipe(v.string(), v.transform(value => value.length)),
  return: v.pipe(v.string(), v.transform(value => value.length)),
  handler: ({ input }) => {
    const length: number = input;
    return String(length);
  },
});`,
  "src/modules/typebox.query.ts": `${imports}
import { Type } from "@sinclair/typebox";
import { standardSchema } from "@orria/dispatchkit/typebox";
const schema = standardSchema(Type.Transform(Type.String()).Decode(Number).Encode(String));
export default defineQuery({ input: schema, return: schema, handler: ({ input }) => {
  const value: number = input;
  return String(value);
} });`,
  "src/modules/typeboxone.query.ts": `${imports}
import { Type } from "typebox";
import { standardSchema } from "@orria/dispatchkit/typebox-v1";
const schema = standardSchema(Type.Decode(Type.String(), value => value.length));
export default defineQuery({ input: schema, return: schema, handler: ({ input }) => {
  const length: number = input;
  // @ts-expect-error TypeBox 1 codecs decode handler input.
  const raw: string = input;
  return String(length);
} });`,
  "src/modules/typeboxref.query.ts": `${imports}
import { Type } from "typebox";
import { standardSchema } from "@orria/dispatchkit/typebox-v1";
const schema = standardSchema(Type.Ref("Payload"), {
  Payload: Type.Object({ count: Type.Decode(Type.String(), value => value.length) }),
});
export default defineQuery({ input: schema, return: schema, handler: ({ input }) => {
  const length: number = input.count;
  return { count: String(length) };
} });`,
  "src/modules/custom.query.ts": `${imports}
import type { StandardSchemaV1 } from "@standard-schema/spec";
const schema: StandardSchemaV1<string, number> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: async value => typeof value === "string"
      ? { value: value.length }
      : { issues: [{ message: "Expected a string" }] },
  },
};
export default defineQuery({ input: schema, return: schema, handler: ({ input }) => String(input) });`,
  "src/main.ts": `import { buildRuntime, defineQuery } from "@orria/dispatchkit";
import { z } from "zod";
const runtime = await buildRuntime();
runtime.transport.http.listen({ hostname: "0.0.0.0", port: runtime.config.PORT });
const host: string = runtime.config.HOST;
const port: number = runtime.config.PORT;
const id: string = runtime.infra.db.get().id;
const transformed: number = await runtime.bus.query.transformed("hello");
const unsafe: string = await runtime.bus.query.transformed.$unsafe(5);
const inputSchema: z.ZodPipe<z.ZodString, z.ZodTransform<number, string>> | undefined = runtime.bus.query.transformed.$input;
const inferred: { id: string; count: number } = await runtime.bus.query.inferred();
const recursive: number = await runtime.bus.query.recursive(2);
const nested: { id: string; count: number } = await runtime.bus.query.nested();
const unsafeInferred: { id: string; count: number } = await runtime.bus.query.inferred.$unsafe();
const saved: boolean = (await runtime.bus.mutation.async(undefined)).saved;
const sent: string = await runtime.bus.action.notify(undefined);
const valibot: number = await runtime.bus.query.valibot("test");
const valibotUnsafe: string = await runtime.bus.query.valibot.$unsafe(4);
const typebox: number = await runtime.bus.query.typebox("123");
const typeboxUnsafe: string = await runtime.bus.query.typebox.$unsafe(123);
const typeboxone: number = await runtime.bus.query.typeboxone("123");
const typeboxoneUnsafe: string = await runtime.bus.query.typeboxone.$unsafe(123);
const typeboxref: { count: number } = await runtime.bus.query.typeboxref({ count: "123" });
const typeboxrefUnsafe: { count: string } = await runtime.bus.query.typeboxref.$unsafe({ count: 123 });
const custom: number = await runtime.bus.query.custom("test");
const customUnsafe: string = await runtime.bus.query.custom.$unsafe(4);
await runtime.dispose();
await globalThis.runtime.dispose();
// @ts-expect-error Config parsing returns a number.
const wrongPort: string = runtime.config.PORT;
// @ts-expect-error A required input schema still requires an argument.
await runtime.bus.query.transformed();
// @ts-expect-error The bus accepts schema input before its transform.
await runtime.bus.query.transformed(5);
// @ts-expect-error The unsafe method accepts the handler's input after the input transform.
await runtime.bus.query.transformed.$unsafe("hello");
// @ts-expect-error The unsafe method returns the handler result before the return transform.
const wrongUnsafe: number = await runtime.bus.query.transformed.$unsafe(5);
// @ts-expect-error Schemaless results retain their inferred types.
const wrongInferred: number = (await runtime.bus.query.inferred()).id;
// @ts-expect-error The generated config contains only declared/default keys.
const missing = runtime.config.NOT_A_CONFIG_KEY;
// @ts-expect-error Valibot also distinguishes schema input and output.
await runtime.bus.query.valibot(4);
// @ts-expect-error The TypeBox adapter preserves the encoded input type.
await runtime.bus.query.typebox(123);
// @ts-expect-error TypeBox 1 retains encoded string inputs.
await runtime.bus.query.typeboxone(123);
// @ts-expect-error TypeBox 1 unsafe returns the raw handler value.
const wrongTypeboxOneUnsafe: number = await runtime.bus.query.typeboxone.$unsafe(123);
// @ts-expect-error TypeBox 1 references resolve encoded property types.
await runtime.bus.query.typeboxref({ count: 123 });
// @ts-expect-error TypeBox 1 references resolve decoded handler inputs.
await runtime.bus.query.typeboxref.$unsafe({ count: "123" });
// @ts-expect-error Return handlers supply the return schema's input.
defineQuery({ return: z.string().transform(value => value.length), handler: () => 1 });
// @ts-expect-error A parse method without the Standard Schema protocol is unsupported.
defineQuery({ input: { parse: (value: string) => value }, handler: () => 1 });`,
};

describe("packaged consumer types", () => {
  beforeAll(() => {
    checkedCommand(["bun", "run", "build"], repoRoot);
  }, 30_000);

  it("preserves generated config, infra, transport and Standard Schema boundaries", async () => {
    await withPackagedConsumer(consumerFiles, (rootDir) => {
      const result = checkedCommand(
        ["bun", "x", "tsc", "-p", "tsconfig.json", "--noEmit"],
        rootDir,
      );
      expect(result.exitCode).toBe(0);
    });
  }, 30_000);

  it("preserves Elysia 2 codec input/output in the packaged adapter", async () => {
    await withPackagedConsumer(
      {
        "src/config.ts": `${imports}
import { t } from "elysia-v2";
import { standardSchema } from "@orria/dispatchkit/typebox-v1";
export default defineConfig(standardSchema(t.Object({ PORT: t.Numeric() })));`,
        "src/modules/numeric.query.ts": `${imports}
import { t } from "elysia-v2";
import { standardSchema } from "@orria/dispatchkit/typebox-v1";
export default defineQuery({
  input: standardSchema(t.Object({ count: t.Numeric() })),
  return: standardSchema(t.Decode(t.String(), value => value.length)),
  handler: ({ input, config }) => {
    const count: number = input.count;
    const port: number = config.PORT;
    // @ts-expect-error Elysia 2 Numeric produces a number in handlers.
    const raw: string = input.count;
    return String(count + port);
  },
});`,
        "src/main.ts": `import { buildRuntime } from "@orria/dispatchkit";
const runtime = await buildRuntime();
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Assert<T extends true> = T;
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Method = typeof runtime.bus.query.numeric;
type NoAnyInput = Assert<Same<IsAny<Parameters<Method>[0]>, false>>;
type ExactInput = Assert<Same<Parameters<Method>[0], { count: string | number }>>;
type ExactOutput = Assert<Same<Awaited<ReturnType<Method>>, number>>;
type ExactUnsafeInput = Assert<Same<Parameters<Method["$unsafe"]>[0], { count: number }>>;
type ExactUnsafeOutput = Assert<Same<Awaited<ReturnType<Method["$unsafe"]>>, string>>;
const port: number = runtime.config.PORT;
const output: number = await runtime.bus.query.numeric({ count: "123" });
const numberInput: number = await runtime.bus.query.numeric({ count: 123 });
const unsafe: string = await runtime.bus.query.numeric.$unsafe({ count: 123 });
// @ts-expect-error Numeric's encoded input does not include booleans.
await runtime.bus.query.numeric({ count: true });
// @ts-expect-error Unsafe calls accept Numeric's decoded input.
await runtime.bus.query.numeric.$unsafe({ count: "123" });
// @ts-expect-error The raw string handler return has not been decoded in unsafe calls.
const wrongUnsafe: number = await runtime.bus.query.numeric.$unsafe({ count: 123 });
// @ts-expect-error Config Numeric is decoded to a number.
const wrongPort: string = runtime.config.PORT;`,
      },
      (rootDir) => {
        // Elysia 2 beta has unrelated errors in its HTTP/macro declarations.
        // Core and both adapters are checked with skipLibCheck=false above;
        // this integration also asserts exact types and rejects any leakage.
        const result = checkedCommand(
          ["bun", "x", "tsc", "-p", "tsconfig.json", "--noEmit", "--skipLibCheck"],
          rootDir,
        );
        expect(result.exitCode).toBe(0);
      },
    );
  }, 30_000);

  it("rejects a bad consumer assignment without suppression", async () => {
    await withPackagedConsumer(
      {
        "src/config.ts": consumerFiles["src/config.ts"]!,
        "src/main.ts": `import { buildRuntime } from "@orria/dispatchkit";
const runtime = await buildRuntime();
const invalidPort: string = runtime.config.PORT;`,
      },
      (rootDir) => {
        const result = runCommand(["bun", "x", "tsc", "-p", "tsconfig.json", "--noEmit"], rootDir);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toContain("Type 'number' is not assignable to type 'string'");
        expect(result.stdout).not.toContain("Cannot find module");
      },
    );
  }, 30_000);
});
