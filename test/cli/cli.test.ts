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
    const unknownOption = runCommand(["bun", cliEntry, "generate", "--unknown"], repoRoot);
    const missingValue = runCommand(["bun", cliEntry, "generate", "--srcDir"], repoRoot);

    expect(unknownOption.exitCode).toBe(1);
    expect(unknownOption.stderr).toContain("Unknown option");
    expect(unknownOption.stdout).toContain("Usage:");
    expect(missingValue.exitCode).toBe(1);
    expect(missingValue.stderr).toContain("--srcDir expects a value");
  });

  it("resolves relative directory flags against --rootDir", async () => {
    await withTempProject(
      {
        "app/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: () => true });`,
      },
      async (rootDir) => {
        const result = runCommand(
          [
            "bun",
            cliEntry,
            "generate",
            "--rootDir",
            rootDir,
            "--srcDir",
            "app",
            "--generatedDir",
            "types",
          ],
          repoRoot,
        );
        expect(result.exitCode).toBe(0);
        const manifest = await Bun.file(join(rootDir, "types/manifest.json")).json();
        expect(manifest.modules).toHaveLength(1);
      },
    );
  });

  it("watches local re-export dependencies outside the discovered layer folders", async () => {
    await withTempProject(
      {
        "src/shared/definition.ts": `${dispatchkitImportLine()}\nexport default defineInfra(() => ({}));`,
        "src/infra/server.ts": `export { default } from "../shared/definition.ts";`,
      },
      async (rootDir) => {
        const child = Bun.spawn(
          ["bun", cliEntry, "generate", "--watch", "--rootDir", rootDir, "--intervalMs", "50"],
          { cwd: repoRoot, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
        );
        let output = "";
        const outputTask = (async () => {
          for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
        })();
        const errorTask = new Response(child.stderr).text();
        const waitFor = async (predicate: () => Promise<boolean>) => {
          const timeout = Date.now() + 2500;
          while (Date.now() < timeout) {
            if (await predicate()) return;
            await Bun.sleep(20);
          }
          throw new Error(`Watch did not update before timeout. Output: ${output}`);
        };
        try {
          await waitFor(async () => output.includes("watching"));
          await Bun.write(
            join(rootDir, "src/shared/definition.ts"),
            `${dispatchkitImportLine()}\nexport default defineTransport(() => ({}));`,
          );
          await waitFor(async () => {
            const manifest = await Bun.file(
              join(rootDir, "src/generated/runtime/manifest.json"),
            ).json();
            return manifest.transport.length === 1;
          });
          expect(output).toContain("regenerated runtime artifacts");
        } finally {
          child.kill("SIGTERM");
          await child.exited;
          await outputTask;
        }
        expect(await errorTask).toBe("");
      },
    );
  });
});
