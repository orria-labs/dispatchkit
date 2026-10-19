import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import dotenv from "dotenv";

import { resolveTransportKey, toSourceFileFromRelative } from "./discovery.ts";
import { discoverForArtifacts } from "./generate.ts";
import { createLifecycle } from "./lifecycle.ts";
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
  RuntimeConfigShape,
  RuntimeDefaultConfig,
  RuntimeInfraShape,
  RuntimeTransportShape,
  TransportContext,
  TransportDefinition,
  TransportDefinitionOptions,
  TransportFactoryContext,
  TransportSource,
} from "./types.ts";
import { assertStandardSchema, StandardSchemaError, validateSchema } from "./validation.ts";

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
const transportCtxAccessGuardStorage = new AsyncLocalStorage<TransportCtxAccessGuard | undefined>();
const callFrameStorage = new AsyncLocalStorage<CallFrame[]>();
type BuildScope = { runtime?: InternalRuntime; srcDir?: string };
type ImportScope = {
  build?: BuildScope;
  module?: ModuleContext<RuntimeConfig, Record<string, unknown>, RuntimeBusBase>;
  transport?: TransportContext<RuntimeConfig, RuntimeBusBase>;
  guard?: TransportCtxAccessGuard;
};
const buildContextStorage = new AsyncLocalStorage<BuildScope>();
const disposedRuntimes = new WeakSet<InternalRuntime>();
const RUNTIME_GLOBAL_STATE_KEY = Symbol.for("dispatchkit.runtime.globalState.v2");

type RuntimeGlobalState = {
  baseConsole: ConsoleLike;
  importQueue: Promise<void>;
  importScope: ImportScope | undefined;
  transportOriginals: WeakMap<object, object>;
  moduleContextStorage: typeof moduleContextStorage;
  transportContextStorage: typeof transportContextStorage;
  transportCtxAccessGuardStorage: typeof transportCtxAccessGuardStorage;
  callFrameStorage: typeof callFrameStorage;
  buildContextStorage: typeof buildContextStorage;
  disposedRuntimes: typeof disposedRuntimes;
  activeRuntime: InternalRuntime | undefined;
  activeTransportCtxAccessGuard: TransportCtxAccessGuard | undefined;
};

function getRuntimeGlobalState(): RuntimeGlobalState {
  const globalState = globalThis as typeof globalThis & {
    [RUNTIME_GLOBAL_STATE_KEY]?: RuntimeGlobalState;
  };

  if (!globalState[RUNTIME_GLOBAL_STATE_KEY]) {
    globalState[RUNTIME_GLOBAL_STATE_KEY] = {
      baseConsole: globalThis.console,
      importQueue: Promise.resolve(),
      importScope: undefined,
      transportOriginals: new WeakMap(),
      moduleContextStorage,
      transportContextStorage,
      transportCtxAccessGuardStorage,
      callFrameStorage,
      buildContextStorage,
      disposedRuntimes,
      activeRuntime: undefined,
      activeTransportCtxAccessGuard: undefined,
    };
  }

  return globalState[RUNTIME_GLOBAL_STATE_KEY];
}

const runtimeGlobalState = getRuntimeGlobalState();

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const LOG_LEVEL_INDEX = LOG_LEVELS.reduce<Record<LogLevel, number>>(
  (acc, level, index) => {
    acc[level] = index;
    return acc;
  },
  {} as Record<LogLevel, number>,
);

const RESERVED_RUNTIME_OPTION_KEYS = new Set([
  "rootDir",
  "srcDir",
  "generatedDir",
  "envFile",
  "config",
  "generateArtifacts",
  "mountGlobal",
]);

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function resolvePhysicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
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

function buildDefaultTransportCtxPatterns(module: TransportCtxModuleRef): string[] {
  const layerDir = module.source === "infra" ? "infra" : "transport";
  const normalizedFilePath = normalizeSeparators(module.filePath);
  return [`${layerDir}/${normalizedFilePath}`];
}

