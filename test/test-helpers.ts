import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(testDir, "..");
export const runtimeImport = join(repoRoot, "src", "index.ts").replace(/\\/g, "/");
export const cliEntry = join(repoRoot, "src", "cli.ts");

export type FileMap = Record<string, string>;

export function writeProjectFiles(rootDir: string, files: FileMap): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(rootDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

export function createTempProject(files: FileMap): string {
  const rootDir = mkdtempSync(join(tmpdir(), "dispatchkit-test-"));

  writeProjectFiles(rootDir, {
    "package.json": JSON.stringify({
      name: "dispatchkit-test-service",
      description: "runtime test",
      version: "1.2.3",
    }),
    ...files,
  });

  const sourceNodeModules = join(repoRoot, "node_modules");
  const targetNodeModules = join(rootDir, "node_modules");
  if (!existsSync(targetNodeModules) && existsSync(sourceNodeModules)) {
    symlinkSync(sourceNodeModules, targetNodeModules, "dir");
  }

  return rootDir;
}

export function cleanupTempProject(rootDir: string): void {
  rmSync(rootDir, { recursive: true, force: true });
}

export async function withTempProject<T>(
  files: FileMap,
  run: (rootDir: string) => Promise<T>,
): Promise<T> {
  const rootDir = createTempProject(files);
  try {
    return await run(rootDir);
  } finally {
    cleanupTempProject(rootDir);
  }
}

export function dispatchkitImportLine(): string {
  return `import { defineAction, defineConfig, defineInfra, defineLogger, defineMutation, defineQuery, defineTransport, getModuleCtx, getTransportCtx } from ${JSON.stringify(runtimeImport)};`;
}

export function runCommand(
  command: string[],
  cwd: string,
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
