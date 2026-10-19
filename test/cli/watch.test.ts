import { describe, expect, it } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { watchRuntime } from "../../src/index.ts";
import { dispatchkitImportLine, withTempProject } from "../test-helpers.ts";

const ping = `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => true });`;

/** Runs watchRuntime until `until` sees a message (or times out), then aborts it. */
async function watchUntil(
  rootDir: string,
  onWatching: () => void,
  until: (message: string) => boolean,
  timeoutMs = 3000,
): Promise<string[]> {
  const controller = new AbortController();
  const messages: string[] = [];
  let resolveSeen!: () => void;
  const seen = new Promise<void>((resolve) => (resolveSeen = resolve));
  const watching = watchRuntime({
    rootDir,
    debounceMs: 20,
    signal: controller.signal,
    onInfo: (message) => {
      messages.push(message);
      if (message.includes("watching")) setTimeout(onWatching, 50);
      if (until(message)) resolveSeen();
    },
  });
  await Promise.race([seen, Bun.sleep(timeoutMs)]);
  controller.abort();
  await watching;
  return messages;
}

describe("watchRuntime", () => {
  it("regenerates when a module directory is renamed and stops on abort", async () => {
    await withTempProject({ "src/modules/old/ping.query.ts": ping }, async (rootDir) => {
      const srcDir = join(rootDir, "src");
      const messages = await watchUntil(
        rootDir,
        () => renameSync(join(srcDir, "modules/old"), join(srcDir, "modules/new")),
        (message) => message.includes("regenerated"),
      );

      expect(messages.some((message) => message.includes("regenerated"))).toBe(true);
      const manifest = await Bun.file(join(srcDir, "generated/runtime/manifest.json")).text();
      expect(manifest).toContain("new/ping.query.ts");
      expect(manifest).not.toContain("old/ping.query.ts");
    });
  });

  it("ignores changes inside the generated artifacts directory", async () => {
    await withTempProject({ "src/modules/ping.query.ts": ping }, async (rootDir) => {
      const messages = await watchUntil(
        rootDir,
        () => writeFileSync(join(rootDir, "src/generated/runtime/extra.ts"), "export {};"),
        () => false,
        600,
      );
      expect(messages.some((message) => message.includes("regenerated"))).toBe(false);
    });
  });
});
