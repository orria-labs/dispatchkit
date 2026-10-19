import type { StandardSchemaV1 } from "@standard-schema/spec";

export type OperationKind = "query" | "mutation" | "action";

export type LoggerLike = {
  fatal?: (...args: unknown[]) => unknown;
  error: (...args: unknown[]) => unknown;
  warn: (...args: unknown[]) => unknown;
  info: (...args: unknown[]) => unknown;
  debug: (...args: unknown[]) => unknown;
  trace?: (...args: unknown[]) => unknown;
  child?: (bindings: Record<string, unknown>) => LoggerLike;
};

export type ConsoleLike = Pick<Console, "log" | "info" | "warn" | "error" | "debug" | "trace">;

export type Schema = StandardSchemaV1;

export type SchemaInput<TSchema, TFallback = unknown> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<TSchema>
  : TFallback;

export type SchemaOutput<TSchema, TFallback = unknown> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : TFallback;

export type BusMethod<
  TInput,
  TReturn,
  TUnsafeInput = TInput,
  TUnsafeReturn = TReturn,
  TInputSchema extends Schema | undefined = Schema | undefined,
  TReturnSchema extends Schema | undefined = Schema | undefined,
> = {
  (...args: undefined extends TInput ? [input?: TInput] : [input: TInput]): Promise<TReturn>;
  $unsafe: (
    ...args: undefined extends TUnsafeInput ? [input?: TUnsafeInput] : [input: TUnsafeInput]
  ) => Promise<TUnsafeReturn>;
  $input: TInputSchema;
  $return: TReturnSchema;
};

export interface BusNamespace {
  [key: string]: BusMethod<any, any> | BusNamespace;
}

export interface RuntimeBusBase {
  query: BusNamespace;
  mutation: BusNamespace;
  action: BusNamespace;
}

type RuntimeShapeFallback = {
  config: Record<string, unknown>;
  logger: LoggerLike;
  infra: Record<string, unknown>;
  transport: Record<string, unknown>;
  bus: RuntimeBusBase;
};

type RuntimeShapeFromGlobal = typeof globalThis extends {
  runtime: infer TRuntime;
}
  ? TRuntime
  : RuntimeShapeFallback;

export type RuntimeConfigShape = RuntimeShapeFromGlobal extends {
  config: infer TConfig;
}
  ? TConfig
  : RuntimeShapeFallback["config"];

export type RuntimeLoggerShape = RuntimeShapeFromGlobal extends {
  logger: infer TLogger;
}
  ? TLogger
  : RuntimeShapeFallback["logger"];

export type RuntimeInfraShape = RuntimeShapeFromGlobal extends {
  infra: infer TInfra;
}
  ? TInfra
  : RuntimeShapeFallback["infra"];

export type RuntimeTransportShape = RuntimeShapeFromGlobal extends {
  transport: infer TTransport;
}
  ? TTransport
  : RuntimeShapeFallback["transport"];

export type RuntimeBus = RuntimeShapeFromGlobal extends {
  bus: infer TBus;
}
  ? TBus
  : RuntimeShapeFallback["bus"];

export interface GeneratedRuntimeTypes {
  config: RuntimeConfigShape;
  logger: RuntimeLoggerShape;
  infra: RuntimeInfraShape;
  transport: RuntimeTransportShape;
  bus: RuntimeBus;
}

export interface ModuleContext<
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
  TLogger = RuntimeLoggerShape,
> {
  config: TConfig;
  logger: TLogger;
  infra: TInfra;
  bus: TBus;
}

export interface RuntimeLifecycleContext {
  onDispose(dispose: () => void | Promise<void>): void;
}

export interface InfraContext<
  TConfig = RuntimeConfigShape,
  TLogger = RuntimeLoggerShape,
> extends RuntimeLifecycleContext {
  config: TConfig;
  logger: TLogger;
}

export interface TransportContext<
  TConfig = RuntimeConfigShape,
  TBus = RuntimeBus,
  TLogger = RuntimeLoggerShape,
> {
  config: TConfig;
  logger: TLogger;
  bus: TBus;
}

export interface TransportFactoryContext<
  TConfig = RuntimeConfigShape,
  TBus = RuntimeBus,
  TLogger = RuntimeLoggerShape,
>
  extends TransportContext<TConfig, TBus, TLogger>, RuntimeLifecycleContext {}

export type ModuleHandlerContext<
  TInput = unknown,
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
  TLogger = RuntimeLoggerShape,
> = ModuleContext<TConfig, TInfra, TBus, TLogger> & {
  input: TInput;
};

