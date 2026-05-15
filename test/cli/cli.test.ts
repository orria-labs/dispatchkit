import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  cliEntry,
  dispatchkitImportLine,
  repoRoot,
  runCommand,
  withTempProject,
} from "../test-helpers.ts";

describe("cli", () => {
  it("prints usage for --help", () => {
    const result = runCommand(["bun", cliEntry, "--help"], repoRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("dispatchkit generate");
  });

  it("generates artifacts via generate command", async () => {
    await withTempProject(
      {
        "src/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
      },
      async (rootDir) => {
        const srcDir = join(rootDir, "src");
        const result = runCommand(
          ["bun", cliEntry, "generate", "--rootDir", rootDir, "--srcDir", srcDir],
          repoRoot,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("generated runtime artifacts");

        const manifestPath = join(srcDir, "generated", "runtime", "manifest.json");
        expect(await Bun.file(manifestPath).exists()).toBe(true);
      },
    );
  });

  it("fails for unknown options", () => {
    const result = runCommand(["bun", cliEntry, "generate", "--unknown"], repoRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown option");
    expect(result.stdout).toContain("Usage:");
  });
});
