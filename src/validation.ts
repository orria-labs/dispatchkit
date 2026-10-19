import type { StandardSchemaV1 } from "@standard-schema/spec";

import { DispatchkitError } from "./errors.ts";

export class StandardSchemaError extends DispatchkitError {
  override readonly code = "DISPATCHKIT_SCHEMA_VALIDATION_ERROR";

  constructor(readonly issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(issues.map((issue) => issue.message).join("; ") || "Schema validation failed");
    this.name = "StandardSchemaError";
  }
}

export function assertStandardSchema(schema: unknown): asserts schema is StandardSchemaV1 {
  const standard =
    schema && (typeof schema === "object" || typeof schema === "function")
      ? (schema as StandardSchemaV1)["~standard"]
      : undefined;
  if (
    standard?.version !== 1 ||
    typeof standard.vendor !== "string" ||
    typeof standard.validate !== "function"
  ) {
    throw new TypeError("DISPATCHKIT_INVALID_SCHEMA: Expected a Standard Schema v1 validator");
  }
}

/**
 * Validates and stays synchronous when the validator is synchronous (no extra microtasks on the
 * bus hot path). Issues become a `StandardSchemaError`; validator exceptions propagate as-is.
 * The schema must already be checked with `assertStandardSchema`.
 */
export function runSchema(schema: StandardSchemaV1, input: unknown): unknown {
  const result = schema["~standard"].validate(input);
  if (result instanceof Promise) {
    return result.then((settled) => {
      if (settled.issues) throw new StandardSchemaError(settled.issues);
      return settled.value;
    });
  }
  if (result.issues) throw new StandardSchemaError(result.issues);
  return result.value;
}

export async function validateSchema<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  input: unknown,
): Promise<StandardSchemaV1.InferOutput<TSchema>> {
  assertStandardSchema(schema);
  const result = await schema["~standard"].validate(input);
  if (result.issues) throw new StandardSchemaError(result.issues);
  return result.value;
}

const TYPED_VENDOR = "@orria/dispatchkit/typed";

const typedSchema: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: TYPED_VENDOR, validate: (value) => ({ value }) },
};

/**
 * Type-only schema: gives `input`, `return` or config a TypeScript type without runtime
 * validation (the bus skips it entirely).
 *
 * @example defineQuery({ input: typed<{ id: string }>(), handler: ({ input }) => input.id })
 */
export function typed<TInput, TOutput = TInput>(): StandardSchemaV1<TInput, TOutput> {
  return typedSchema as StandardSchemaV1<TInput, TOutput>;
}

export function isTypedSchema(schema: StandardSchemaV1 | undefined): boolean {
  return schema?.["~standard"].vendor === TYPED_VENDOR;
}
