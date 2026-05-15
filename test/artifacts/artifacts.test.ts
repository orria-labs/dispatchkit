import { describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime, generateRuntime } from "../../src/index.ts";
import {
  createTempProject,
  dispatchkitImportLine,
  withTempProject,
} from "../test-helpers.ts";

describe("artifacts generation", () => {
  it("generates types without loading env-dependent runtime", async () => {
    await withTempProject(
      {
        "src/config.ts": `${dispatchkitImportLine()}\nimport { z } from "zod";\nexport default defineConfig(z.object({ SECRET_TOKEN: z.string().min(10) }));`,
        "src/logger.ts": `${dispatchkitImportLine()}\nconst logger = {\n  error: (..._args: unknown[]) => undefined,\n  warn: (..._args: unknown[]) => undefined,\n  info: (..._args: unknown[]) => undefined,\n  debug: (..._args: unknown[]) => undefined,\n  custom: () => 1,\n};\nexport default defineLogger(() => ({ logger, console }));`,
        "src/modules/widget/get.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
        "src/transport/http.ts": `${dispatchkitImportLine()}\nexport default defineTransport(() => ({ ping: () => "pong" }));`,
      },
      async (rootDir) => {
        const result = await generateRuntime({
          rootDir,
          srcDir: join(rootDir, "src"),
        });
        const busTypesPath = join(result.generatedDir, "bus.d.ts");
        const runtimeTypesPath = join(result.generatedDir, "runtime.d.ts");
        const manifestPath = join(result.generatedDir, "manifest.json");

        const busTypes = readFileSync(busTypesPath, "utf8");
        const runtimeTypes = readFileSync(runtimeTypesPath, "utf8");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          transport: Array<{ key: string; source: string }>;
        };

        expect(busTypes).toContain('"widget": {');
        expect(busTypes).toContain('"get":');
        expect(runtimeTypes).toContain("InferConfigFromDefinition<typeof AppConfigDefinition>");
        expect(runtimeTypes).toContain("InferLoggerFromDefinition<typeof AppLoggerDefinition>");
        expect(manifest.transport).toEqual([
          // @ts-expect-error
          { key: "http", filePath: "http.ts", source: "transport" },
        ]);
      },
    );
  });

  it("discovers defineTransport exported from infra without module execution", async () => {
    await withTempProject(
      {
        "src/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
        "src/infra/storage.ts": `${dispatchkitImportLine()}\nexport default defineInfra(() => ({ storage: { ready: true } }));`,
        "src/infra/http.ts": `${dispatchkitImportLine()}\nconst transport = defineTransport(() => ({ ping: () => "pong" }));\nexport default transport;`,
      },
      async (rootDir) => {
        const result = await generateRuntime({
          rootDir,
          srcDir: join(rootDir, "src"),
        });
        const manifest = JSON.parse(
          readFileSync(join(result.generatedDir, "manifest.json"), "utf8"),
        ) as {
          infra: Array<{ filePath: string }>;
          transport: Array<{ key: string; filePath: string; source: string }>;
        };

        expect(manifest.infra).toEqual([{ filePath: "storage.ts" }]);
        expect(manifest.transport).toEqual([
          { key: "http", filePath: "http.ts", source: "infra" },
        ]);
      },
    );
  });
});

