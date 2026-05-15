import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import {
  discoverRuntimeFiles,
  resolveTransportKey,
  toSourceFileFromRelative,
} from "./discovery.ts";
import { generateArtifacts } from "./typegen.ts";
import type {
  BuildRuntimeOptions,
  BusMethod,
  BusNamespace,
  ConfigDefinition,
  ConsoleLike,
  DiscoveryResult,
  InfraContext,
  InfraDefinition,
  LoggerDefinition,
  LoggerLike,
  ModuleContext,
  OperationDefinition,
  OperationKind,
  Runtime,
  RuntimeBus,
  RuntimeBusBase,
  RuntimeDefaultConfig,
  TransportContext,
  TransportDefinition,
  TransportDefinitionOptions,
  TransportSource,
} from "./types.ts";

type RuntimeConfig = RuntimeDefaultConfig & Record<string, unknown>;
type InternalRuntime = Runtime<
  RuntimeConfig,
  Record<string, unknown>,
  RuntimeBusBase,
  Record<string, unknown>
>;

type CallFrame = {
  kind: OperationKind;
  name: string;
};

type LoadedOperation = {
  kind: OperationKind;
  name: string;
  segments: string[];
  filePath: string;
  definition: OperationDefinition<
    OperationKind,
    any,
    any,
    RuntimeConfig,
    Record<string, unknown>,
    RuntimeBusBase
  >;
};

type TransportCtxAccessGuard = {
  srcDir: string;
  patterns: string[];
  globs: Bun.Glob[];
};

type TransportCtxModuleRef = {
  key: string;
  filePath: string;
  source: TransportSource;
};

const moduleContextStorage = new AsyncLocalStorage<
  ModuleContext<RuntimeConfig, Record<string, unknown>, RuntimeBusBase>
>();
const transportContextStorage = new AsyncLocalStorage<
  TransportContext<RuntimeConfig, RuntimeBusBase>
>();
const transportCtxAccessGuardStorage = new AsyncLocalStorage<
  TransportCtxAccessGuard | undefined
>();
const callFrameStorage = new AsyncLocalStorage<CallFrame[]>();
const RUNTIME_GLOBAL_STATE_KEY = Symbol.for(
  "dispatchkit.runtime.globalState.v1",
);

type RuntimeGlobalState = {
  moduleContextStorage: typeof moduleContextStorage;
  transportContextStorage: typeof transportContextStorage;
  transportCtxAccessGuardStorage: typeof transportCtxAccessGuardStorage;
  callFrameStorage: typeof callFrameStorage;
  activeRuntime: InternalRuntime | undefined;
  activeTransportCtxAccessGuard: TransportCtxAccessGuard | undefined;
};

function getRuntimeGlobalState(): RuntimeGlobalState {
  const globalState = globalThis as typeof globalThis & {
    [RUNTIME_GLOBAL_STATE_KEY]?: RuntimeGlobalState;
  };

  if (!globalState[RUNTIME_GLOBAL_STATE_KEY]) {
    globalState[RUNTIME_GLOBAL_STATE_KEY] = {
      moduleContextStorage,
      transportContextStorage,
      transportCtxAccessGuardStorage,
      callFrameStorage,
      activeRuntime: undefined,
      activeTransportCtxAccessGuard: undefined,
    };
  }

  return globalState[RUNTIME_GLOBAL_STATE_KEY];
}

const runtimeGlobalState = getRuntimeGlobalState();

const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const LOG_LEVEL_INDEX = LOG_LEVELS.reduce<Record<LogLevel, number>>(
  (acc, level, index) => {
    acc[level] = index;
    return acc;
  },
  {} as Record<LogLevel, number>,
);

const RuntimeSchema = z.object({
  SERVICE_NAME: z.string(),
  SERVICE_DESCRIPTION: z.string(),
  SERVICE_VERSION: z.string(),
  LOG_LEVEL: z.enum(LOG_LEVELS),
  NODE_ENV: z.enum(["development", "production"]),
});

const RESERVED_RUNTIME_OPTION_KEYS = new Set([
  "rootDir",
  "srcDir",
  "generatedDir",
  "envFile",
  "config",
]);

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

const RUNTIME_FILE_PATH = normalizeSeparators(fileURLToPath(import.meta.url));