function expandTransportCtxAllowPatterns(options: { patterns: string[] }): string[] {
  const expanded: string[] = [];

  for (const rawPattern of options.patterns) {
    const normalized = normalizeTransportCtxAllowPattern(rawPattern);
    if (!normalized) {
      continue;
    }

    expanded.push(normalized);

    const isShorthand =
      !normalized.includes("/") && !normalized.endsWith(".ts") && !hasGlobMagic(normalized);

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
    srcDir: resolvePhysicalPath(options.srcDir),
    patterns: normalizedPatterns,
    globs: normalizedPatterns.map((pattern) => new Bun.Glob(pattern)),
  };
}

function resolveCallerFilePath(skipper: (...args: any[]) => unknown): string | undefined {
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

      const filePath = rawFilePath.startsWith("file://") ? fileURLToPath(rawFilePath) : rawFilePath;
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

  const callerPath = resolvePhysicalPath(options.callerFilePath);
  const normalizedRelative = normalizeSeparators(relative(options.guard.srcDir, callerPath));

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

function toDisplayPathFromSrc(options: { srcDir: string; filePath: string | undefined }): string {
  if (!options.filePath) {
    return "unknown";
  }

  const normalizedRelative = normalizeSeparators(
    relative(options.srcDir, resolvePhysicalPath(options.filePath)),
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
  return pathToFileURL(path).href;
}

async function importDefault(path: string): Promise<unknown> {
  // Bun can evaluate dynamically imported modules outside AsyncLocalStorage.
  // Serialize evaluation and expose a temporary scope only to files in this app.
  const scope: ImportScope = {
    build: runtimeGlobalState.buildContextStorage.getStore(),
    module: runtimeGlobalState.moduleContextStorage.getStore(),
    transport: runtimeGlobalState.transportContextStorage.getStore(),
    guard: runtimeGlobalState.transportCtxAccessGuardStorage.getStore(),
  };
  const previous = runtimeGlobalState.importQueue;
  let release!: () => void;
  runtimeGlobalState.importQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  runtimeGlobalState.importScope = scope;
  try {
    const mod = await import(toImportUrl(path));
    return mod.default;
  } finally {
    runtimeGlobalState.importScope = undefined;
    release();
  }
}

function getImportScope(callerFilePath: string | undefined): ImportScope | undefined {
  const scope = runtimeGlobalState.importScope;
  if (!scope?.build?.srcDir || !callerFilePath) return undefined;
  const path = normalizeSeparators(
    relative(resolvePhysicalPath(scope.build.srcDir), resolvePhysicalPath(callerFilePath)),
  );
  return path === ".." || path.startsWith("../") ? undefined : scope;
}

function pickDefined(input: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

function extractConfigOverrides(options: BuildRuntimeOptions): Record<string, unknown> {
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

async function readPackageJson(rootDir: string): Promise<Record<string, unknown>> {
  const path = join(rootDir, "package.json");
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return {};
  }

  try {
    const data = await file.json();
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return {};
  }

  return dotenv.parse(await file.text());
}

async function resolveConfigSchema(srcDir: string): Promise<StandardSchemaV1 | undefined> {
  const configFilePath = join(srcDir, "config.ts");
  const exists = await Bun.file(configFilePath).exists();

  if (!exists) {
    return undefined;
  }

  const configDefinition = (await importDefault(configFilePath)) as ConfigDefinition | undefined;
  if (!configDefinition || configDefinition.__dispatchkitType !== "config") {
    throw new Error(
      `DISPATCHKIT_CONFIG_INVALID_EXPORT: "${normalizeSeparators(configFilePath)}" must export default defineConfig(...)`,
    );
  }

  assertStandardSchema(configDefinition.schema);
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
  const fallback = runtimeGlobalState.baseConsole;

  const call =
    (method: keyof LoggerLike, fallbackMethod: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      const loggerMethod = logger[method];
      if (typeof loggerMethod === "function") {
        return (loggerMethod as (...input: unknown[]) => unknown).apply(logger, args);
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

function createFallbackConsoleLogger(logLevel: RuntimeDefaultConfig["LOG_LEVEL"]): LoggerLike {
  const fallbackConsole = runtimeGlobalState.baseConsole;

  const shouldLog = (level: RuntimeDefaultConfig["LOG_LEVEL"]): boolean => {
    if (logLevel === "silent") {
      return false;
    }

    return LOG_LEVEL_INDEX[level] <= LOG_LEVEL_INDEX[logLevel];
  };

  const makeMethod = (level: RuntimeDefaultConfig["LOG_LEVEL"], method: keyof ConsoleLike) => {
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

  // A process can build more than one runtime (tests, workers, or multi-tenant
  // applications). Keep this assignment replaceable so the active runtime's
  // configured console is always used instead of permanently retaining the first.
  if (!descriptor || descriptor.configurable) {
    Object.defineProperty(globalThis, "console", {
      value: runtimeConsole,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return;
  }

  if ("value" in descriptor && descriptor.writable) {
    (globalThis as unknown as { console: ConsoleLike }).console = runtimeConsole;
  }
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
    LoggerDefinition<RuntimeConfig> | undefined;
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

  if (Object.hasOwn(section, operationName)) {
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
    const existing = Object.hasOwn(current, key) ? current[key] : undefined;

    if (existing === undefined) {
      const next: BusNamespace = Object.create(null);
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
  if (Object.hasOwn(current, leaf)) {
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

  const execute = async (rawInput: unknown, unsafe: boolean): Promise<unknown> => {
    const stack = runtimeGlobalState.callFrameStorage.getStore() ?? [];
    const caller = stack[stack.length - 1];

    if (caller && !isAllowedCall(caller.kind, operation.kind)) {
      throw new Error(
        `DISPATCHKIT_CQRS_GUARD: ${caller.kind} "${caller.name}" cannot call ${operation.kind} "${operation.name}"`,
      );
    }

    const runtime = getRuntime();
    const moduleCtx: ModuleContext<RuntimeConfig, Record<string, unknown>, RuntimeBusBase> = {
      config: runtime.config,
      logger: runtime.logger,
      infra: runtime.infra,
      bus: runtime.bus,
    };

    if (runtimeGlobalState.disposedRuntimes.has(runtime)) {
      throw new Error("DISPATCHKIT_RUNTIME_DISPOSED: Cannot execute operations after disposal");
    }
    const nextStack = [
      ...stack,
      { kind: operation.kind, name: operation.name } satisfies CallFrame,
    ];
    return runtimeGlobalState.callFrameStorage.run(nextStack, () =>
      runtimeGlobalState.moduleContextStorage.run(moduleCtx, async () => {
        let input = rawInput;
        if (!unsafe && operation.definition.input) {
          try {
            input = await validateSchema(operation.definition.input, rawInput);
          } catch (cause) {
            throw wrapValidationError({ operation: operation.name, phase: "input", cause });
          }
        }
        const result = await operation.definition.handler({ ...moduleCtx, input });
        if (!unsafe && operation.definition.return) {
          try {
            return await validateSchema(operation.definition.return, result);
          } catch (cause) {
            throw wrapValidationError({ operation: operation.name, phase: "return", cause });
          }
        }
        return result;
      }),
    );
  };

  const call = (async (input: unknown) => execute(input, false)) as BusMethod<any, any>;
  call.$unsafe = async (input: unknown) => execute(input, true);
  call.$input = operation.definition.input;
  call.$return = operation.definition.return;
  return call;
}

function wrapTransportWithContext(
  value: unknown,
  ctx: TransportContext<RuntimeConfig, RuntimeBusBase>,
  guard: TransportCtxAccessGuard | undefined,
): unknown {
  const wrappers = new WeakMap<object, object>();
  const originals = runtimeGlobalState.transportOriginals;
  const isObject = (input: unknown): input is object =>
    input !== null && (typeof input === "object" || typeof input === "function");
  const unwrap = (input: unknown): unknown =>
    isObject(input) ? (originals.get(input) ?? input) : input;
  const run = <T>(callback: () => T): T =>
    runtimeGlobalState.transportContextStorage.run(ctx, () =>
      runtimeGlobalState.transportCtxAccessGuardStorage.run(guard, callback),
    );

  const wrap = (input: unknown): unknown => {
    if (!isObject(input)) return input;
    // Native consumers inspect internal slots directly, without invoking proxy
    // traps. Keep HTTP bodies, binary data and web primitives intact.
    if (
      input instanceof Response ||
      input instanceof Request ||
      input instanceof Headers ||
      input instanceof Blob ||
      input instanceof FormData ||
      input instanceof URL ||
      input instanceof URLSearchParams ||
      input instanceof ArrayBuffer ||
      input instanceof SharedArrayBuffer ||
      ArrayBuffer.isView(input) ||
      input instanceof ReadableStream ||
      input instanceof WritableStream ||
      input instanceof TransformStream ||
      input instanceof AbortSignal ||
      input instanceof AbortController
    )
      return input;
    if (originals.has(input)) return input;
    const existing = wrappers.get(input);
    if (existing) return existing;

    // Resolve asynchronous fluent methods back to the same wrapped instance.
    // A native promise also keeps await/then compatible with internal slots.
    if (input instanceof Promise) {
      const promise = input.then((result) => run(() => wrap(result)));
      wrappers.set(input, promise);
      originals.set(promise, input);
      return promise;
    }

    const wrapped = new Proxy(input, {
      get(target, key) {
        return run(() => {
          // Accessors and methods must receive the original instance so private
          // fields and native internal slots (Map, Set, Date, etc.) remain valid.
          const nested = Reflect.get(target, key, target);
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (
            descriptor &&
            !descriptor.configurable &&
            "value" in descriptor &&
            !descriptor.writable
          ) {
            // Proxy invariants require the exact value of a frozen own property.
            return nested;
          }
          return key === "constructor" ? nested : wrap(nested);
        });
      },
      set(target, key, next) {
        return run(() => Reflect.set(target, key, unwrap(next), target));
      },
      apply(target, receiver, args) {
        return run(() =>
          wrap(
            Reflect.apply(
              target as (...args: unknown[]) => unknown,
              unwrap(receiver),
              args.map(unwrap),
            ),
          ),
        );
      },
      construct(target, args, newTarget) {
        return run(
          () =>
            wrap(
              Reflect.construct(
                target as new (...args: unknown[]) => object,
                args.map(unwrap),
                unwrap(newTarget) as new (...args: unknown[]) => object,
              ),
            ) as object,
        );
      },
    });
    wrappers.set(input, wrapped);
    originals.set(wrapped, input);
    return wrapped;
  };

  return wrap(value);
}

async function loadOperationDefinitions(
  srcDir: string,
  discovery: DiscoveryResult,
): Promise<LoadedOperation[]> {
  const loaded: LoadedOperation[] = [];

  for (const operation of discovery.operations) {
    const absolute = toSourceFileFromRelative(join(srcDir, "modules"), operation.filePath);
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

    if (definition.input !== undefined) assertStandardSchema(definition.input);
    if (definition.return !== undefined) assertStandardSchema(definition.return);
    if (typeof definition.handler !== "function") {
      throw new TypeError(
        `DISPATCHKIT_OPERATION_INVALID_HANDLER: ${operation.operationName} must define a handler`,
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
  onDispose: (callback: () => void | Promise<void>) => void;
}): Promise<{
  infra: Record<string, unknown>;
  transportFromInfra: Array<{
    key: string;
    filePath: string;
    source: TransportSource;
  }>;
}> {
  const infra: Record<string, unknown> = Object.create(null);
  const transportFromInfra: Array<{
    key: string;
    filePath: string;
    source: TransportSource;
  }> = [];

  for (const file of options.discovery.infra) {
    const absolute = toSourceFileFromRelative(join(options.srcDir, "infra"), file);
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
      onDispose: options.onDispose,
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

    const moduleKey = resolveTransportKey(file);
    if (Object.hasOwn(infra, moduleKey)) {
      throw new Error(
        `DISPATCHKIT_INFRA_KEY_COLLISION: Duplicate infra key "${moduleKey}" from "${file}"`,
      );
    }
    infra[moduleKey] = result;
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
  ctx: TransportFactoryContext<RuntimeConfig, RuntimeBusBase>;
}): Promise<{
  transport: Record<string, unknown>;
  guard: TransportCtxAccessGuard | undefined;
}> {
  const transport: Record<string, unknown> = Object.create(null);
  const allAllowPatterns: string[] = [];

  for (const module of options.transportModules) {
    const layerDir = module.source === "infra" ? "infra" : "transport";
    const absolute = toSourceFileFromRelative(join(options.srcDir, layerDir), module.filePath);
    const definition = (await runtimeGlobalState.transportContextStorage.run(options.ctx, () =>
      runtimeGlobalState.transportCtxAccessGuardStorage.run(undefined, () =>
        importDefault(absolute),
      ),
    )) as TransportDefinition<RuntimeConfig, RuntimeBusBase, unknown>;

    if (!definition || definition.__dispatchkitType !== "transport") {
      throw new Error(
        `DISPATCHKIT_TRANSPORT_INVALID_EXPORT: "${normalizeSeparators(absolute)}" must export default defineTransport(...)`,
      );
    }

    const transportCtx: TransportFactoryContext<RuntimeConfig, RuntimeBusBase> = options.ctx;
    const transportOptions = definition.options as TransportDefinitionOptions | undefined;
    const allowPatterns = transportOptions?.allowGetTransportCtxFrom ?? [];
    const defaultPatterns = buildDefaultTransportCtxPatterns({
      key: module.key,
      filePath: module.filePath,
      source: module.source,
    });
    const moduleGuard = buildTransportCtxAccessGuard({
      srcDir: options.srcDir,
      patterns: [
        ...defaultPatterns,
        ...expandTransportCtxAllowPatterns({ patterns: allowPatterns }),
      ],
    });
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

    transport[module.key] = wrapTransportWithContext(result, transportCtx, moduleGuard);
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
    query: Object.create(null),
    mutation: Object.create(null),
    action: Object.create(null),
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

function validateDefaultConfig(input: Record<string, unknown>): RuntimeDefaultConfig {
  const issues: StandardSchemaV1.Issue[] = [];
  for (const key of ["SERVICE_NAME", "SERVICE_DESCRIPTION", "SERVICE_VERSION"] as const) {
    if (typeof input[key] !== "string")
      issues.push({ message: `${key} must be a string`, path: [key] });
  }
  if (!LOG_LEVELS.includes(input.LOG_LEVEL as LogLevel)) {
    issues.push({
      message: `LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`,
      path: ["LOG_LEVEL"],
    });
  }
  if (input.NODE_ENV !== "development" && input.NODE_ENV !== "production") {
    issues.push({ message: "NODE_ENV must be development or production", path: ["NODE_ENV"] });
  }
  if (issues.length) throw new StandardSchemaError(issues);
  return {
    SERVICE_NAME: input.SERVICE_NAME as string,
    SERVICE_DESCRIPTION: input.SERVICE_DESCRIPTION as string,
    SERVICE_VERSION: input.SERVICE_VERSION as string,
    LOG_LEVEL: input.LOG_LEVEL as RuntimeDefaultConfig["LOG_LEVEL"],
    NODE_ENV: input.NODE_ENV as RuntimeDefaultConfig["NODE_ENV"],
  };
}

async function resolveRuntimeConfig(options: {
  rootDir: string;
  srcDir: string;
  envFile: string;
  overrides: Record<string, unknown>;
}): Promise<RuntimeConfig> {
  const [packageJson, envFileConfig] = await Promise.all([
    readPackageJson(options.rootDir),
    readEnvFile(options.envFile),
  ]);
  const defaults: RuntimeDefaultConfig = {
    SERVICE_NAME: typeof packageJson.name === "string" ? packageJson.name : "service",
    SERVICE_DESCRIPTION:
      typeof packageJson.description === "string" ? packageJson.description : "service description",
    SERVICE_VERSION: typeof packageJson.version === "string" ? packageJson.version : "0.0.0-dev",
    LOG_LEVEL: "info",
    NODE_ENV: "production",
  };

  const rawConfig = {
    ...defaults,
    ...pickDefined(process.env as unknown as Record<string, unknown>),
    ...envFileConfig,
    ...options.overrides,
  };

  if (String(rawConfig.NODE_ENV) === "test") {
    rawConfig.NODE_ENV = "development";
  }

  const userSchema = await resolveConfigSchema(options.srcDir);
  const builtin = validateDefaultConfig(rawConfig);
  if (!userSchema) return builtin;
  const custom = await validateSchema(userSchema, rawConfig);
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) {
    throw new TypeError("DISPATCHKIT_CONFIG_INVALID_RESULT: Config schema must produce an object");
  }
  const merged = { ...builtin, ...custom };
  // User transforms may refine built-in fields, but cannot invalidate their public contract.
  return { ...merged, ...validateDefaultConfig(merged) };
}

export function getModuleCtx(): ModuleContext<RuntimeConfigShape, RuntimeInfraShape, RuntimeBus> {
  const stored = runtimeGlobalState.moduleContextStorage.getStore();
  if (stored)
    return stored as unknown as ModuleContext<RuntimeConfigShape, RuntimeInfraShape, RuntimeBus>;
  const callerFilePath = resolveCallerFilePath(getModuleCtx);
  const imported = getImportScope(callerFilePath);
  const current = imported?.module;
  if (current) {
    return current as unknown as ModuleContext<RuntimeConfigShape, RuntimeInfraShape, RuntimeBus>;
  }

  const pending = runtimeGlobalState.buildContextStorage.getStore() ?? imported?.build;
  const activeRuntime = pending ? pending.runtime : runtimeGlobalState.activeRuntime;
  if (!activeRuntime || runtimeGlobalState.disposedRuntimes.has(activeRuntime)) {
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
    config: activeRuntime.config,
    logger: activeRuntime.logger,
    infra: activeRuntime.infra,
    bus: activeRuntime.bus,
  } as unknown as ModuleContext<RuntimeConfigShape, RuntimeInfraShape, RuntimeBus>;
}

export function getTransportCtx(): TransportContext<RuntimeConfigShape, RuntimeBus> {
  const callerFilePath = resolveCallerFilePath(getTransportCtx);
  const imported = getImportScope(callerFilePath);
  const stored = runtimeGlobalState.transportContextStorage.getStore();
  const current = stored ?? imported?.transport;
  const pending = runtimeGlobalState.buildContextStorage.getStore() ?? imported?.build;
  const guard = stored
    ? runtimeGlobalState.transportCtxAccessGuardStorage.getStore()
    : imported
      ? imported.guard
      : pending
        ? undefined
        : runtimeGlobalState.activeTransportCtxAccessGuard;

  if (guard) {
    if (!isTransportCtxCallAllowed({ guard, callerFilePath })) {
      throw createRuntimeError({
        code: "DISPATCHKIT_CONTEXT_FORBIDDEN",
        message: "getTransportCtx() call is not allowed from this file",
        where: toDisplayPathFromSrc({
          srcDir: guard.srcDir,
          filePath: callerFilePath,
        }),
        notes: [`allowed patterns (from src): ${guard.patterns.join(", ")}`],
        help: [
          "Add a matching path to defineTransport(..., { allowGetTransportCtxFrom: [...] }).",
          "Or move getTransportCtx() usage into an allowed transport file.",
        ],
      });
    }
  }

  if (current) {
    return current as unknown as TransportContext<RuntimeConfigShape, RuntimeBus>;
  }

  const activeRuntime = pending ? pending.runtime : runtimeGlobalState.activeRuntime;
  if (!activeRuntime || runtimeGlobalState.disposedRuntimes.has(activeRuntime)) {
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
    config: activeRuntime.config,
    logger: activeRuntime.logger,
    bus: activeRuntime.bus,
  } as unknown as TransportContext<RuntimeConfigShape, RuntimeBus>;
}

export function buildRuntime(
  options: BuildRuntimeOptions = {},
): Promise<Runtime<RuntimeConfigShape, RuntimeInfraShape, RuntimeBus, RuntimeTransportShape>> {
  if (getImportScope(resolveCallerFilePath(buildRuntime))) {
    return Promise.reject(
      new Error("DISPATCHKIT_REENTRANT_BUILD: Cannot build a runtime during module evaluation"),
    );
  }
  return runtimeGlobalState.buildContextStorage.run({}, () => buildRuntimeImpl(options));
}

async function buildRuntimeImpl(
  options: BuildRuntimeOptions,
): Promise<Runtime<RuntimeConfigShape, RuntimeInfraShape, RuntimeBus, RuntimeTransportShape>> {
  const lifecycle = createLifecycle();
  let runtimeRef: InternalRuntime | undefined;
  try {
    const rootDir = options.rootDir ? resolve(options.rootDir) : process.cwd();
    const srcDir = options.srcDir ? resolve(rootDir, options.srcDir) : join(rootDir, "src");
    runtimeGlobalState.buildContextStorage.getStore()!.srcDir = srcDir;
    const generatedDir = options.generatedDir
      ? resolve(rootDir, options.generatedDir)
      : join(srcDir, "generated", "runtime");
    const envFile = options.envFile ? resolve(rootDir, options.envFile) : join(rootDir, ".env");

    const config = await resolveRuntimeConfig({
      rootDir,
      srcDir,
      envFile,
      overrides: extractConfigOverrides(options),
    });
    const { logger, runtimeConsole } = await resolveLogger({ srcDir, config });
    const discovery = await discoverForArtifacts(srcDir);
    const loadedOperations = await loadOperationDefinitions(srcDir, discovery);
    const instance: InternalRuntime = {
      config,
      logger,
      infra: Object.create(null),
      bus: {
        query: Object.create(null),
        mutation: Object.create(null),
        action: Object.create(null),
      },
      transport: Object.create(null),
      dispose() {
        runtimeGlobalState.disposedRuntimes.add(instance);
        if (runtimeGlobalState.activeRuntime === instance) {
          runtimeGlobalState.activeRuntime = undefined;
          runtimeGlobalState.activeTransportCtxAccessGuard = undefined;
          if ((globalThis as any).runtime === instance) delete (globalThis as any).runtime;
          mountGlobalConsole(runtimeGlobalState.baseConsole);
        }
        return lifecycle.dispose();
      },
    };
    runtimeRef = instance;
    instance.bus = buildBus(loadedOperations, () => instance);
    const moduleCtx: ModuleContext<RuntimeConfig, Record<string, unknown>, RuntimeBusBase> = {
      config,
      logger,
      infra: instance.infra,
      bus: instance.bus,
    };
    const infraResult = await loadInfraModules({
      srcDir,
      discovery,
      ctx: moduleCtx,
      onDispose: lifecycle.onDispose,
    });
    instance.infra = infraResult.infra;
    moduleCtx.infra = instance.infra;
    runtimeGlobalState.buildContextStorage.getStore()!.runtime = instance;
    const transportCtx: TransportFactoryContext<RuntimeConfig, RuntimeBusBase> = {
      config,
      logger,
      bus: instance.bus,
      onDispose: lifecycle.onDispose,
    };
    const transportModules = [...discovery.transport, ...infraResult.transportFromInfra].sort(
      (left, right) =>
        left.key.localeCompare(right.key) ||
        left.source.localeCompare(right.source) ||
        left.filePath.localeCompare(right.filePath),
    );
    // Validate collisions before starting any transport resources.
    const transportKeys = new Set<string>();
    for (const module of transportModules) {
      if (transportKeys.has(module.key))
        throw new Error(
          `DISPATCHKIT_TRANSPORT_KEY_COLLISION: Duplicate transport key "${module.key}"`,
        );
      transportKeys.add(module.key);
    }
    const transportLoad = await loadTransportModules({
      srcDir,
      transportModules,
      ctx: transportCtx,
    });
    instance.transport = transportLoad.transport;
    if (options.generateArtifacts !== false) {
      mkdirSync(generatedDir, { recursive: true });
      await generateArtifacts({
        srcDir,
        generatedDir,
        discovery: {
          ...discovery,
          infra: discovery.infra.filter(
            (file) => !infraResult.transportFromInfra.some((module) => module.filePath === file),
          ),
          transport: transportModules,
        },
      });
    }
    if (options.mountGlobal !== false) {
      mountGlobalConsole(runtimeConsole);
      runtimeGlobalState.activeRuntime = instance;
      runtimeGlobalState.activeTransportCtxAccessGuard = transportLoad.guard;
      (globalThis as typeof globalThis & { runtime: unknown }).runtime = instance as any;
    }
    return instance as unknown as Runtime<
      RuntimeConfigShape,
      RuntimeInfraShape,
      RuntimeBus,
      RuntimeTransportShape
    >;
  } catch (error) {
    if (runtimeRef) runtimeGlobalState.disposedRuntimes.add(runtimeRef);
    try {
      await lifecycle.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "DISPATCHKIT_BUILD_FAILED: Initialization and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}
