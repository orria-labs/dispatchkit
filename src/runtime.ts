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
import {
  assertStandardSchema,
  runSchema,
  StandardSchemaError,
  validateSchema,
} from "./validation.ts";

type RuntimeConfig = RuntimeDefaultConfig & Record<string, unknown>;
type InternalRuntime = Runtime<
  RuntimeConfig,
  Record<string, unknown>,
  RuntimeBusBase,
  Record<string, unknown>
>;

type InternalModuleCtx = ModuleContext<RuntimeConfig, Record<string, unknown>, RuntimeBusBase>;
type InternalTransportCtx = TransportContext<RuntimeConfig, RuntimeBusBase>;

/** Active module context plus the executing operation (absent inside infra factories). */
type ModuleScope = { ctx: InternalModuleCtx; kind?: OperationKind; name?: string };
/** Active transport context with the allowlist that applies to it. */
type TransportScope = { ctx: InternalTransportCtx; guard: TransportCtxAccessGuard | undefined };

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
  /** Allow/deny verdict per caller file: glob matching runs once per file. */
  verdicts: Map<string, boolean>;
};

type TransportCtxModuleRef = {
  key: string;
  filePath: string;
  source: TransportSource;
};

// One store per scope keeps every bus call and transport access to a single `run()`.
const moduleScopeStorage = new AsyncLocalStorage<ModuleScope>();
const transportScopeStorage = new AsyncLocalStorage<TransportScope>();
type BuildScope = { runtime?: InternalRuntime; srcDir?: string };
type ImportScope = {
  build?: BuildScope;
  module?: InternalModuleCtx;
  transport?: InternalTransportCtx;
  guard?: TransportCtxAccessGuard;
};
const buildContextStorage = new AsyncLocalStorage<BuildScope>();
const disposedRuntimes = new WeakSet<InternalRuntime>();
const RUNTIME_GLOBAL_STATE_KEY = Symbol.for("dispatchkit.runtime.globalState.v3");

type RuntimeGlobalState = {
  baseConsole: ConsoleLike;
  importQueue: Promise<void>;
  importScope: ImportScope | undefined;
  transportOriginals: WeakMap<object, object>;
  moduleScopeStorage: typeof moduleScopeStorage;
  transportScopeStorage: typeof transportScopeStorage;
  physicalPaths: Map<string, string>;
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
      moduleScopeStorage,
      transportScopeStorage,
      physicalPaths: new Map(),
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

/** Real path (symlinks resolved), cached: stack-based checks would otherwise hit the fs per call. */
function resolvePhysicalPath(value: string): string {
  const cache = runtimeGlobalState.physicalPaths;
  let physical = cache.get(value);
  if (physical === undefined) {
    try {
      physical = realpathSync(value);
    } catch {
      // Not on disk (yet): resolve lexically and retry on the next lookup.
      return resolve(value);
    }
    cache.set(value, physical);
  }
  return physical;
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
    verdicts: new Map(),
  };
}

/**
 * `    at fn (/path/file.ts:1:2)` or `    at /path/file.ts:1:2` -> `/path/file.ts`.
 * The location must start like a path, so parentheses inside paths (`app/(group)/x.ts`) are kept.
 */
const STACK_LOCATION = /^\s*at (?:.*? \()?((?:file:\/\/|[A-Za-z]:[\\/]|\/).*?)(?::\d+:\d+)?\)?$/;

/**
 * File of the first stack frame outside this module. Parses the default string stack: faster
 * than structured call sites, and independent of custom `Error.prepareStackTrace` formatters.
 * Note: proper tail calls (`return getTransportCtx()`) drop the caller frame in JSC.
 */
function resolveCallerFilePath(skipper: (...args: never[]) => unknown): string | undefined {
  const stackTraceLimit = Error.stackTraceLimit;
  const prepareStackTrace: unknown = Reflect.get(Error, "prepareStackTrace");
  const holder: { stack?: unknown } = {};
  try {
    Error.stackTraceLimit = 10;
    Reflect.set(Error, "prepareStackTrace", undefined);
    Error.captureStackTrace(holder, skipper);
  } catch {
    return undefined;
  } finally {
    Error.stackTraceLimit = stackTraceLimit;
    Reflect.set(Error, "prepareStackTrace", prepareStackTrace);
  }
  if (typeof holder.stack !== "string") return undefined;

  for (const line of holder.stack.split("\n").slice(1)) {
    const location = STACK_LOCATION.exec(line)?.[1];
    if (!location) continue;
    const filePath = location.startsWith("file://") ? fileURLToPath(location) : location;
    if (normalizeSeparators(filePath) !== RUNTIME_FILE_PATH) return filePath;
  }
  return undefined;
}