function normalizeTransportCtxAllowPattern(pattern: string): string {
  let normalized = normalizeSeparators(pattern.trim());
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("~/")) {
    normalized = normalized.slice(2);
  }

  if (normalized.startsWith("src/")) {
    normalized = normalized.slice(4);
  }

  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

function hasGlobMagic(value: string): boolean {
  return /[*?[\]{}()!+@]/.test(value);
}

function buildDefaultTransportCtxPatterns(
  module: TransportCtxModuleRef,
): string[] {
  const layerDir = module.source === "infra" ? "infra" : "transport";
  const normalizedFilePath = normalizeSeparators(module.filePath);
  return [`${layerDir}/${normalizedFilePath}`];
}

function expandTransportCtxAllowPatterns(options: {
  patterns: string[];
}): string[] {
  const expanded: string[] = [];

  for (const rawPattern of options.patterns) {
    const normalized = normalizeTransportCtxAllowPattern(rawPattern);
    if (!normalized) {
      continue;
    }

    expanded.push(normalized);

    const isShorthand =
      !normalized.includes("/") &&
      !normalized.endsWith(".ts") &&
      !hasGlobMagic(normalized);

    if (isShorthand) {
      expanded.push(`${normalized}.ts`);
      expanded.push(`${normalized}/**/*.ts`);
      expanded.push(`transport/${normalized}.ts`);
      expanded.push(`transport/${normalized}/**/*.ts`);
      expanded.push(`infra/${normalized}.ts`);
      expanded.push(`infra/${normalized}/**/*.ts`);
    }
  }

  return expanded;
}

function buildTransportCtxAccessGuard(options: {
  srcDir: string;
  patterns: string[];
}): TransportCtxAccessGuard | undefined {
  const seen = new Set<string>();
  const normalizedPatterns: string[] = [];

  for (const rawPattern of options.patterns) {
    const normalized = normalizeTransportCtxAllowPattern(rawPattern);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedPatterns.push(normalized);
  }

  if (normalizedPatterns.length === 0) {
    return undefined;
  }

  return {
    srcDir: resolve(options.srcDir),
    patterns: normalizedPatterns,
    globs: normalizedPatterns.map((pattern) => new Bun.Glob(pattern)),
  };
}

function resolveCallerFilePath(
  skipper: (...args: unknown[]) => unknown,
): string | undefined {
  if (typeof Error.captureStackTrace !== "function") {
    return undefined;
  }

  const previousPrepareStackTrace = Error.prepareStackTrace;

  try {
    Error.prepareStackTrace = (_, stack) => stack;
    const error = new Error();
    Error.captureStackTrace(error, skipper);
    const frames = error.stack as unknown as NodeJS.CallSite[];

    for (const frame of frames) {
      const rawFilePath = frame.getFileName();
      if (!rawFilePath || rawFilePath.startsWith("node:")) {
        continue;
      }

      const filePath = rawFilePath.startsWith("file://")
        ? fileURLToPath(rawFilePath)
        : rawFilePath;
      const normalized = normalizeSeparators(filePath);
      if (normalized === RUNTIME_FILE_PATH) {
        continue;
      }

      return filePath;
    }
  } catch {
    return undefined;
  } finally {
    Error.prepareStackTrace = previousPrepareStackTrace;
  }

  return undefined;
}

function isTransportCtxCallAllowed(options: {
  guard: TransportCtxAccessGuard;
  callerFilePath: string | undefined;
}): boolean {
  if (!options.callerFilePath) {
    return true;
  }

  const callerPath = resolve(options.callerFilePath);
  const normalizedRelative = normalizeSeparators(
    relative(options.guard.srcDir, callerPath),
  );

  if (
    normalizedRelative === ".." ||
    normalizedRelative.startsWith("../") ||
    normalizedRelative.startsWith("..\\")
  ) {
    return false;
  }

  return options.guard.globs.some((glob) => glob.match(normalizedRelative));
}

function toDisplayPath(path: string | undefined): string {
  if (!path) {
    return "unknown";
  }

  return normalizeSeparators(path);
}

function toDisplayPathFromSrc(options: {
  srcDir: string;
  filePath: string | undefined;
}): string {
  if (!options.filePath) {
    return "unknown";
  }

  const normalizedRelative = normalizeSeparators(
    relative(options.srcDir, resolve(options.filePath)),
  );

  if (
    normalizedRelative === ".." ||
    normalizedRelative.startsWith("../") ||
    normalizedRelative.startsWith("..\\")
  ) {
    return toDisplayPath(options.filePath);
  }

  return normalizedRelative;
}