describe("artifacts runtime outputs", () => {
  it("updates manifest only when discovery structure changes", async () => {
    let unchangedHash = "";
    let unchangedText = "";

    const firstRoot = createTempProject({
      "src/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
    });

    try {
      await buildRuntime({ rootDir: firstRoot, srcDir: join(firstRoot, "src") });

      const manifestPath = join(firstRoot, "src/generated/runtime/manifest.json");
      const firstManifestText = await Bun.file(manifestPath).text();
      const firstManifest = (await Bun.file(manifestPath).json()) as {
        meta: { builtAt: string; discoveryHash: string };
      };

      await Bun.sleep(10);
      writeFileSync(
        join(firstRoot, "src/modules/ping.query.ts"),
        `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: false, version: 2 }) });`,
      );
      await buildRuntime({ rootDir: firstRoot, srcDir: join(firstRoot, "src") });

      const secondManifestText = await Bun.file(manifestPath).text();
      const secondManifest = (await Bun.file(manifestPath).json()) as {
        meta: { builtAt: string; discoveryHash: string };
      };

      expect(secondManifest.meta.discoveryHash).toBe(firstManifest.meta.discoveryHash);
      expect(secondManifestText).toBe(firstManifestText);

      unchangedHash = secondManifest.meta.discoveryHash;
      unchangedText = secondManifestText;
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
    }

    await withTempProject(
      {
        "src/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
        "src/modules/ping-added.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
      },
      async (secondRoot) => {
        await buildRuntime({ rootDir: secondRoot, srcDir: join(secondRoot, "src") });

        const manifestPath = join(secondRoot, "src/generated/runtime/manifest.json");
        const changedManifestText = await Bun.file(manifestPath).text();
        const changedManifest = (await Bun.file(manifestPath).json()) as {
          meta: { builtAt: string; discoveryHash: string };
          modules: Array<{ filePath: string }>;
        };

        expect(changedManifest.meta.discoveryHash).not.toBe(unchangedHash);
        expect(changedManifestText).not.toBe(unchangedText);
        expect(changedManifest.modules.map((item) => item.filePath)).toEqual([
          "ping-added.query.ts",
          "ping.query.ts",
        ]);
      },
    );
  });

  it("generates manifest and declaration artifacts", async () => {
    await withTempProject(
      {
        "src/modules/widget/get.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
        "src/modules/widget/upsert.mutation.ts": `${dispatchkitImportLine()}\nexport default defineMutation({ handler: async () => ({ id: "1" }) });`,
        "src/modules/widget/sync.action.ts": `${dispatchkitImportLine()}\nexport default defineAction({ handler: async () => ({ synced: true }) });`,
        "src/infra/data.ts": `${dispatchkitImportLine()}\nexport default defineInfra(() => ({ data: {} }));`,
        "src/infra/my-transport.ts": `${dispatchkitImportLine()}\nexport default defineTransport(() => ({ kind: "first" }));`,
        "src/infra/my-second-transport/index.ts": `${dispatchkitImportLine()}\nexport default defineTransport(() => ({ kind: "second" }));`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });

        const manifestPath = join(rootDir, "src/generated/runtime/manifest.json");
        const busPath = join(rootDir, "src/generated/runtime/bus.d.ts");
        const runtimePath = join(rootDir, "src/generated/runtime/runtime.d.ts");
        const indexPath = join(rootDir, "src/generated/runtime/index.ts");

        expect(await Bun.file(manifestPath).exists()).toBe(true);
        expect(await Bun.file(busPath).exists()).toBe(true);
        expect(await Bun.file(runtimePath).exists()).toBe(true);
        expect(await Bun.file(indexPath).exists()).toBe(true);

        const manifest = (await Bun.file(manifestPath).json()) as {
          modules: Array<{ name: string }>;
          infra: Array<{ filePath: string }>;
          transport: Array<{ key: string; filePath: string; source: string }>;
        };

        expect(manifest.modules.map((item) => item.name).sort()).toEqual([
          "widgetGet",
          "widgetSync",
          "widgetUpsert",
        ]);
        expect(manifest.infra.map((item) => item.filePath)).toEqual(["data.ts"]);
        expect(manifest.transport).toEqual([
          {
            key: "my-second-transport",
            filePath: "my-second-transport/index.ts",
            source: "infra",
          },
          { key: "my-transport", filePath: "my-transport.ts", source: "infra" },
        ]);

        const busTypes = await Bun.file(busPath).text();
        expect(busTypes.includes('"widgetUpsert"')).toBe(true);
        expect(busTypes.includes('"widget"')).toBe(true);
        expect(busTypes.includes("GeneratedInfra")).toBe(true);
        expect(busTypes.includes('"data": InferInfraModule')).toBe(true);
        expect(busTypes.includes("GeneratedTransport")).toBe(true);
        expect(busTypes.includes('"my-transport"')).toBe(true);
        expect(busTypes.includes('"my-second-transport"')).toBe(true);
        expect((runtime.transport as Record<string, unknown>)["my-transport"]).toEqual({
          kind: "first",
        });
        expect(
          (runtime.transport as Record<string, unknown>)["my-second-transport"],
        ).toEqual({
          kind: "second",
        });

        const runtimeTypes = await Bun.file(runtimePath).text();
        expect(runtimeTypes.includes("GeneratedConfig")).toBe(true);
      },
    );
  });
});
