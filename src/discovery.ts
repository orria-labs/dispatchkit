import { existsSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import type {
  DiscoveredOperation,
  DiscoveredTransport,
  DiscoveryResult,
  OperationKind,
  TransportSource,
} from "./types.ts";

const MODULE_SUFFIX_PATTERN = /\.(query|mutation|action)\.ts$/;
const NON_ALNUM = /[^a-zA-Z0-9]+/g;

const normalizeSeparators = (value: string) => value.replace(/\\/g, "/");

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function toCamelSegment(input: string): string {
  const parts = input
    .replace(NON_ALNUM, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error(`XPR_DISCOVERY_INVALID_SEGMENT: Cannot derive segment from "${input}"`);
  }

  return parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : `${lower[0]?.toUpperCase() ?? ""}${lower.slice(1)}`;
    })
    .join("");
}

function joinCamelSegments(segments: string[]): string {
  if (segments.length === 0) {
    throw new Error("XPR_DISCOVERY_INVALID_NAME: Empty operation path");
  }

  return segments
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }
      return `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`;
    })
    .join("");
}

export function resolveOperationName(relativeModulePath: string): {
  name: string;
  segments: string[];
  kind: OperationKind;
} {
  const normalized = normalizeSeparators(relativeModulePath);
  const match = normalized.match(MODULE_SUFFIX_PATTERN);

  if (!match) {
    throw new Error(
      `XPR_DISCOVERY_INVALID_OPERATION_FILE: "${relativeModulePath}" is not *.query.ts|*.mutation.ts|*.action.ts`,
    );
  }

  const kind = match[1] as OperationKind;
  const withoutSuffix = normalized.slice(0, -`.${kind}.ts`.length);
  const rawSegments = withoutSuffix.split("/").filter(Boolean);
  const segments = rawSegments.map(toCamelSegment);
  const name = joinCamelSegments(segments);

  return { name, segments, kind };
}

export function resolveTransportKey(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.endsWith("/index.ts")) {
    return dirname(normalized).split("/").filter(Boolean).at(-1) ?? "index";
  }

  return basename(normalized).replace(/\.ts$/, "");
}

export function normalizeRelativePath(fromRoot: string): string {
  return normalizeSeparators(posix.normalize(normalizeSeparators(fromRoot))).replace(/^\.\//, "");
}

async function scanPattern(cwd: string, pattern: string): Promise<string[]> {
  if (!existsSync(cwd)) {
    return [];
  }

  const results: string[] = [];
  for await (const path of new Bun.Glob(pattern).scan({ cwd })) {
    if (path.endsWith(".d.ts")) continue;
    results.push(normalizeRelativePath(path));
  }
  return results;
}

async function discoverModuleOperations(modulesDir: string): Promise<DiscoveredOperation[]> {
  const [queries, mutations, actions] = await Promise.all([
    scanPattern(modulesDir, "**/*.query.ts"),
    scanPattern(modulesDir, "**/*.mutation.ts"),
    scanPattern(modulesDir, "**/*.action.ts"),
  ]);

  const files = sortUnique([...queries, ...mutations, ...actions]);
  const operations: DiscoveredOperation[] = [];
  const nameToPath = new Map<string, string>();

  for (const filePath of files) {
    const { name, segments, kind } = resolveOperationName(filePath);
    const collisionKey = `${kind}:${name}`;
    const existing = nameToPath.get(collisionKey);

    if (existing) {
      throw new Error(
        `XPR_DISCOVERY_NAME_COLLISION: Operation name "${name}" collides between "${existing}" and "${filePath}" in kind "${kind}"`,
      );
    }

    nameToPath.set(collisionKey, filePath);
    operations.push({
      kind,
      filePath,
      operationName: name,
      operationSegments: segments,
    });
  }

  return operations;
}

function isRootTs(relativePath: string): boolean {
  return !relativePath.includes("/") && relativePath.endsWith(".ts");
}

function isNestedIndex(relativePath: string): boolean {
  return relativePath.endsWith("/index.ts");
}

async function discoverLayerModules(layerDir: string): Promise<string[]> {
  const files = await scanPattern(layerDir, "**/*.ts");
  return sortUnique(files.filter((file) => isRootTs(file) || isNestedIndex(file)));
}

async function hasFile(filePath: string): Promise<boolean> {
  return (await Bun.file(filePath).exists()) && basename(filePath) !== "";
}

function toDiscoveredTransport(files: string[], source: TransportSource): DiscoveredTransport[] {
  const keys = new Map<string, string>();
  const transport: DiscoveredTransport[] = [];

  for (const filePath of files) {
    const key = resolveTransportKey(filePath);
    const existing = keys.get(key);
    if (existing) {
      throw new Error(
        `XPR_DISCOVERY_TRANSPORT_COLLISION: Transport key "${key}" collides between "${existing}" and "${filePath}"`,
      );
    }
    keys.set(key, filePath);
    transport.push({ key, filePath, source });
  }

  return transport;
}

export async function discoverRuntimeFiles(srcDir: string): Promise<DiscoveryResult> {
  const modulesDir = join(srcDir, "modules");
  const infraDir = join(srcDir, "infra");
  const transportDir = join(srcDir, "transport");

  const [operations, infra, transport, configExists, loggerExists] = await Promise.all([
    discoverModuleOperations(modulesDir),
    discoverLayerModules(infraDir),
    discoverLayerModules(transportDir),
    hasFile(join(srcDir, "config.ts")),
    hasFile(join(srcDir, "logger.ts")),
  ]);

  return {
    operations,
    infra,
    transport: toDiscoveredTransport(transport, "transport"),
    configPath: configExists ? "config.ts" : undefined,
    loggerPath: loggerExists ? "logger.ts" : undefined,
  };
}

export function toSourceFileFromRelative(srcDir: string, relativePath: string): string {
  return join(srcDir, normalizeRelativePath(relativePath));
}