export interface OperationDefinition<
  TKind extends OperationKind,
  TInputSchema extends Schema | undefined = undefined,
  TReturnSchema extends Schema | undefined = undefined,
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
  TLogger = RuntimeLoggerShape,
  TResult = SchemaInput<TReturnSchema>,
> {
  readonly __dispatchkitType: "operation";
  readonly kind: TKind;
  readonly input?: TInputSchema;
  readonly return?: TReturnSchema;
  readonly handler: (
    ctx: ModuleHandlerContext<SchemaOutput<TInputSchema>, TConfig, TInfra, TBus, TLogger>,
  ) => TResult | Promise<TResult>;
}

export type OperationInput<T> = T extends { readonly input?: infer TSchema }
  ? SchemaInput<TSchema>
  : never;

export type OperationReturn<T> = T extends {
  readonly return?: infer TSchema;
  readonly handler: (...args: any[]) => infer TResult;
}
  ? SchemaOutput<TSchema, Awaited<TResult>>
  : never;

export type OperationBusMethod<
  T extends {
    readonly input?: Schema;
    readonly return?: Schema;
    readonly handler: (...args: any[]) => any;
  },
> = BusMethod<
  OperationInput<T>,
  OperationReturn<T>,
  Parameters<T["handler"]>[0]["input"],
  Awaited<ReturnType<T["handler"]>>,
  T["input"],
  T["return"]
>;

export interface ConfigDefinition<TSchema extends Schema = Schema> {
  readonly __dispatchkitType: "config";
  readonly schema: TSchema;
}

export interface LoggerDefinition<
  TConfig = RuntimeConfigShape,
  TLogger extends LoggerLike = LoggerLike,
> {
  readonly __dispatchkitType: "logger";
  readonly factory: (config: TConfig) => { logger: TLogger; console: ConsoleLike };
}

export interface InfraDefinition<
  TConfig = RuntimeConfigShape,
  TResult = unknown,
  TLogger = RuntimeLoggerShape,
> {
  readonly __dispatchkitType: "infra";
  readonly factory: (ctx: InfraContext<TConfig, TLogger>) => TResult | Promise<TResult>;
}

export interface TransportDefinition<
  TConfig = RuntimeConfigShape,
  TBus = RuntimeBus,
  TResult = unknown,
  TLogger = RuntimeLoggerShape,
> {
  readonly __dispatchkitType: "transport";
  readonly factory: (
    ctx: TransportFactoryContext<TConfig, TBus, TLogger>,
  ) => TResult | Promise<TResult>;
  readonly options?: TransportDefinitionOptions;
}

export interface TransportDefinitionOptions {
  allowGetTransportCtxFrom?: string[];
}

export type RuntimeDefaultConfig = {
  SERVICE_NAME: string;
  SERVICE_DESCRIPTION: string;
  SERVICE_VERSION: string;
  LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  NODE_ENV: "development" | "production";
};

export interface Runtime<
  TConfig = RuntimeConfigShape,
  TInfra = RuntimeInfraShape,
  TBus = RuntimeBus,
  TTransport = RuntimeTransportShape,
  TLogger = RuntimeLoggerShape,
> {
  config: TConfig;
  logger: TLogger;
  infra: TInfra;
  bus: TBus;
  transport: TTransport;
  dispose(): Promise<void>;
}

export type RuntimeContext = Runtime;

export interface BuildRuntimeOptions {
  rootDir?: string;
  srcDir?: string;
  generatedDir?: string;
  envFile?: string;
  config?: Record<string, unknown>;
  generateArtifacts?: boolean;
  mountGlobal?: boolean;
  [key: string]: unknown;
}

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (
  value: infer R,
) => void
  ? R
  : never;

export type InferInfraModule<T> =
  T extends InfraDefinition<any, any, any> ? Awaited<ReturnType<T["factory"]>> : never;

export type InferTransportModule<T> =
  T extends TransportDefinition<any, any, any, any> ? Awaited<ReturnType<T["factory"]>> : never;

export type InferConfigFromDefinition<T> =
  T extends ConfigDefinition<infer TSchema> ? SchemaOutput<TSchema> : {};

export type InferLoggerFromDefinition<T> =
  T extends LoggerDefinition<any, infer TLogger> ? TLogger : LoggerLike;

export interface DiscoveredOperation {
  kind: OperationKind;
  filePath: string;
  operationName: string;
  operationSegments: string[];
}

export type TransportSource = "transport" | "infra";

export interface DiscoveredTransport {
  key: string;
  filePath: string;
  source: TransportSource;
}

export interface DiscoveryResult {
  operations: DiscoveredOperation[];
  infra: string[];
  transport: DiscoveredTransport[];
  configPath?: string;
  loggerPath?: string;
}
