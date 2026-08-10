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

  it("rejects unknown options and options without values", () => {
    const unknownOption = runCommand(
      ["bun", cliEntry, "generate", "--unknown"],
      repoRoot,
    );
    const missingValue = runCommand(
      ["bun", cliEntry, "generate", "--srcDir"],
      repoRoot,
    );

    expect(unknownOption.exitCode).toBe(1);
    expect(unknownOption.stderr).toContain("Unknown option");
    expect(unknownOption.stdout).toContain("Usage:");
    expect(missingValue.exitCode).toBe(1);
    expect(missingValue.stderr).toContain("--srcDir expects a value");
  });
});
