import { describe, expect, it } from "bun:test";
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { watchRuntime } from "../../src/index.ts";
import { dispatchkitImportLine, withTempProject } from "../test-helpers.ts";

const ping = `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => true });`;

/** Polls the generated manifest until `done` accepts it (or a timeout), returning its text. */
async function waitForManifest(rootDir: string, done: (text: string) => boolean): Promise<string> {
  const path = join(rootDir, "src/generated/runtime/manifest.json");
  let text = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await Bun.sleep(50);
    text = await Bun.file(path).text();
    if (done(text)) break;
  }
  return text;
}

describe("watchRuntime", () => {
  it("regenerates when a module directory is renamed and stops on abort", async () => {
    await withTempProject({ "src/modules/old/ping.query.ts": ping }, async (rootDir) => {
      const srcDir = join(rootDir, "src");
      const controller = new AbortController();
      let renamed!: () => void;
      const renamedOnce = new Promise<void>((resolve) => (renamed = resolve));
      const watching = watchRuntime({
        rootDir,
        debounceMs: 20,
        signal: controller.signal,
        onInfo: (message) => {
          if (!message.includes("watching")) return;
          setTimeout(() => {
            renameSync(join(srcDir, "modules/old"), join(srcDir, "modules/new"));
            renamed();
          }, 50);
        },
      });
      await renamedOnce;
      const manifest = await waitForManifest(rootDir, (text) => text.includes("new/ping.query.ts"));
      controller.abort();
      await watching;

      expect(manifest).toContain("new/ping.query.ts");
      expect(manifest).not.toContain("old/ping.query.ts");
    });
  });

  it("ignores changes inside the generated artifacts directory", async () => {
    await withTempProject({ "src/modules/ping.query.ts": ping }, async (rootDir) => {
      const controller = new AbortController();
      let regenerations = 0;
      let atWrite = -1;
      const watching = watchRuntime({
        rootDir,
        debounceMs: 20,
        signal: controller.signal,
        onInfo: (message) => {
          if (message.includes("regenerated")) regenerations += 1;
          if (!message.includes("watching")) return;
          // FSEvents may still deliver the project's own setup writes: let them settle first.
          setTimeout(() => {
            atWrite = regenerations;
            writeFileSync(join(rootDir, "src/generated/runtime/extra.ts"), "export {};");
          }, 300);
        },
      });
      await Bun.sleep(700);
      controller.abort();
      await watching;
      expect(atWrite).toBeGreaterThanOrEqual(0);
      expect(regenerations).toBe(atWrite);
    });
  });

  it("survives symlink loops and regenerates on renames of folders named like declarations", async () => {
    await withTempProject({ "src/modules/v2.d.ts/a.query.ts": ping }, async (rootDir) => {
      const srcDir = join(rootDir, "src");
      const errors: unknown[] = [];
      const controller = new AbortController();
      const watching = watchRuntime({
        rootDir,
        debounceMs: 20,
        signal: controller.signal,
        onError: (error) => errors.push(error),
        onInfo: (message) => {
          if (!message.includes("watching")) return;
          setTimeout(() => {
            symlinkSync("loop.txt", join(srcDir, "loop.txt"));
            renameSync(join(srcDir, "modules/v2.d.ts"), join(srcDir, "modules/v3.d.ts"));
          }, 50);
        },
      });
      const manifest = await waitForManifest(rootDir, (text) =>
        text.includes("v3.d.ts/a.query.ts"),
      );
      controller.abort();
      await watching;
      expect(manifest).toContain("v3.d.ts/a.query.ts");
      expect(errors).toEqual([]);
    });
  });
});
