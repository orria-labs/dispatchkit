import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { discoverRuntimeFiles, resolveTransportKey } from "./discovery.ts";
import { generateArtifacts } from "./typegen.ts";
import { createModuleClassifier } from "./classify.ts";
import type {
  DiscoveredTransport,
  DiscoveryResult,
  TransportSource,
} from "./types.ts";

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
  intervalMs?: number;
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
  const allTransport = sortTransport([
    ...discovery.transport,
    ...transportModules,
  ]);
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
  const srcDir = options.srcDir
    ? resolve(rootDir, options.srcDir)
    : join(rootDir, "src");
  const generatedDir = options.generatedDir
    ? resolve(rootDir, options.generatedDir)
    : join(srcDir, "generated", "runtime");

  return { rootDir, srcDir, generatedDir };
}

async function collectWatchFingerprint(srcDir: string, generatedDir: string): Promise<string> {
  if (!existsSync(srcDir)) return "";
  const files = new Set<string>();
  for await (const path of new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}").scan({ cwd: srcDir })) {
    const normalized = normalizeSeparators(path);
    const fromGenerated = normalizeSeparators(relative(generatedDir, join(srcDir, path)));
    if (/\.d\.(?:ts|mts|cts)$/.test(normalized)
      || normalized.split("/").some((part) => part === "node_modules" || part === ".git")
      || (fromGenerated !== ".." && !fromGenerated.startsWith("../") && !isAbsolute(fromGenerated))) continue;
    files.add(normalized);
  }

  const rows = [...files].sort((left, right) => left.localeCompare(right));
  const fingerprintRows: string[] = [];

  for (const relativePath of rows) {
    const absolutePath = join(srcDir, relativePath);
    try {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(await Bun.file(absolutePath).arrayBuffer());
      fingerprintRows.push(JSON.stringify([relativePath, hasher.digest("hex")]));
    } catch {
      fingerprintRows.push(`${relativePath}:deleted`);
    }
  }

  return fingerprintRows.join("\n");
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

export async function watchRuntime(
  options: WatchRuntimeOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 400;
  if (!Number.isFinite(intervalMs) || intervalMs < 50) {
    throw new Error("DISPATCHKIT_WATCH_INVALID_INTERVAL: intervalMs must be a number >= 50");
  }
  const onInfo = options.onInfo ?? (() => { });
  const onError = options.onError ?? (() => { });

  const paths = resolvePaths(options);
  let lastFingerprint = await collectWatchFingerprint(paths.srcDir, paths.generatedDir);
  const initial = await generateRuntime(options);
  onInfo(
    `[dispatchkit] generated runtime artifacts: ${initial.discovery.operations.length} ops, ${initial.discovery.infra.length} infra modules, ${initial.discovery.transport.length} transport modules`,
  );
  onInfo(`[dispatchkit] watching ${initial.srcDir} every ${intervalMs}ms`);

  let isGenerating = false;
  const timer = setInterval(async () => {
    if (isGenerating) {
      return;
    }

    isGenerating = true;
    try {
      const nextFingerprint = await collectWatchFingerprint(initial.srcDir, initial.generatedDir);
      if (nextFingerprint === lastFingerprint) {
        return;
      }

      const next = await generateRuntime(options);
      lastFingerprint = nextFingerprint;
      onInfo(
        `[dispatchkit] regenerated runtime artifacts: ${next.discovery.operations.length} ops, ${next.discovery.infra.length} infra modules, ${next.discovery.transport.length} transport modules`,
      );
    } catch (error) {
      onError(error);
    } finally {
      isGenerating = false;
    }
  }, intervalMs);

  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
