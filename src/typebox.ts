import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { StaticDecode, StaticEncode, TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { TransformDecodeCheckError, TransformDecodeError } from "@sinclair/typebox/value";

function issuePath(pointer: string): string[] {
  return pointer === ""
    ? []
    : pointer.slice(1).split("/").map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
}

// TypeBox 0.34 escapes validation pointers, but leaves Decode error paths raw.
// Resolve those against own data properties; omit ambiguous paths rather than
// point at the wrong field. Reading descriptors avoids invoking getters again.
function decodeIssuePath(value: unknown, path: string): string[] | undefined {
  const matches: string[][] = [];
  const visit = (current: unknown, remaining: string, keys: string[]): void => {
    if (remaining === "") {
      matches.push(keys);
      return;
    }
    if (typeof current !== "object" || current === null) return;

    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
      const prefix = `/${key}`;
      if (remaining !== prefix && !remaining.startsWith(`${prefix}/`)) continue;
      const rest = remaining.slice(prefix.length);
      if (rest === "" || "value" in descriptor) {
        visit(descriptor.value, rest, [...keys, key]);
      }
      if (matches.length > 1) return;
    }
  };
  visit(value, path, []);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Adapt a TypeBox 0.34 schema (including Elysia's `t`) to Standard Schema.
 * Compiles once and preserves TypeBox's validation and synchronous Decode semantics.
 * Elysia's HTTP coercion/default/cleaning pipeline is not applied.
 */
export function standardSchema<T extends TSchema>(
  schema: T,
  references: readonly TSchema[] = [],
): StandardSchemaV1<StaticEncode<T>, StaticDecode<T>> {
  const compiled = TypeCompiler.Compile(schema, [...references]);

  return {
    "~standard": {
      version: 1,
      vendor: "@orria/dispatchkit/typebox",
      validate(value) {
        try {
          return { value: compiled.Decode(value) };
        } catch (error) {
          if (error instanceof TransformDecodeCheckError) {
            return {
              issues: [...compiled.Errors(value)].map(({ message, path }) => ({
                message,
                path: issuePath(path),
              })),
            };
          }

          if (error instanceof TransformDecodeError) {
            const path = decodeIssuePath(value, error.path);
            return {
              issues: [{ message: error.message, ...(path === undefined ? {} : { path }) }],
            };
          }

          throw error;
        }
      },
    },
  };
}
