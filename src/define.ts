import type {
  ConfigDefinition,
  InfraDefinition,
  LoggerDefinition,
  LoggerLike,
  OperationDefinition,
  OperationKind,
  RuntimeBus,
  RuntimeConfigShape,
  RuntimeInfraShape,
  RuntimeLoggerShape,
  Schema,
  SchemaInput,
  TransportDefinition,
} from "./types.ts";

type DefineOperationOptions<
  TInput extends Schema | undefined,
  TReturn extends Schema | undefined,
  TConfig,
  TInfra,
  TBus,
  TKind extends OperationKind,
  TResult,
> = {
  input?: TInput;
  return?: TReturn;
  handler: OperationDefinition<TKind, TInput, TReturn, TConfig, TInfra, TBus, RuntimeLoggerShape, TResult>["handler"];
};

function defineOperation<
  TKind extends OperationKind,
  TInput extends Schema | undefined = undefined,
  TReturn extends Schema | undefined = undefined,
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
  TResult extends SchemaInput<TReturn> = SchemaInput<TReturn>,
>(
  kind: TKind,
  options: DefineOperationOptions<TInput, TReturn, TConfig, TInfra, TBus, TKind, TResult>,
): OperationDefinition<TKind, TInput, TReturn, TConfig, TInfra, TBus, RuntimeLoggerShape, TResult> {
  return {
    __dispatchkitType: "operation",
    kind,
    input: options.input,
    return: options.return,
    handler: options.handler,
  };
}

export function defineQuery<
  TInput extends Schema | undefined = undefined,
  TReturn extends Schema | undefined = undefined,
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
  TResult extends SchemaInput<TReturn> = SchemaInput<TReturn>,
>(
  options: DefineOperationOptions<TInput, TReturn, TConfig, TInfra, TBus, "query", TResult>,
): OperationDefinition<"query", TInput, TReturn, TConfig, TInfra, TBus, RuntimeLoggerShape, TResult> {
  return defineOperation("query", options);
}

export function defineMutation<
  TInput extends Schema | undefined = undefined,
  TReturn extends Schema | undefined = undefined,
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
  TResult extends SchemaInput<TReturn> = SchemaInput<TReturn>,
>(
  options: DefineOperationOptions<TInput, TReturn, TConfig, TInfra, TBus, "mutation", TResult>,
): OperationDefinition<"mutation", TInput, TReturn, TConfig, TInfra, TBus, RuntimeLoggerShape, TResult> {
  return defineOperation("mutation", options);
}

export function defineAction<
  TInput extends Schema | undefined = undefined,
  TReturn extends Schema | undefined = undefined,
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
  TResult extends SchemaInput<TReturn> = SchemaInput<TReturn>,
>(
  options: DefineOperationOptions<TInput, TReturn, TConfig, TInfra, TBus, "action", TResult>,
): OperationDefinition<"action", TInput, TReturn, TConfig, TInfra, TBus, RuntimeLoggerShape, TResult> {
  return defineOperation("action", options);
}

export function defineConfig<TSchema extends Schema>(
  schema: TSchema,
): ConfigDefinition<TSchema> {
  return {
    __dispatchkitType: "config",
    schema,
  };
}

export function defineLogger<
  TConfig = RuntimeConfigShape,
  TLogger extends LoggerLike = LoggerLike,
>(
  factory: LoggerDefinition<TConfig, TLogger>["factory"],
): LoggerDefinition<TConfig, TLogger> {
  return {
    __dispatchkitType: "logger",
    factory,
  };
}

export function defineInfra<
  TConfig = RuntimeConfigShape,
  TResult = unknown,
>(
  factory: InfraDefinition<TConfig, TResult>["factory"],
): InfraDefinition<TConfig, TResult> {
  return {
    __dispatchkitType: "infra",
    factory,
  };
}

export function defineTransport<
  TConfig = RuntimeConfigShape,
  TBus = RuntimeBus,
  TResult = unknown,
>(
  factory: TransportDefinition<TConfig, TBus, TResult>["factory"],
  options?: TransportDefinition<TConfig, TBus, TResult>["options"],
): TransportDefinition<TConfig, TBus, TResult> {
  return {
    __dispatchkitType: "transport",
    factory,
    options,
  };
}
