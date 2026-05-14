import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRuntimeFiles, resolveOperationName } from "../src/discovery.ts";
import { buildRuntime, generateRuntime } from "../src/index.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimeImport = join(testDir, "..", "src", "index.ts").replace(/\\/g, "/");

type FileMap = Record<string, string>;

function writeProjectFiles(rootDir: string, files: FileMap): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(rootDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

function createTempProject(files: FileMap): string {
  const rootDir = mkdtempSync(join(tmpdir(), "xpr-test-"));
  writeProjectFiles(rootDir, {
    "package.json": JSON.stringify({
      name: "xpr-test-service",
      description: "runtime test",
      version: "1.2.3",
    }),
    ...files,
  });

  const sourceNodeModules = join(process.cwd(), "node_modules");
  const targetNodeModules = join(rootDir, "node_modules");
  if (!existsSync(targetNodeModules) && existsSync(sourceNodeModules)) {
    symlinkSync(sourceNodeModules, targetNodeModules, "dir");
  }

  return rootDir;
}

function xprImportLine(): string {
  return `import { defineAction, defineConfig, defineInfra, defineLogger, defineMutation, defineQuery, defineTransport, getModuleCtx, getTransportCtx } from ${JSON.stringify(runtimeImport)};`;
}

describe("logger", () => {
  it("mounts global console and supports fallback logger", async () => {
    const rootDir = createTempProject({
      "src/modules/ping.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
    });

    try {
      const runtime = await buildRuntime({
        rootDir,
        srcDir: join(rootDir, "src"),
      });
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "console");

      expect(runtime.logger).toBeDefined();
      expect(typeof runtime.logger.info).toBe("function");
      expect(descriptor?.configurable).toBe(false);
      expect(descriptor?.writable).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("discovery", () => {
  it("finds valid files and keeps deterministic sort order", async () => {
    const rootDir = createTempProject({
      "src/modules/widget/upsert.mutation.ts": `${xprImportLine()}\nexport default defineMutation({ handler: async () => ({}) });`,
      "src/modules/widget/get.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async () => ({}) });`,
      "src/modules/widget/internal.d.ts": "export {};",
      "src/modules/ignore.txt": "noop",
      "src/infra/db/index.ts": `${xprImportLine()}\nexport default defineInfra(() => ({ db: {} }));`,
      "src/infra/cache.ts": `${xprImportLine()}\nexport default defineInfra(() => ({ cache: {} }));`,
      "src/infra/nested/skip.ts": `${xprImportLine()}\nexport default defineInfra(() => ({ skip: {} }));`,
      "src/transport/http/index.ts": `${xprImportLine()}\nexport default defineTransport(() => ({ http: {} }));`,
      "src/transport/worker.ts": `${xprImportLine()}\nexport default defineTransport(() => ({ worker: {} }));`,
      "src/transport/nested/skip.ts": `${xprImportLine()}\nexport default defineTransport(() => ({ skip: {} }));`,
    });

    try {
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
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("generate runtime artifacts", () => {
  it("generates types without loading env-dependent runtime", async () => {
    const rootDir = createTempProject({
      "src/config.ts": `${xprImportLine()}\nimport { z } from "zod";\nexport default defineConfig(z.object({ SECRET_TOKEN: z.string().min(10) }));`,
      "src/modules/widget/get.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
      "src/transport/http.ts": `${xprImportLine()}\nexport default defineTransport(() => ({ ping: () => "pong" }));`,
    });

    try {
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
      expect(manifest.transport).toEqual([
        // @ts-expect-error
        { key: "http", filePath: "http.ts", source: "transport" },
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("discovers defineTransport exported from infra without module execution", async () => {
    const rootDir = createTempProject({
      "src/modules/ping.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
      "src/infra/storage.ts": `${xprImportLine()}\nexport default defineInfra(() => ({ storage: { ready: true } }));`,
      "src/infra/http.ts": `${xprImportLine()}\nconst transport = defineTransport(() => ({ ping: () => "pong" }));\nexport default transport;`,
    });

    try {
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
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("naming", () => {
  it("normalizes operation names from paths", () => {
    const resolved = resolveOperationName(
      "widget/my-feature/upsert.mutation.ts",
    );
    expect(resolved.name).toBe("widgetMyFeatureUpsert");
    expect(resolved.segments).toEqual(["widget", "myFeature", "upsert"]);
    expect(resolved.kind).toBe("mutation");
  });

  it("detects collisions after normalization", async () => {
    const rootDir = createTempProject({
      "src/modules/widget-upsert.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async () => 1 });`,
      "src/modules/widget/upsert.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async () => 2 });`,
    });

    try {
      await expect(discoverRuntimeFiles(join(rootDir, "src"))).rejects.toThrow(
        "XPR_DISCOVERY_NAME_COLLISION",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("cqrs guards", () => {
  it("blocks query->mutation and mutation->action, allows valid chains", async () => {
    const rootDir = createTempProject({
      "src/modules/base.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async () => 1 });`,
      "src/modules/do.mutation.ts": `${xprImportLine()}\nexport default defineMutation({ handler: async (ctx) => ctx.bus.query.base({}) });`,
      "src/modules/start.action.ts": `${xprImportLine()}\nexport default defineAction({ handler: async (ctx) => ctx.bus.mutation.do({}) });`,
      "src/modules/forbidden-query.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async (ctx) => ctx.bus.mutation.do({}) });`,
      "src/modules/forbidden-mutation.mutation.ts": `${xprImportLine()}\nexport default defineMutation({ handler: async (ctx) => ctx.bus.action.start({}) });`,
    });

    try {
      const runtime = await buildRuntime({
        rootDir,
        srcDir: join(rootDir, "src"),
      });
      const bus = runtime.bus as any;
      await expect(bus.action.start({})).resolves.toBe(1);
      await expect(bus.query.forbiddenQuery({})).rejects.toThrow(
        "XPR_CQRS_GUARD",
      );
      await expect(bus.mutation.forbiddenMutation({})).rejects.toThrow(
        "XPR_CQRS_GUARD",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("validation", () => {
  it("validates input/return and supports $unsafe", async () => {
    const rootDir = createTempProject({
      "src/modules/check.mutation.ts": `${xprImportLine()}\nimport { z } from "zod";\nexport default defineMutation({\n  input: z.object({ value: z.number() }),\n  return: z.object({ value: z.number() }),\n  handler: async (ctx) => ctx.input.value === 13 ? ({ value: "bad" } as unknown as { value: number }) : ({ value: ctx.input.value })\n});`,
    });

    try {
      const runtime = await buildRuntime({
        rootDir,
        srcDir: join(rootDir, "src"),
      });
      const bus = runtime.bus as any;
      await expect(bus.mutation.check({ value: "1" })).rejects.toThrow(
        "input validation",
      );
      await expect(bus.mutation.check({ value: 13 })).rejects.toThrow(
        "return validation",
      );
      await expect(
        bus.mutation.check.$unsafe({ value: "1" } as unknown as {
          value: number;
        }),
      ).resolves.toEqual({
        value: "1",
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("transport context allowlist", () => {
  it("supports routes shorthand and top-level getTransportCtx during transport import", async () => {
    const rootDir = createTempProject({
      "src/routes/index.ts": `${xprImportLine()}
export const bootCtxName = getTransportCtx().config.SERVICE_NAME;
export function readRouteCtxName() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/transport/http.ts": `${xprImportLine()}
import { bootCtxName, readRouteCtxName } from "../routes/index.ts";
import { readForbiddenName } from "../lib/ctx.ts";

export default defineTransport(
  () => ({
    boot: () => bootCtxName,
    route: () => readRouteCtxName(),
    forbidden: () => readForbiddenName(),
  }),
  {
    allowGetTransportCtxFrom: ["routes"],
  },
);`,
      "src/lib/ctx.ts": `${xprImportLine()}
export function readForbiddenName() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/modules/ping.query.ts": `${xprImportLine()}
export default defineQuery({ handler: async () => ({ ok: true }) });`,
    });

    try {
      const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
      const transport = runtime.transport as any;

      expect(transport.http.boot()).toBe("xpr-test-service");
      expect(transport.http.route()).toBe("xpr-test-service");
      expect(() => transport.http.forbidden()).toThrow("XPR_CONTEXT_FORBIDDEN");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("treats allowGetTransportCtxFrom as extension of default locations", async () => {
    const rootDir = createTempProject({
      "src/transport/http.ts": `${xprImportLine()}
import { readFromHttpHelper } from "./http/nested/helper.ts";
import { readForbiddenName } from "../lib/ctx.ts";

export default defineTransport(
  () => ({
    direct: () => getTransportCtx().config.SERVICE_NAME,
    helper: () => readFromHttpHelper(),
    forbidden: () => readForbiddenName(),
  }),
  {
    allowGetTransportCtxFrom: ["http"],
  },
);`,
      "src/transport/http/nested/helper.ts": `${xprImportLine()}
export function readFromHttpHelper() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/lib/ctx.ts": `${xprImportLine()}
export function readForbiddenName() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/modules/ping.query.ts": `${xprImportLine()}
export default defineQuery({ handler: async () => ({ ok: true }) });`,
    });

    try {
      const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
      const transport = runtime.transport as any;

      expect(transport.http.direct()).toBe("xpr-test-service");
      expect(transport.http.helper()).toBe("xpr-test-service");
      expect(() => transport.http.forbidden()).toThrow("XPR_CONTEXT_FORBIDDEN");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("allows getTransportCtx only from configured src-relative paths", async () => {
    const rootDir = createTempProject({
      "src/transport/mytransport.ts": `${xprImportLine()}
import { readAllowedName } from "./mytransport2/nested/helper.ts";
import { readForbiddenName } from "../lib/ctx.ts";

export default defineTransport(
  () => ({
    direct: () => getTransportCtx().config.SERVICE_NAME,
    allowed: () => readAllowedName(),
    forbidden: () => readForbiddenName(),
  }),
  {
    allowGetTransportCtxFrom: [
      "src/transport/mytransport.ts",
      "src/transport/mytransport2/**/*.ts",
    ],
  },
);`,
      "src/transport/mytransport2/nested/helper.ts": `${xprImportLine()}
export function readAllowedName() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/lib/ctx.ts": `${xprImportLine()}
export function readForbiddenName() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/modules/ping.query.ts": `${xprImportLine()}
export default defineQuery({ handler: async () => ({ ok: true }) });`,
    });

    try {
      const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
      const transport = runtime.transport as any;

      expect(transport.mytransport.direct()).toBe("xpr-test-service");
      expect(transport.mytransport.allowed()).toBe("xpr-test-service");
      expect(() => transport.mytransport.forbidden()).toThrow(
        "XPR_CONTEXT_FORBIDDEN",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("config", () => {
  it("applies defaults < env < options and extends schema from config.ts", async () => {
    const rootDir = createTempProject({
      ".env": "SERVICE_NAME=from-env\nLOG_LEVEL=error\nCUSTOM_FLAG=env-value\n",
      "src/config.ts": `${xprImportLine()}\nimport { z } from "zod";\nexport default defineConfig(z.object({ CUSTOM_FLAG: z.string(), FEATURE_TOGGLE: z.string().default("from-schema") }));`,
      "src/modules/ping.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async () => getModuleCtx().config });`,
    });

    try {
      const runtime = await buildRuntime({
        rootDir,
        srcDir: join(rootDir, "src"),
        SERVICE_NAME: "from-options",
      });

      expect(runtime.config.SERVICE_NAME).toBe("from-options");
      expect(runtime.config.SERVICE_DESCRIPTION).toBe("runtime test");
      expect(runtime.config.SERVICE_VERSION).toBe("1.2.3");
      expect(runtime.config.LOG_LEVEL).toBe("error");
      expect(runtime.config.CUSTOM_FLAG).toBe("env-value");
      expect(runtime.config.FEATURE_TOGGLE).toBe("from-schema");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("artifacts", () => {
  it("updates manifest only when discovery structure changes", async () => {
    const rootDir = createTempProject({
      "src/modules/ping.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
    });

    try {
      await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });

      const manifestPath = join(rootDir, "src/generated/runtime/manifest.json");
      const firstManifestText = await Bun.file(manifestPath).text();
      const firstManifest = (await Bun.file(manifestPath).json()) as {
        meta: { builtAt: string; discoveryHash: string };
        modules: Array<{ filePath: string }>;
      };

      await Bun.sleep(10);
      writeFileSync(
        join(rootDir, "src/modules/ping.query.ts"),
        `${xprImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: false, version: 2 }) });`,
      );
      await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });

      const secondManifestText = await Bun.file(manifestPath).text();
      const secondManifest = (await Bun.file(manifestPath).json()) as {
        meta: { builtAt: string; discoveryHash: string };
        modules: Array<{ filePath: string }>;
      };

      expect(secondManifest.meta.discoveryHash).toBe(firstManifest.meta.discoveryHash);
      expect(secondManifestText).toBe(firstManifestText);

      await Bun.sleep(10);
      rmSync(join(rootDir, "src/modules/ping.query.ts"), { force: true });
      writeFileSync(
        join(rootDir, "src/modules/ping-renamed.query.ts"),
        `${xprImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
      );
      await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });

      const thirdManifestText = await Bun.file(manifestPath).text();
      const thirdManifest = (await Bun.file(manifestPath).json()) as {
        meta: { builtAt: string; discoveryHash: string };
        modules: Array<{ filePath: string }>;
      };

      expect(thirdManifest.meta.discoveryHash).not.toBe(
        secondManifest.meta.discoveryHash,
      );
      expect(thirdManifest.meta.builtAt).not.toBe(secondManifest.meta.builtAt);
      expect(thirdManifestText).not.toBe(secondManifestText);
      expect(thirdManifest.modules.map((item) => item.filePath)).toEqual([
        "ping-renamed.query.ts",
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("generates manifest and declaration artifacts", async () => {
    const rootDir = createTempProject({
      "src/modules/widget/get.query.ts": `${xprImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
      "src/modules/widget/upsert.mutation.ts": `${xprImportLine()}\nexport default defineMutation({ handler: async () => ({ id: "1" }) });`,
      "src/modules/widget/sync.action.ts": `${xprImportLine()}\nexport default defineAction({ handler: async () => ({ synced: true }) });`,
      "src/infra/data.ts": `${xprImportLine()}\nexport default defineInfra(() => ({ data: {} }));`,
      "src/infra/my-transport.ts": `${xprImportLine()}\nexport default defineTransport(() => ({ kind: "first" }));`,
      "src/infra/my-second-transport/index.ts": `${xprImportLine()}\nexport default defineTransport(() => ({ kind: "second" }));`,
    });

    try {
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
        { key: "my-second-transport", filePath: "my-second-transport/index.ts", source: "infra" },
        { key: "my-transport", filePath: "my-transport.ts", source: "infra" },
      ]);

      const busTypes = await Bun.file(busPath).text();
      expect(busTypes.includes('"widgetUpsert"')).toBe(true);
      expect(busTypes.includes('"widget"')).toBe(true);
      expect(busTypes.includes("GeneratedInfra")).toBe(true);
      expect(busTypes.includes("GeneratedTransport")).toBe(true);
      expect(busTypes.includes('"my-transport"')).toBe(true);
      expect(busTypes.includes('"my-second-transport"')).toBe(true);
      // @ts-expect-error
      expect((runtime.transport as Record<string, unknown>)["my-transport"]).toEqual({
        kind: "first",
      });
      expect(
        // @ts-expect-error
        (runtime.transport as Record<string, unknown>)["my-second-transport"],
      ).toEqual({
        kind: "second",
      });

      const runtimeTypes = await Bun.file(runtimePath).text();
      expect(runtimeTypes.includes("GeneratedConfig")).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
