import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { StaticDecode, StaticEncode, TProperties, TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { DecodeUnsafe, HasCodec } from "typebox/value";

function assertSynchronousRefinements(...schemas: unknown[]): void {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function") ||
      seen.has(value)
    )
      return;
    seen.add(value);
    if (typeof value === "function" && Reflect.get(value, "~elyAsyncRefine") === true) {
      throw new Error(
        "DISPATCHKIT_TYPEBOX_ASYNC_REFINE_UNSUPPORTED: This Elysia schema requires its asynchronous file-type validation pipeline. Use an asynchronous Standard Schema validator for file contents instead.",
      );
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ("value" in descriptor) visit(descriptor.value);
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== Array.prototype &&
      prototype !== Function.prototype
    )
      visit(prototype);
  };
  for (const schema of schemas) visit(schema);
}

// Clone data containers without dropping legal own keys such as constructor.
// Opaque class instances remain atomic, as in TypeBox's own Clone operation.
function cloneData(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Date.prototype) return new Date((value as Date).getTime());
  if (prototype === RegExp.prototype) {
    const clone = new RegExp(value as RegExp);
    clone.lastIndex = (value as RegExp).lastIndex;
    return clone;
  }
  if (prototype === ArrayBuffer.prototype) return (value as ArrayBuffer).slice(0);
  if (ArrayBuffer.isView(value)) return structuredClone(value);
  if (prototype === Map.prototype) {
    const clone = new Map();
    seen.set(value, clone);
    for (const [key, item] of value as Map<unknown, unknown>)
      clone.set(cloneData(key, seen), cloneData(item, seen));
    return clone;
  }
  if (prototype === Set.prototype) {
    const clone = new Set();
    seen.set(value, clone);
    for (const item of value as Set<unknown>) clone.add(cloneData(item, seen));
    return clone;
  }
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  const clone = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    Object.defineProperty(
      clone,
      key,
      "value" in descriptor
        ? {
            value: cloneData(descriptor.value, seen),
            enumerable: descriptor.enumerable,
            configurable: true,
            writable: true,
          }
        : descriptor,
    );
  }
  return clone;
}

// TypeBox 1.x error paths do not escape property names containing slashes.
// Resolve against own data properties and omit paths with multiple matches.
function issuePath(value: unknown, path: string): string[] | undefined {
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
      if (rest === "" || "value" in descriptor) visit(descriptor.value, rest, [...keys, key]);
      if (matches.length > 1) return;
    }
  };
  visit(value, path, []);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Adapt TypeBox 1.x schemas, including Elysia 2's t, to Standard Schema.
 * Validates the encoded input and applies explicit codecs without implicit
 * conversion, defaults, or cleaning. Plain data containers are cloned before
 * decoding; opaque class instances and user callbacks retain TypeBox semantics.
 */
export function standardSchema<const T extends TSchema, const C extends TProperties = {}>(
  schema: T,
  context?: C,
): StandardSchemaV1<StaticEncode<T, C>, StaticDecode<T, C>> {
  const references = context ?? {};
  assertSynchronousRefinements(schema, references);
  const compiled = Compile(references, schema);
  const hasCodec = HasCodec(references, schema);
  return {
    "~standard": {
      version: 1,
      vendor: "@orria/dispatchkit/typebox-v1",
      validate(value) {
        if (!compiled.Check(value)) {
          return {
            issues: compiled.Errors(value).map(({ message, instancePath }) => {
              const path = issuePath(value, instancePath);
              return { message, ...(path === undefined ? {} : { path }) };
            }),
          };
        }
        return {
          value: (hasCodec
            ? DecodeUnsafe(references, schema, cloneData(value))
            : value) as StaticDecode<T, C>,
        };
      },
    },
  };
}
