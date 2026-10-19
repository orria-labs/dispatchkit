import type { StandardSchemaV1 } from "@standard-schema/spec";

export class StandardSchemaError extends Error {
  readonly code = "DISPATCHKIT_SCHEMA_VALIDATION_ERROR";

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

export async function validateSchema<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  input: unknown,
): Promise<StandardSchemaV1.InferOutput<TSchema>> {
  assertStandardSchema(schema);
  const result = await schema["~standard"].validate(input);
  if (result.issues) throw new StandardSchemaError(result.issues);
  return result.value as StandardSchemaV1.InferOutput<TSchema>;
}
