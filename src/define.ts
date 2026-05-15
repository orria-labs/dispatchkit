import type { z } from "zod";
import type {
  ConfigDefinition,
  InfraDefinition,
  LoggerDefinition,
  OperationDefinition,
  OperationKind,
  RuntimeBus,
  RuntimeBusBase,
  RuntimeConfigShape,
  RuntimeInfraShape,
  TransportDefinition,
} from "./types.ts";

type DefineOperationOptions<
  TInput extends z.ZodTypeAny | undefined,
  TReturn extends z.ZodTypeAny | undefined,
  TConfig,
  TInfra,
  TBus,
  TKind extends OperationKind,
> = {
  input?: TInput;
  return?: TReturn;
  handler: OperationDefinition<TKind, TInput, TReturn, TConfig, TInfra, TBus>["handler"];
};

function defineOperation<
  TKind extends OperationKind,
  TInput extends z.ZodTypeAny | undefined = undefined,
  TReturn extends z.ZodTypeAny | undefined = undefined,
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
>(
  kind: TKind,
  options: DefineOperationOptions<TInput, TReturn, TConfig, TInfra, TBus, TKind>,
): OperationDefinition<TKind, TInput, TReturn, TConfig, TInfra, TBus> {
  return {
    __dispatchkitType: "operation",
    kind,
    input: options.input,
    return: options.return,
    handler: options.handler,
  };
}

export function defineQuery<
  TInput extends z.ZodTypeAny | undefined = undefined,
  TReturn extends z.ZodTypeAny | undefined = undefined,
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
>(
  options: DefineOperationOptions<TInput, TReturn, TConfig, TInfra, TBus, "query">,
): OperationDefinition<"query", TInput, TReturn, TConfig, TInfra, TBus> {
  return defineOperation("query", options);
}

export function defineMutation<
  TInput extends z.ZodTypeAny | undefined = undefined,
  TReturn extends z.ZodTypeAny | undefined = undefined,
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
>(
  options: DefineOperationOptions<TInput, TReturn, TConfig, TInfra, TBus, "mutation">,
): OperationDefinition<"mutation", TInput, TReturn, TConfig, TInfra, TBus> {
  return defineOperation("mutation", options);
}

export function defineAction<
  TInput extends z.ZodTypeAny | undefined = undefined,
  TReturn extends z.ZodTypeAny | undefined = undefined,
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
>(
  options: DefineOperationOptions<TInput, TReturn, TConfig, TInfra, TBus, "action">,
): OperationDefinition<"action", TInput, TReturn, TConfig, TInfra, TBus> {
  return defineOperation("action", options);
}

export function defineConfig<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
): ConfigDefinition<TSchema> {
  return {
    __dispatchkitType: "config",
    schema,
  };
}

export function defineLogger<TConfig = RuntimeConfigShape>(
  factory: LoggerDefinition<TConfig>["factory"],
): LoggerDefinition<TConfig> {
  return {
    __dispatchkitType: "logger",
    factory,
  };
}

export function defineInfra<
  TConfig = RuntimeConfigShape,
  TResult = RuntimeInfraShape,
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
  TBus = RuntimeBusBase,
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