function isTransportCtxCallAllowed(options: {
  guard: TransportCtxAccessGuard;
  callerFilePath: string | undefined;
}): boolean {
  const { guard, callerFilePath } = options;
  if (!callerFilePath) {
    return true;
  }

  const cached = guard.verdicts.get(callerFilePath);
  if (cached !== undefined) return cached;

  const normalizedRelative = normalizeSeparators(
    relative(guard.srcDir, resolvePhysicalPath(callerFilePath)),
  );
  const allowed =
    normalizedRelative !== ".." &&
    !normalizedRelative.startsWith("../") &&
    !normalizedRelative.startsWith("..\\") &&
    guard.globs.some((glob) => glob.match(normalizedRelative));
  guard.verdicts.set(callerFilePath, allowed);
  return allowed;
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
    module: runtimeGlobalState.moduleScopeStorage.getStore()?.ctx,
    transport: runtimeGlobalState.transportScopeStorage.getStore()?.ctx,
    guard: runtimeGlobalState.transportScopeStorage.getStore()?.guard,
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

  const threshold = logLevel === "silent" ? -1 : LOG_LEVELS.indexOf(logLevel);
  const noop = () => {};

  // Enabled levels write straight to the sink; disabled ones are no-ops (no per-call checks).
  const makeMethod = (level: LogLevel, method: keyof ConsoleLike) => {
    if (LOG_LEVELS.indexOf(level) > threshold) return noop;
    const sink = (fallbackConsole[method] ?? fallbackConsole.log).bind(fallbackConsole);
    return (...args: unknown[]) => {
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

const CALLABLE: Record<OperationKind, ReadonlySet<OperationKind>> = {
  query: new Set(["query"]),
  mutation: new Set(["query", "mutation"]),
  action: new Set(["query", "mutation", "action"]),
};

function createBusMethod(options: {
  operation: LoadedOperation;
  ctx: InternalModuleCtx;
  getRuntime: () => InternalRuntime;
}): BusMethod<any, any> {
  const { operation, ctx, getRuntime } = options;
  const { definition, kind, name } = operation;
  // Prebuilt once per operation: a bus call is a single ALS run with no per-call allocations
  // besides the handler context.
  const scope: ModuleScope = { ctx, kind, name };
  const handler = definition.handler as (ctx: unknown) => unknown;

  const validate = (
    schema: StandardSchemaV1,
    value: unknown,
    phase: "input" | "return",
  ): unknown => {
    const fail = (cause: unknown): never => {
      throw wrapValidationError({ operation: name, phase, cause });
    };
    let result: unknown;
    try {
      result = runSchema(schema, value);
    } catch (cause) {
      fail(cause);
    }
    return result instanceof Promise ? result.catch(fail) : result;
  };

  // Validation runs inside the operation scope so validators see the CQRS caller.
  const runOperation = async (rawInput: unknown, unsafe: boolean): Promise<unknown> => {
    let input = rawInput;
    if (!unsafe && definition.input) {
      input = validate(definition.input, rawInput, "input");
      if (input instanceof Promise) input = await input;
    }
    const result = await handler({ ...ctx, input });
    return !unsafe && definition.return ? validate(definition.return, result, "return") : result;
  };

  // Not async: guard failures are returned as rejections, saving one promise layer per call.
  const execute = (rawInput: unknown, unsafe: boolean): Promise<unknown> => {
    const caller = runtimeGlobalState.moduleScopeStorage.getStore();
    if (caller?.kind && !CALLABLE[caller.kind].has(kind)) {
      return Promise.reject(
        new Error(
          `DISPATCHKIT_CQRS_GUARD: ${caller.kind} "${caller.name}" cannot call ${kind} "${name}"`,
        ),
      );
    }
    if (runtimeGlobalState.disposedRuntimes.has(getRuntime())) {
      return Promise.reject(
        new Error("DISPATCHKIT_RUNTIME_DISPOSED: Cannot execute operations after disposal"),
      );
    }
    return runtimeGlobalState.moduleScopeStorage.run(scope, runOperation, rawInput, unsafe);
  };

  const call = ((input: unknown) => execute(input, false)) as BusMethod<any, any>;
  call.$unsafe = (input: unknown) => execute(input, true);
  call.$input = definition.input;
  call.$return = definition.return;
  return call;
}

/** Native consumers read internal slots directly: HTTP bodies, binary data, web primitives. */
function isNativeValue(input: object): boolean {
  return (
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
  );
}

/** Descriptor of `key` on the prototype chain of `target` (own properties excluded). */
function findInheritedDescriptor(target: object, key: PropertyKey): PropertyDescriptor | undefined {
  for (
    let current = Reflect.getPrototypeOf(target);
    current !== null;
    current = Reflect.getPrototypeOf(current)
  ) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

function wrapTransportWithContext(value: unknown, scope: TransportScope): unknown {
  const wrappers = new WeakMap<object, object>();
  const originals = runtimeGlobalState.transportOriginals;
  const storage = runtimeGlobalState.transportScopeStorage;
  const isObject = (input: unknown): input is object =>
    input !== null && (typeof input === "object" || typeof input === "function");
  const unwrap = (input: unknown): unknown =>
    isObject(input) ? (originals.get(input) ?? input) : input;
  const unwrapArgs = (args: unknown[]): unknown[] =>
    args.some((arg) => isObject(arg) && originals.has(arg)) ? args.map((arg) => unwrap(arg)) : args;
  const run = <T>(callback: () => T): T => storage.run(scope, callback);

  const wrap = (input: unknown): unknown => {
    if (!isObject(input)) return input;
    // Cache hits first: a method access must not pay for the native-type checks every time.
    const existing = wrappers.get(input);
    if (existing) return existing;
    if (originals.has(input) || (typeof input === "object" && isNativeValue(input))) return input;

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
        // Data properties (own or inherited, e.g. class methods) need no context to be read:
        // skip the scope switch and only pay it for accessors, which may run user code.
        const own = Reflect.getOwnPropertyDescriptor(target, key);
        if (own) {
          if ("value" in own) {
            // Proxy invariants require the exact value of a frozen own property.
            if (!own.configurable && !own.writable) return own.value as unknown;
            return key === "constructor" ? (own.value as unknown) : wrap(own.value);
          }
        } else {
          const inherited = findInheritedDescriptor(target, key);
          if (inherited && "value" in inherited) {
            return key === "constructor" ? (inherited.value as unknown) : wrap(inherited.value);
          }
        }
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
              unwrapArgs(args),
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
                unwrapArgs(args),
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
    const result = await runtimeGlobalState.moduleScopeStorage.run({ ctx: options.ctx }, () =>
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
    const definition = (await runtimeGlobalState.transportScopeStorage.run(
      { ctx: options.ctx, guard: undefined },
      () => importDefault(absolute),
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

    const scope: TransportScope = { ctx: transportCtx, guard: moduleGuard };
    const result = await runtimeGlobalState.transportScopeStorage.run(scope, () =>
      Promise.resolve(definition.factory(transportCtx)),
    );
    if (Object.hasOwn(transport, module.key)) {
      throw new Error(
        `DISPATCHKIT_TRANSPORT_KEY_COLLISION: Duplicate transport key "${module.key}"`,
      );
    }

    transport[module.key] = wrapTransportWithContext(result, scope);
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
  ctx: InternalModuleCtx,
  getRuntime: () => InternalRuntime,
): RuntimeBusBase {
  const bus: RuntimeBusBase = {
    query: Object.create(null),
    mutation: Object.create(null),
    action: Object.create(null),
  };

  for (const operation of operations) {
    const method = createBusMethod({ operation, ctx, getRuntime });
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
  const stored = runtimeGlobalState.moduleScopeStorage.getStore()?.ctx;
  if (stored)
    return stored as unknown as ModuleContext<RuntimeConfigShape, RuntimeInfraShape, RuntimeBus>;
  // The caller only matters while application modules are being imported (or for errors).
  const callerFilePath = runtimeGlobalState.importScope
    ? resolveCallerFilePath(getModuleCtx)
    : undefined;
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
      where: toDisplayPath(callerFilePath ?? resolveCallerFilePath(getModuleCtx)),
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
  const stored = runtimeGlobalState.transportScopeStorage.getStore();
  // Stack inspection is the expensive part: only done for import scopes, allowlists and errors.
  let callerFilePath =
    !stored && runtimeGlobalState.importScope ? resolveCallerFilePath(getTransportCtx) : undefined;
  const imported = stored ? undefined : getImportScope(callerFilePath);
  const current = stored?.ctx ?? imported?.transport;
  const pending = runtimeGlobalState.buildContextStorage.getStore() ?? imported?.build;
  const guard = stored
    ? stored.guard
    : imported
      ? imported.guard
      : pending
        ? undefined
        : runtimeGlobalState.activeTransportCtxAccessGuard;

  if (guard) {
    callerFilePath ??= resolveCallerFilePath(getTransportCtx);
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
      where: toDisplayPath(callerFilePath ?? resolveCallerFilePath(getTransportCtx)),
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
  if (runtimeGlobalState.importScope && getImportScope(resolveCallerFilePath(buildRuntime))) {
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
    const moduleCtx: InternalModuleCtx = {
      config,
      logger,
      infra: instance.infra,
      bus: instance.bus,
    };
    instance.bus = buildBus(loadedOperations, moduleCtx, () => instance);
    moduleCtx.bus = instance.bus;
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
