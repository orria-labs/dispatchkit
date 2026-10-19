import { mkdirSync, watch } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { createModuleClassifier } from "./classify.ts";
import { discoverRuntimeFiles, resolveTransportKey } from "./discovery.ts";
import { generateArtifacts } from "./typegen.ts";
import type { DiscoveredTransport, DiscoveryResult, TransportSource } from "./types.ts";

export interface GenerateRuntimeOptions {
  rootDir?: string;
  srcDir?: string;
  generatedDir?: string;
}

export interface GenerateRuntimeResult {
  rootDir: string;
  srcDir: string;
  generatedDir: string;
  discovery: DiscoveryResult;
}

export interface WatchRuntimeOptions extends GenerateRuntimeOptions {
  /** Delay after the last file change before regenerating. Defaults to 100ms. */
  debounceMs?: number;
  /**
   * @deprecated Watching is event-based now; used as `debounceMs` when that is not set.
   * Must be >= 50 when provided.
   */
  intervalMs?: number;
  /** Stops watching when aborted. SIGINT/SIGTERM also stop it. */
  signal?: AbortSignal;
  onInfo?: (message: string) => void;
  onError?: (error: unknown) => void;
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function sortTransport(modules: DiscoveredTransport[]): DiscoveredTransport[] {
  return [...modules].sort(
    (left, right) =>
      left.key.localeCompare(right.key) ||
      left.source.localeCompare(right.source) ||
      left.filePath.localeCompare(right.filePath),
  );
}

async function discoverTransportFromInfra(options: {
  srcDir: string;
  infraFiles: string[];
}): Promise<{
  infraModules: string[];
  transportModules: DiscoveredTransport[];
}> {
  const infraModules: string[] = [];
  const transportModules: DiscoveredTransport[] = [];
  const classify = createModuleClassifier();

  for (const filePath of options.infraFiles) {
    const absolutePath = join(options.srcDir, "infra", filePath);
    const classification = await classify(absolutePath);

    if (classification === "transport") {
      transportModules.push({
        key: resolveTransportKey(filePath),
        filePath,
        source: "infra" satisfies TransportSource,
      });
      continue;
    }

    infraModules.push(filePath);
  }

  return { infraModules, transportModules };
}

function assertTransportNoCollisions(modules: DiscoveredTransport[]): void {
  const keyToModule = new Map<string, DiscoveredTransport>();

  for (const module of modules) {
    const existing = keyToModule.get(module.key);
    if (existing) {
      throw new Error(
        `DISPATCHKIT_DISCOVERY_TRANSPORT_COLLISION: Transport key "${module.key}" collides between "${existing.filePath}" (${existing.source}) and "${module.filePath}" (${module.source})`,
      );
    }
    keyToModule.set(module.key, module);
  }
}

export async function discoverForArtifacts(srcDir: string): Promise<DiscoveryResult> {
  const discovery = await discoverRuntimeFiles(srcDir);
  const { infraModules, transportModules } = await discoverTransportFromInfra({
    srcDir,
    infraFiles: discovery.infra,
  });
  const allTransport = sortTransport([...discovery.transport, ...transportModules]);
  assertTransportNoCollisions(allTransport);

  return {
    ...discovery,
    infra: infraModules,
    transport: allTransport,
  };
}

function resolvePaths(options: GenerateRuntimeOptions): {
  rootDir: string;
  srcDir: string;
  generatedDir: string;
} {
  const rootDir = options.rootDir ? resolve(options.rootDir) : process.cwd();
  const srcDir = options.srcDir ? resolve(rootDir, options.srcDir) : join(rootDir, "src");
  const generatedDir = options.generatedDir
    ? resolve(rootDir, options.generatedDir)
    : join(srcDir, "generated", "runtime");

  return { rootDir, srcDir, generatedDir };
}

const WATCHED_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/;

/**
 * Whether a change under `srcDir` can affect discovery or generated types: any source file
 * (classification follows local imports), plus extensionless paths, which may be directories
 * being renamed or removed. Declarations, dependencies and the artifacts themselves are ignored.
 */
function isWatchedChange(srcDir: string, generatedDir: string, fileName: string): boolean {
  const normalized = normalizeSeparators(fileName);
  if (normalized.split("/").some((part) => part === "node_modules" || part === ".git")) {
    return false;
  }
  const fromGenerated = normalizeSeparators(relative(generatedDir, join(srcDir, fileName)));
  if (fromGenerated !== ".." && !fromGenerated.startsWith("../") && !isAbsolute(fromGenerated)) {
    return false;
  }
  if (DECLARATION_FILE.test(normalized)) return false;
  return WATCHED_EXTENSION.test(normalized) || !/\.[^/]+$/.test(normalized);
}

export async function generateRuntime(
  options: GenerateRuntimeOptions = {},
): Promise<GenerateRuntimeResult> {
  const { rootDir, srcDir, generatedDir } = resolvePaths(options);
  mkdirSync(generatedDir, { recursive: true });

  const discovery = await discoverForArtifacts(srcDir);
  await generateArtifacts({
    srcDir,
    generatedDir,
    discovery,
  });

  return {
    rootDir,
    srcDir,
    generatedDir,
    discovery,
  };
}

export async function watchRuntime(options: WatchRuntimeOptions = {}): Promise<void> {
  if (
    options.intervalMs !== undefined &&
    (!Number.isFinite(options.intervalMs) || options.intervalMs < 50)
  ) {
    throw new Error("DISPATCHKIT_WATCH_INVALID_INTERVAL: intervalMs must be a number >= 50");
  }
  const debounceMs = options.debounceMs ?? options.intervalMs ?? 100;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new Error("DISPATCHKIT_WATCH_INVALID_INTERVAL: debounceMs must be a number >= 0");
  }
  const onInfo = options.onInfo ?? (() => {});
  const onError = options.onError ?? (() => {});
  const describe = (result: GenerateRuntimeResult) =>
    `${result.discovery.operations.length} ops, ${result.discovery.infra.length} infra modules, ${result.discovery.transport.length} transport modules`;

  const initial = await generateRuntime(options);
  onInfo(`[dispatchkit] generated runtime artifacts: ${describe(initial)}`);
  mkdirSync(initial.srcDir, { recursive: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  const regenerate = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const next = await generateRuntime(options);
      onInfo(`[dispatchkit] regenerated runtime artifacts: ${describe(next)}`);
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void regenerate();
      }
    }
  };

  // Event-based: no polling and no re-hashing of every source file while idle.
  const watcher = watch(initial.srcDir, { recursive: true }, (_event, fileName) => {
    // Some platforms omit the file name: regenerate to be safe.
    if (fileName && !isWatchedChange(initial.srcDir, initial.generatedDir, String(fileName))) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void regenerate(), debounceMs);
  });
  watcher.on("error", onError);
  onInfo(`[dispatchkit] watching ${initial.srcDir} (debounce ${debounceMs}ms)`);

  await new Promise<void>((resolve) => {
    const { signal } = options;
    const stop = () => {
      clearTimeout(timer);
      watcher.close();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    if (signal?.aborted) return stop();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    signal?.addEventListener("abort", stop);
  });
}
