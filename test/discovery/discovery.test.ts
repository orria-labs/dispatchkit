import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { discoverRuntimeFiles, resolveOperationName } from "../../src/discovery.ts";
import { dispatchkitImportLine, withTempProject } from "../test-helpers.ts";

describe("discovery", () => {
  it("finds valid files and keeps deterministic sort order", async () => {
    await withTempProject(
      {
        "src/modules/widget/upsert.mutation.ts": `${dispatchkitImportLine()}\nexport default defineMutation({ handler: async () => ({}) });`,
        "src/modules/widget/get.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({}) });`,
        "src/modules/widget/internal.d.ts": "export {};",
        "src/modules/ignore.txt": "noop",
        "src/infra/db/index.ts": `${dispatchkitImportLine()}\nexport default defineInfra(() => ({ db: {} }));`,
        "src/infra/cache.ts": `${dispatchkitImportLine()}\nexport default defineInfra(() => ({ cache: {} }));`,
        "src/infra/nested/skip.ts": `${dispatchkitImportLine()}\nexport default defineInfra(() => ({ skip: {} }));`,
        "src/transport/http/index.ts": `${dispatchkitImportLine()}\nexport default defineTransport(() => ({ http: {} }));`,
        "src/transport/worker.ts": `${dispatchkitImportLine()}\nexport default defineTransport(() => ({ worker: {} }));`,
        "src/transport/nested/skip.ts": `${dispatchkitImportLine()}\nexport default defineTransport(() => ({ skip: {} }));`,
      },
      async (rootDir) => {
        const discovery = await discoverRuntimeFiles(join(rootDir, "src"));

        expect(discovery.operations.map((item) => item.filePath)).toEqual([
          "widget/get.query.ts",
          "widget/upsert.mutation.ts",
        ]);
        expect(discovery.infra).toEqual(["cache.ts", "db/index.ts"]);
        expect(discovery.transport).toEqual([
          { key: "http", filePath: "http/index.ts", source: "transport" },
          { key: "worker", filePath: "worker.ts", source: "transport" },
        ]);
      },
    );
  });
});

describe("naming", () => {
  it("normalizes operation names from paths", () => {
    const resolved = resolveOperationName("widget/my-feature/upsert.mutation.ts");
    expect(resolved.name).toBe("widgetMyFeatureUpsert");
    expect(resolved.segments).toEqual(["widget", "myFeature", "upsert"]);
    expect(resolved.kind).toBe("mutation");
  });

  it("detects collisions after normalization", async () => {
    await withTempProject(
      {
        "src/modules/widget-upsert.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => 1 });`,
        "src/modules/widget/upsert.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => 2 });`,
      },
      async (rootDir) => {
        await expect(discoverRuntimeFiles(join(rootDir, "src"))).rejects.toThrow(
          "DISPATCHKIT_DISCOVERY_NAME_COLLISION",
        );
      },
    );
  });
});
