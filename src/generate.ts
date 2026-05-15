import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverRuntimeFiles, resolveTransportKey } from "./discovery.ts";
import { generateArtifacts } from "./typegen.ts";
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

function detectDefineBindingNames(
  source: string,
  factoryName: "defineInfra" | "defineTransport",
): Set<string> {
  const names = new Set<string>();
  const pattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${factoryName}\\s*\\(`,
    "g",
  );

  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }

  return names;
}

function classifyInfraModuleSource(
  source: string,
): "infra" | "transport" | "unknown" {
  if (/\bexport\s+default\s+defineTransport\s*\(/m.test(source)) {
    return "transport";
  }
  if (/\bexport\s+default\s+defineInfra\s*\(/m.test(source)) {
    return "infra";
  }

  const transportBindings = detectDefineBindingNames(source, "defineTransport");
  const infraBindings = detectDefineBindingNames(source, "defineInfra");
  const defaultExportMatch = source.match(
    /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/m,
  );
  const exportedBinding = defaultExportMatch?.[1];

  if (!exportedBinding) {
    return "unknown";
  }
  if (transportBindings.has(exportedBinding)) {
    return "transport";
  }
  if (infraBindings.has(exportedBinding)) {
    return "infra";
  }

  return "unknown";
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

  for (const filePath of options.infraFiles) {
    const absolutePath = join(options.srcDir, "infra", filePath);
    const source = await Bun.file(absolutePath).text();
    const classification = classifyInfraModuleSource(source);

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

async function discoverForArtifacts(srcDir: string): Promise<DiscoveryResult> {
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
    ? resolve(options.srcDir)
    : join(rootDir, "src");
  const generatedDir = options.generatedDir
    ? resolve(options.generatedDir)
    : join(srcDir, "generated", "runtime");

  return { rootDir, srcDir, generatedDir };
}

async function collectWatchFingerprint(srcDir: string): Promise<string> {
  const files = new Set<string>();
  const patterns = [
    "modules/**/*.ts",
    "infra/**/*.ts",
    "transport/**/*.ts",
    "config.ts",
    "logger.ts",
  ];

  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: srcDir })) {
      if (path.endsWith(".d.ts")) {
        continue;
      }
      files.add(normalizeSeparators(path));
    }
  }

  const rows = [...files].sort((left, right) => left.localeCompare(right));
  const fingerprintRows: string[] = [];

  for (const relativePath of rows) {
    const absolutePath = join(srcDir, relativePath);
    try {
      const stat = statSync(absolutePath);
      fingerprintRows.push(
        `${relativePath}:${stat.size}:${Math.floor(stat.mtimeMs)}:${Math.floor(stat.ctimeMs)}`,
      );
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
  const onInfo = options.onInfo ?? (() => { });
  const onError = options.onError ?? (() => { });

  const initial = await generateRuntime(options);
  onInfo(
    `[dispatchkit] generated runtime artifacts: ${initial.discovery.operations.length} ops, ${initial.discovery.infra.length} infra modules, ${initial.discovery.transport.length} transport modules`,
  );
  onInfo(`[dispatchkit] watching ${initial.srcDir} every ${intervalMs}ms`);

  let lastFingerprint = await collectWatchFingerprint(initial.srcDir);
  let isGenerating = false;
  const timer = setInterval(async () => {
    if (isGenerating) {
      return;
    }

    try {
      const nextFingerprint = await collectWatchFingerprint(initial.srcDir);
      if (nextFingerprint === lastFingerprint) {
        return;
      }

      isGenerating = true;
      const next = await generateRuntime(options);
      lastFingerprint = await collectWatchFingerprint(next.srcDir);
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