function createRuntimeError(options: {
  code: string;
  message: string;
  where?: string;
  notes?: string[];
  help?: string[];
}): Error {
  const lines: string[] = [`${options.code}: ${options.message}`];

  if (options.where) {
    lines.push(`where: ${options.where}`);
  }

  if (options.notes) {
    for (const note of options.notes) {
      lines.push(`note: ${note}`);
    }
  }

  if (options.help) {
    for (const help of options.help) {
      lines.push(`help: ${help}`);
    }
  }

  return new Error(lines.join("\n"));
}

function toImportUrl(path: string): string {
  const file = pathToFileURL(path).href;
  return `${file}?dispatchkit=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function importDefault(path: string): Promise<unknown> {
  const mod = await import(toImportUrl(path));
  return mod.default;
}

function pickDefined(input: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(input).filter(
    ([, value]) => value !== undefined,
  );
  return Object.fromEntries(entries);
}

function extractConfigOverrides(
  options: BuildRuntimeOptions,
): Record<string, unknown> {
  const fromOptions: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(options)) {
    if (RESERVED_RUNTIME_OPTION_KEYS.has(key)) continue;
    if (value === undefined) continue;
    fromOptions[key] = value;
  }

  const explicitConfig = options.config ? pickDefined(options.config) : {};
  return {
    ...explicitConfig,
    ...fromOptions,
  };
}

async function readPackageJson(
  rootDir: string,
): Promise<Record<string, unknown>> {
  const path = join(rootDir, "package.json");
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return {};
  }

  try {
    const data = await file.json();
    return typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function resolveConfigSchema(
  srcDir: string,
): Promise<z.ZodTypeAny | undefined> {
  const configFilePath = join(srcDir, "config.ts");
  const exists = await Bun.file(configFilePath).exists();

  if (!exists) {
    return undefined;
  }

  const configDefinition = (await importDefault(configFilePath)) as
    | ConfigDefinition
    | undefined;
  if (!configDefinition || configDefinition.__dispatchkitType !== "config") {
    throw new Error(
      `DISPATCHKIT_CONFIG_INVALID_EXPORT: "${normalizeSeparators(configFilePath)}" must export default defineConfig(...)`,
    );
  }

  return configDefinition.schema;
}

function wrapValidationError(options: {
  operation: string;
  phase: "input" | "return";
  cause: unknown;
}): Error {
  const error = new Error(
    `DISPATCHKIT_VALIDATION_ERROR: ${options.operation} failed ${options.phase} validation`,
  );
  (error as Error & { cause?: unknown }).cause = options.cause;
  return error;
}

function createConsoleBindings(logger: LoggerLike): ConsoleLike {
  const fallback = globalThis.console;

  const call =
    (
      method: keyof LoggerLike,
      fallbackMethod: (...args: unknown[]) => unknown,
    ) =>
      (...args: unknown[]) => {
        const loggerMethod = logger[method];
        if (typeof loggerMethod === "function") {
          return (loggerMethod as (...input: unknown[]) => unknown).apply(
            logger,
            args,
          );
        }
        return fallbackMethod(...args);
      };

  return {
    log: call("info", fallback.log.bind(fallback)),
    info: call("info", fallback.info.bind(fallback)),
    warn: call("warn", fallback.warn.bind(fallback)),
    error: call("error", fallback.error.bind(fallback)),
    debug: call("debug", fallback.debug.bind(fallback)),
    trace: call("trace", fallback.trace.bind(fallback)),
  };
}

function createFallbackConsoleLogger(
  logLevel: RuntimeDefaultConfig["LOG_LEVEL"],
): LoggerLike {
  const fallbackConsole = globalThis.console;

  const shouldLog = (level: RuntimeDefaultConfig["LOG_LEVEL"]): boolean => {
    if (logLevel === "silent") {
      return false;
    }

    return LOG_LEVEL_INDEX[level] <= LOG_LEVEL_INDEX[logLevel];
  };

  const makeMethod = (
    level: RuntimeDefaultConfig["LOG_LEVEL"],
    method: keyof ConsoleLike,
  ) => {
    const sinkMethod = fallbackConsole[method] ?? fallbackConsole.log;
    const sink = sinkMethod.bind(fallbackConsole);
    return (...args: unknown[]) => {
      if (!shouldLog(level)) {
        return;
      }
      sink(...args);
    };
  };

  const logger: LoggerLike = {
    fatal: makeMethod("fatal", "error"),
    error: makeMethod("error", "error"),
    warn: makeMethod("warn", "warn"),
    info: makeMethod("info", "info"),
    debug: makeMethod("debug", "debug"),
    trace: makeMethod("trace", "trace"),
    child: () => logger,
  };

  return logger;
}

function mountGlobalConsole(runtimeConsole: ConsoleLike): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "console");

  if (descriptor && descriptor.configurable === false) {
    return;
  }

  Object.defineProperty(globalThis, "console", {
    value: runtimeConsole,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

async function resolveLogger(options: {
  srcDir: string;
  config: RuntimeConfig;
}): Promise<{ logger: LoggerLike; runtimeConsole: ConsoleLike }> {
  const loggerFilePath = join(options.srcDir, "logger.ts");
  const exists = await Bun.file(loggerFilePath).exists();

  if (!exists) {
    const logger = createFallbackConsoleLogger(options.config.LOG_LEVEL);

    return {
      logger,
      runtimeConsole: createConsoleBindings(logger),
    };
  }

  const loggerDefinition = (await importDefault(loggerFilePath)) as
    | LoggerDefinition<RuntimeConfig>
    | undefined;
  if (!loggerDefinition || loggerDefinition.__dispatchkitType !== "logger") {
    throw new Error(
      `DISPATCHKIT_LOGGER_INVALID_EXPORT: "${normalizeSeparators(loggerFilePath)}" must export default defineLogger(...)`,
    );
  }

  const resolved = loggerDefinition.factory(options.config);
  if (!resolved || typeof resolved !== "object") {
    throw new Error(
      "DISPATCHKIT_LOGGER_INVALID_FACTORY_RESULT: defineLogger() factory must return { logger, console }",
    );
  }

  if (!resolved.logger || !resolved.console) {
    throw new Error(
      "DISPATCHKIT_LOGGER_INVALID_FACTORY_RESULT: logger.ts must provide both logger and console",
    );
  }

  return {
    logger: resolved.logger,
    runtimeConsole: resolved.console,
  };
}

function isAllowedCall(caller: OperationKind, callee: OperationKind): boolean {
  if (caller === "query") {
    return callee === "query";
  }

  if (caller === "mutation") {
    return callee === "query" || callee === "mutation";
  }

  return true;
}

function isBusMethod(value: unknown): value is BusMethod<any, any> {
  return typeof value === "function" && value !== null && "$unsafe" in value;
}

function assignBusEntry(options: {
  section: BusNamespace;
  operationName: string;
  segments: string[];
  method: BusMethod<any, any>;
  kind: OperationKind;
}): void {
  const { section, operationName, segments, method, kind } = options;

  if (section[operationName] !== undefined) {
    throw new Error(
      `DISPATCHKIT_BUS_NAME_COLLISION: Duplicate ${kind} operation key "${operationName}"`,
    );
  }

  section[operationName] = method;

  if (segments.length <= 1) {
    return;
  }

  let current = section;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index]!;
    const existing = current[key];

    if (existing === undefined) {
      const next: BusNamespace = {};
      current[key] = next;
      current = next;
      continue;
    }

    if (isBusMethod(existing)) {
      throw new Error(
        `DISPATCHKIT_BUS_GROUP_COLLISION: Cannot create namespace "${key}" for ${kind}.${operationName}`,
      );
    }

    current = existing;
  }

  const leaf = segments[segments.length - 1]!;
  const leafValue = current[leaf];
  if (leafValue !== undefined) {
    throw new Error(
      `DISPATCHKIT_BUS_GROUP_COLLISION: Duplicate grouped key "${kind}.${segments.join(".")}"`,
    );
  }

  current[leaf] = method;
}

function createBusMethod(options: {
  operation: LoadedOperation;
  getRuntime: () => InternalRuntime;
}): BusMethod<any, any> {
  const { operation, getRuntime } = options;

  const execute = async (
    rawInput: unknown,
    unsafe: boolean,
  ): Promise<unknown> => {
    const stack = runtimeGlobalState.callFrameStorage.getStore() ?? [];
    const caller = stack[stack.length - 1];

    if (caller && !isAllowedCall(caller.kind, operation.kind)) {
      throw new Error(
        `DISPATCHKIT_CQRS_GUARD: ${caller.kind} "${caller.name}" cannot call ${operation.kind} "${operation.name}"`,
      );
    }

    const runtime = getRuntime();
    const moduleCtx: ModuleContext<
      RuntimeConfig,
      Record<string, unknown>,
      RuntimeBusBase
    > = {
      config: runtime.config,
      logger: runtime.logger,
      infra: runtime.infra,
      bus: runtime.bus,
    };

    let input = rawInput;
    if (!unsafe && operation.definition.input) {
      try {
        input = await operation.definition.input.parseAsync(rawInput);
      } catch (error) {
        throw wrapValidationError({
          operation: operation.name,
          phase: "input",
          cause: error,
        });
      }
    }

    const nextStack = [
      ...stack,
      { kind: operation.kind, name: operation.name } satisfies CallFrame,
    ];
    const result = await runtimeGlobalState.callFrameStorage.run(nextStack, () =>
      runtimeGlobalState.moduleContextStorage.run(moduleCtx, () =>
        operation.definition.handler({ ...moduleCtx, input }),
      ),
    );

    if (!unsafe && operation.definition.return) {
      try {
        return await operation.definition.return.parseAsync(result);
      } catch (error) {
        throw wrapValidationError({
          operation: operation.name,
          phase: "return",
          cause: error,
        });
      }
    }

    return result;
  };

  const call = (async (input: unknown) => execute(input, false)) as BusMethod<
    any,
    any
  >;
  call.$unsafe = async (input: unknown) => execute(input, true);
  call.$input = operation.definition.input;
  call.$return = operation.definition.return;
  return call;
}

function mergeStrict(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  scope: string,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(target, key)) {
      throw new Error(
        `DISPATCHKIT_${scope.toUpperCase()}_KEY_COLLISION: Duplicate key "${key}" while merging ${scope} modules`,
      );
    }

    target[key] = value;
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function wrapTransportWithContext(
  value: unknown,
  ctx: TransportContext<RuntimeConfig, RuntimeBusBase>,
  guard: TransportCtxAccessGuard | undefined,
): unknown {
  if (typeof value === "function") {
    return function wrappedTransportFn(this: unknown, ...args: unknown[]) {
      return runtimeGlobalState.transportContextStorage.run(ctx, () =>
        runtimeGlobalState.transportCtxAccessGuardStorage.run(guard, () =>
          (value as (...fnArgs: unknown[]) => unknown).apply(this, args),
        ),
      );
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    output[key] = wrapTransportWithContext(nested, ctx, guard);
  }
  return output;
}

async function loadOperationDefinitions(
  srcDir: string,
  discovery: DiscoveryResult,
): Promise<LoadedOperation[]> {
  const loaded: LoadedOperation[] = [];

  for (const operation of discovery.operations) {
    const absolute = toSourceFileFromRelative(
      join(srcDir, "modules"),
      operation.filePath,
    );
    const definition = (await importDefault(absolute)) as OperationDefinition<
      OperationKind,
      any,
      any,
      RuntimeConfig,
      Record<string, unknown>,
      RuntimeBusBase
    >;

    if (!definition || definition.__dispatchkitType !== "operation") {
      throw new Error(
        `DISPATCHKIT_OPERATION_INVALID_EXPORT: "${normalizeSeparators(absolute)}" must export default defineQuery/defineMutation/defineAction(...)`,
      );
    }

    if (definition.kind !== operation.kind) {
      throw new Error(
        `DISPATCHKIT_OPERATION_KIND_MISMATCH: "${normalizeSeparators(absolute)}" declares "${definition.kind}" but file name implies "${operation.kind}"`,
      );
    }

    loaded.push({
      kind: operation.kind,
      name: operation.operationName,
      segments: operation.operationSegments,
      filePath: operation.filePath,
      definition,
    });
  }

  return loaded;
}

async function loadInfraModules(options: {
  srcDir: string;
  discovery: DiscoveryResult;
  ctx: ModuleContext<RuntimeConfig, Record<string, unknown>, RuntimeBusBase>;
}): Promise<{
  infra: Record<string, unknown>;
  transportFromInfra: Array<{
    key: string;
    filePath: string;
    source: TransportSource;
  }>;
}> {
  const mergedInfra: Record<string, unknown> = {};
  let infra = mergedInfra;
  let hasOpaqueInfra = false;
  const transportFromInfra: Array<{
    key: string;
    filePath: string;
    source: TransportSource;
  }> = [];

  for (const file of options.discovery.infra) {
    const absolute = toSourceFileFromRelative(
      join(options.srcDir, "infra"),
      file,
    );
    const definition = (await importDefault(absolute)) as
      | InfraDefinition<RuntimeConfig, unknown>
      | TransportDefinition<RuntimeConfig, RuntimeBusBase, unknown>;

    if (
      !definition ||
      (definition.__dispatchkitType !== "infra" && definition.__dispatchkitType !== "transport")
    ) {
      throw new Error(
        `DISPATCHKIT_INFRA_INVALID_EXPORT: "${normalizeSeparators(absolute)}" must export default defineInfra(...) or defineTransport(...)`,
      );
    }

    if (definition.__dispatchkitType === "transport") {
      transportFromInfra.push({
        key: resolveTransportKey(file),
        filePath: file,
        source: "infra",
      });
      continue;
    }

    const infraCtx: InfraContext<RuntimeConfig> = {
      config: options.ctx.config,
      logger: options.ctx.logger,
    };
    const result = await runtimeGlobalState.moduleContextStorage.run(options.ctx, () =>
      Promise.resolve(definition.factory(infraCtx)),
    );
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(
        `DISPATCHKIT_INFRA_INVALID_RESULT: "${normalizeSeparators(absolute)}" must return an object`,
      );
    }

    const moduleResult = result as Record<string, unknown>;
    const plainObjectResult = isPlainObject(result);

    if (!plainObjectResult) {
      if (hasOpaqueInfra || Object.keys(infra).length > 0) {
        throw new Error(
          `DISPATCHKIT_INFRA_INVALID_RESULT: "${normalizeSeparators(absolute)}" returned a non-plain object that cannot be merged with other infra modules`,
        );
      }

      infra = moduleResult;
      hasOpaqueInfra = true;
      continue;
    }

    mergeStrict(infra, moduleResult, "infra");
  }

  return { infra, transportFromInfra };
}

async function loadTransportModules(options: {
  srcDir: string;
  transportModules: Array<{
    key: string;
    filePath: string;
    source: TransportSource;
  }>;
  ctx: TransportContext<RuntimeConfig, RuntimeBusBase>;
}): Promise<{
  transport: Record<string, unknown>;
  guard: TransportCtxAccessGuard | undefined;
}> {
  const transport: Record<string, unknown> = {};
  const allAllowPatterns: string[] = [];

  for (const module of options.transportModules) {
    const layerDir = module.source === "infra" ? "infra" : "transport";
    const absolute = toSourceFileFromRelative(
      join(options.srcDir, layerDir),
      module.filePath,
    );
    const definition = (await runtimeGlobalState.transportContextStorage.run(
      options.ctx,
      () => importDefault(absolute),
    )) as TransportDefinition<RuntimeConfig, RuntimeBusBase, unknown>;

    if (!definition || definition.__dispatchkitType !== "transport") {
      throw new Error(
        `DISPATCHKIT_TRANSPORT_INVALID_EXPORT: "${normalizeSeparators(absolute)}" must export default defineTransport(...)`,
      );
    }

    const transportCtx: TransportContext<RuntimeConfig, RuntimeBusBase> =
      options.ctx;
    const transportOptions = definition.options as
      | TransportDefinitionOptions
      | undefined;
    const allowPatterns = transportOptions?.allowGetTransportCtxFrom ?? [];
    const defaultPatterns = buildDefaultTransportCtxPatterns({
      key: module.key,
      filePath: module.filePath,
      source: module.source,
    });
    const moduleGuard =
      allowPatterns.length > 0
        ? buildTransportCtxAccessGuard({
          srcDir: options.srcDir,
          patterns: [
            ...defaultPatterns,
            ...expandTransportCtxAllowPatterns({
              patterns: allowPatterns,
            }),
          ],
        })
        : undefined;
    if (moduleGuard) {
      allAllowPatterns.push(...moduleGuard.patterns);
    }

    const result = await runtimeGlobalState.transportContextStorage.run(transportCtx, () =>
      runtimeGlobalState.transportCtxAccessGuardStorage.run(moduleGuard, () =>
        Promise.resolve(definition.factory(transportCtx)),
      ),
    );
    if (Object.hasOwn(transport, module.key)) {
      throw new Error(
        `DISPATCHKIT_TRANSPORT_KEY_COLLISION: Duplicate transport key "${module.key}"`,
      );
    }

    transport[module.key] = wrapTransportWithContext(
      result,
      transportCtx,
      moduleGuard,
    );
  }

  return {
    transport,
    guard: buildTransportCtxAccessGuard({
      srcDir: options.srcDir,
      patterns: allAllowPatterns,
    }),
  };
}

function buildBus(
  operations: LoadedOperation[],
  getRuntime: () => InternalRuntime,
): RuntimeBusBase {
  const bus: RuntimeBusBase = {
    query: {},
    mutation: {},
    action: {},
  };

  for (const operation of operations) {
    const method = createBusMethod({ operation, getRuntime });
    const section = bus[operation.kind];

    assignBusEntry({
      section,
      operationName: operation.name,
      segments: operation.segments,
      method,
      kind: operation.kind,
    });
  }

  return bus;
}

async function resolveRuntimeConfig(options: {
  rootDir: string;
  srcDir: string;
  envFile: string;
  overrides: Record<string, unknown>;
}): Promise<RuntimeConfig> {
  dotenv.config({ path: options.envFile, override: true });

  const packageJson = await readPackageJson(options.rootDir);
  const defaults: RuntimeDefaultConfig = {
    SERVICE_NAME:
      typeof packageJson.name === "string" ? packageJson.name : "service",
    SERVICE_DESCRIPTION:
      typeof packageJson.description === "string"
        ? packageJson.description
        : "service description",
    SERVICE_VERSION:
      typeof packageJson.version === "string"
        ? packageJson.version
        : "0.0.0-dev",
    LOG_LEVEL: "info",
    NODE_ENV: "production",
  };

  const rawConfig = {
    ...defaults,
    ...pickDefined(process.env as unknown as Record<string, unknown>),
    ...options.overrides,
  };

  if (String(rawConfig.NODE_ENV) === "test") {
    rawConfig.NODE_ENV = "development";
  }

  const userSchema = await resolveConfigSchema(options.srcDir);
  const schema = userSchema ? RuntimeSchema.and(userSchema) : RuntimeSchema;

  return (await schema.parseAsync(rawConfig)) as RuntimeConfig;
}

export function getModuleCtx(): ModuleContext<RuntimeConfig> {
  const current = runtimeGlobalState.moduleContextStorage.getStore();
  if (current) {
    return current as unknown as ModuleContext<RuntimeConfig>;
  }

  if (!runtimeGlobalState.activeRuntime) {
    const callerFilePath = resolveCallerFilePath(getModuleCtx);
    throw createRuntimeError({
      code: "DISPATCHKIT_CONTEXT_UNAVAILABLE",
      message: "Module context is unavailable outside runtime execution",
      where: toDisplayPath(callerFilePath),
      help: [
        "Call getModuleCtx() inside defineQuery/defineMutation/defineAction handlers or bus-invoked execution.",
        "If this call is on module top-level, move it into a function/handler so it runs during runtime execution.",
      ],
    });
  }

  return {
    config: runtimeGlobalState.activeRuntime.config,
    logger: runtimeGlobalState.activeRuntime.logger,
    infra: runtimeGlobalState.activeRuntime.infra,
    bus: runtimeGlobalState.activeRuntime.bus,
  } as unknown as ModuleContext<RuntimeConfig>;
}

export function getTransportCtx(): TransportContext<RuntimeConfig> {
  const guard =
    runtimeGlobalState.transportCtxAccessGuardStorage.getStore() ??
    runtimeGlobalState.activeTransportCtxAccessGuard;
  const callerFilePath = resolveCallerFilePath(getTransportCtx);

  if (guard) {
    if (!isTransportCtxCallAllowed({ guard, callerFilePath })) {
      throw createRuntimeError({
        code: "DISPATCHKIT_CONTEXT_FORBIDDEN",
        message: "getTransportCtx() call is not allowed from this file",
        where: toDisplayPathFromSrc({
          srcDir: guard.srcDir,
          filePath: callerFilePath,
        }),
        notes: [
          `allowed patterns (from src): ${guard.patterns.join(", ")}`,
        ],
        help: [
          "Add a matching path to defineTransport(..., { allowGetTransportCtxFrom: [...] }).",
          "Or move getTransportCtx() usage into an allowed transport file.",
        ],
      });
    }
  }

  const current = runtimeGlobalState.transportContextStorage.getStore();
  if (current) {
    return current as unknown as TransportContext<RuntimeConfig>;
  }

  if (!runtimeGlobalState.activeRuntime) {
    throw createRuntimeError({
      code: "DISPATCHKIT_CONTEXT_UNAVAILABLE",
      message: "Transport context is unavailable outside runtime execution",
      where: toDisplayPath(callerFilePath),
      help: [
        "Call getTransportCtx() inside defineTransport factory or transport methods invoked from runtime.transport.",
        "If this call happens in an imported helper, allow it via defineTransport(..., { allowGetTransportCtxFrom: [...] }).",
        "Avoid unconditional top-level calls in unrelated modules loaded before buildRuntime().",
      ],
    });
  }

  return {
    config: runtimeGlobalState.activeRuntime.config,
    logger: runtimeGlobalState.activeRuntime.logger,
    bus: runtimeGlobalState.activeRuntime.bus,
  } as unknown as TransportContext<RuntimeConfig>;
}

export async function buildRuntime(
  options: BuildRuntimeOptions = {},
): Promise<Runtime<RuntimeConfig>> {
  runtimeGlobalState.activeRuntime = undefined;
  runtimeGlobalState.activeTransportCtxAccessGuard = undefined;

  const rootDir = options.rootDir ? resolve(options.rootDir) : process.cwd();
  const srcDir = options.srcDir
    ? resolve(options.srcDir)
    : join(rootDir, "src");
  const generatedDir = options.generatedDir
    ? resolve(options.generatedDir)
    : join(srcDir, "generated", "runtime");
  const envFile = options.envFile
    ? resolve(options.envFile)
    : join(rootDir, ".env");

  mkdirSync(generatedDir, { recursive: true });

  const configOverrides = extractConfigOverrides(options);
  const config = await resolveRuntimeConfig({
    rootDir,
    srcDir,
    envFile,
    overrides: configOverrides,
  });

  const { logger, runtimeConsole } = await resolveLogger({ srcDir, config });

  const discovery = await discoverRuntimeFiles(srcDir);
  const loadedOperations = await loadOperationDefinitions(srcDir, discovery);

  const runtimeRef: InternalRuntime = {
    config,
    logger,
    infra: {},
    bus: { query: {}, mutation: {}, action: {} },
    transport: {},
  };

  runtimeRef.bus = buildBus(loadedOperations, () => runtimeRef);

  const moduleCtx: ModuleContext<
    RuntimeConfig,
    Record<string, unknown>,
    RuntimeBusBase
  > = {
    config: runtimeRef.config,
    logger: runtimeRef.logger,
    infra: runtimeRef.infra,
    bus: runtimeRef.bus,
  };

  const infraResult = await loadInfraModules({
    srcDir,
    discovery,
    ctx: moduleCtx,
  });
  runtimeRef.infra = infraResult.infra;
  runtimeGlobalState.activeRuntime = runtimeRef;

  const transportCtx: TransportContext<RuntimeConfig, RuntimeBusBase> = {
    config: runtimeRef.config,
    logger: runtimeRef.logger,
    bus: runtimeRef.bus,
  };

  const transportModules = [
    ...discovery.transport,
    ...infraResult.transportFromInfra,
  ].sort(
    (left, right) =>
      left.key.localeCompare(right.key) ||
      left.source.localeCompare(right.source) ||
      left.filePath.localeCompare(right.filePath),
  );

  const transportLoad = await loadTransportModules({
    srcDir,
    transportModules,
    ctx: transportCtx,
  });
  runtimeRef.transport = transportLoad.transport;

  const discoveryForArtifacts: DiscoveryResult = {
    ...discovery,
    infra: discovery.infra.filter(
      (file) =>
        !infraResult.transportFromInfra.some(
          (transportModule) => transportModule.filePath === file,
        ),
    ),
    transport: transportModules,
  };

  await generateArtifacts({
    srcDir,
    generatedDir,
    discovery: discoveryForArtifacts,
  });

  runtimeGlobalState.activeRuntime = runtimeRef;
  runtimeGlobalState.activeTransportCtxAccessGuard = transportLoad.guard;
  (globalThis as typeof globalThis & { runtime: unknown }).runtime =
    runtimeRef as any;

  mountGlobalConsole(runtimeConsole);

  return runtimeRef as unknown as Runtime<RuntimeConfig>;
}
