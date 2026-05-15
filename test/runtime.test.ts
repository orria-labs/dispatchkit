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
  const rootDir = mkdtempSync(join(tmpdir(), "dispatchkit-test-"));
  writeProjectFiles(rootDir, {
    "package.json": JSON.stringify({
      name: "dispatchkit-test-service",
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

function dispatchkitImportLine(): string {
  return `import { defineAction, defineConfig, defineInfra, defineLogger, defineMutation, defineQuery, defineTransport, getModuleCtx, getTransportCtx } from ${JSON.stringify(runtimeImport)};`;
}

function runCommand(
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
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("logger", () => {
  it("mounts global console and supports fallback logger", async () => {
    const rootDir = createTempProject({
      "src/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
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

describe("infra mapping", () => {
  it("exposes infra by domain key from file name and module context", async () => {
    const rootDir = createTempProject({
      "src/infra/database.ts": `${dispatchkitImportLine()}
class DatabaseClient {
  kind = "database";
}
export default defineInfra(async () => new DatabaseClient());`,
      "src/modules/read.query.ts": `${dispatchkitImportLine()}
export default defineQuery({
  handler: async () => ({ kind: getModuleCtx().infra.database.kind }),
});`,
    });

    try {
      const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
      const bus = runtime.bus as any;

      expect((runtime.infra as any).database.kind).toBe("database");
      await expect(bus.query.read({})).resolves.toEqual({ kind: "database" });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("uses folder name for infra index.ts modules", async () => {
    const rootDir = createTempProject({
      "src/infra/database/index.ts": `${dispatchkitImportLine()}
export default defineInfra(async () => ({ client: "ok" }));`,
    });

    try {
      const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
      expect((runtime.infra as any).database).toEqual({ client: "ok" });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("generate runtime artifacts", () => {
  it("generates types without loading env-dependent runtime", async () => {
    const rootDir = createTempProject({
      "src/config.ts": `${dispatchkitImportLine()}\nimport { z } from "zod";\nexport default defineConfig(z.object({ SECRET_TOKEN: z.string().min(10) }));`,
      "src/modules/widget/get.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
      "src/transport/http.ts": `${dispatchkitImportLine()}\nexport default defineTransport(() => ({ ping: () => "pong" }));`,
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
      "src/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
      "src/infra/storage.ts": `${dispatchkitImportLine()}\nexport default defineInfra(() => ({ storage: { ready: true } }));`,
      "src/infra/http.ts": `${dispatchkitImportLine()}\nconst transport = defineTransport(() => ({ ping: () => "pong" }));\nexport default transport;`,
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
      "src/modules/widget-upsert.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => 1 });`,
      "src/modules/widget/upsert.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => 2 });`,
    });

    try {
      await expect(discoverRuntimeFiles(join(rootDir, "src"))).rejects.toThrow(
        "DISPATCHKIT_DISCOVERY_NAME_COLLISION",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("cqrs guards", () => {
  it("blocks query->mutation and mutation->action, allows valid chains", async () => {
    const rootDir = createTempProject({
      "src/modules/base.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => 1 });`,
      "src/modules/do.mutation.ts": `${dispatchkitImportLine()}\nexport default defineMutation({ handler: async (ctx) => ctx.bus.query.base({}) });`,
      "src/modules/start.action.ts": `${dispatchkitImportLine()}\nexport default defineAction({ handler: async (ctx) => ctx.bus.mutation.do({}) });`,
      "src/modules/forbidden-query.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async (ctx) => ctx.bus.mutation.do({}) });`,
      "src/modules/forbidden-mutation.mutation.ts": `${dispatchkitImportLine()}\nexport default defineMutation({ handler: async (ctx) => ctx.bus.action.start({}) });`,
    });

    try {
      const runtime = await buildRuntime({
        rootDir,
        srcDir: join(rootDir, "src"),
      });
      const bus = runtime.bus as any;
      await expect(bus.action.start({})).resolves.toBe(1);
      await expect(bus.query.forbiddenQuery({})).rejects.toThrow(
        "DISPATCHKIT_CQRS_GUARD",
      );
      await expect(bus.mutation.forbiddenMutation({})).rejects.toThrow(
        "DISPATCHKIT_CQRS_GUARD",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("validation", () => {
  it("validates input/return and supports $unsafe", async () => {
    const rootDir = createTempProject({
      "src/modules/check.mutation.ts": `${dispatchkitImportLine()}\nimport { z } from "zod";\nexport default defineMutation({\n  input: z.object({ value: z.number() }),\n  return: z.object({ value: z.number() }),\n  handler: async (ctx) => ctx.input.value === 13 ? ({ value: "bad" } as unknown as { value: number }) : ({ value: ctx.input.value })\n});`,
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
      "src/routes/index.ts": `${dispatchkitImportLine()}
export const bootCtxName = getTransportCtx().config.SERVICE_NAME;
export function readRouteCtxName() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/transport/http.ts": `${dispatchkitImportLine()}
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
      "src/lib/ctx.ts": `${dispatchkitImportLine()}
export function readForbiddenName() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/modules/ping.query.ts": `${dispatchkitImportLine()}
export default defineQuery({ handler: async () => ({ ok: true }) });`,
    });

    try {
      const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
      const transport = runtime.transport as any;

      expect(transport.http.boot()).toBe("dispatchkit-test-service");
      expect(transport.http.route()).toBe("dispatchkit-test-service");
      expect(() => transport.http.forbidden()).toThrow("DISPATCHKIT_CONTEXT_FORBIDDEN");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("treats allowGetTransportCtxFrom as extension of default locations", async () => {
    const rootDir = createTempProject({
      "src/transport/http.ts": `${dispatchkitImportLine()}
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
      "src/transport/http/nested/helper.ts": `${dispatchkitImportLine()}
export function readFromHttpHelper() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/lib/ctx.ts": `${dispatchkitImportLine()}
export function readForbiddenName() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/modules/ping.query.ts": `${dispatchkitImportLine()}
export default defineQuery({ handler: async () => ({ ok: true }) });`,
    });

    try {
      const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
      const transport = runtime.transport as any;

      expect(transport.http.direct()).toBe("dispatchkit-test-service");
      expect(transport.http.helper()).toBe("dispatchkit-test-service");
      expect(() => transport.http.forbidden()).toThrow("DISPATCHKIT_CONTEXT_FORBIDDEN");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("allows getTransportCtx only from configured src-relative paths", async () => {
    const rootDir = createTempProject({
      "src/transport/mytransport.ts": `${dispatchkitImportLine()}
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
      "src/transport/mytransport2/nested/helper.ts": `${dispatchkitImportLine()}
export function readAllowedName() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/lib/ctx.ts": `${dispatchkitImportLine()}
export function readForbiddenName() {
  return getTransportCtx().config.SERVICE_NAME;
}`,
      "src/modules/ping.query.ts": `${dispatchkitImportLine()}
export default defineQuery({ handler: async () => ({ ok: true }) });`,
    });

    try {
      const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
      const transport = runtime.transport as any;

      expect(transport.mytransport.direct()).toBe("dispatchkit-test-service");
      expect(transport.mytransport.allowed()).toBe("dispatchkit-test-service");
      expect(() => transport.mytransport.forbidden()).toThrow(
        "DISPATCHKIT_CONTEXT_FORBIDDEN",
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
      "src/config.ts": `${dispatchkitImportLine()}\nimport { z } from "zod";\nexport default defineConfig(z.object({ CUSTOM_FLAG: z.string(), FEATURE_TOGGLE: z.string().default("from-schema") }));`,
      "src/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => getModuleCtx().config });`,
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

  it("propagates generated config typing into buildRuntime return type", async () => {
    const rootDir = createTempProject({
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "Preserve",
            moduleResolution: "bundler",
            strict: true,
            allowImportingTsExtensions: true,
            verbatimModuleSyntax: true,
            noEmit: true,
            skipLibCheck: true,
            types: ["bun"],
          },
          include: ["src/**/*.ts", "src/**/*.d.ts"],
        },
        null,
        2,
      ),
      "src/config.ts": `${dispatchkitImportLine()}
import { z } from "zod";

export default defineConfig(
  z.object({
    PORT: z.number().int().positive().default(80),
    HOST: z.string().url(),
    DATABASE_URL: z.string().url(),
  }),
);`,
      "src/transport/http.ts": `${dispatchkitImportLine()}
export default defineTransport(() => ({
  listen: (options: { hostname: string; port: number }) => options,
}));`,
      "src/main.ts": `import { buildRuntime } from ${JSON.stringify(runtimeImport)};

const runtime = await buildRuntime();

runtime.transport.http.listen({
  hostname: "0.0.0.0",
  port: runtime.config.PORT,
});

const host: string = runtime.config.HOST;
const port: number = runtime.config.PORT;
const dbUrl: string = runtime.config.DATABASE_URL;

void host;
void port;
void dbUrl;`,
    });

    try {
      await generateRuntime({
        rootDir,
        srcDir: join(rootDir, "src"),
      });

      const result = runCommand(
        ["bun", "x", "tsc", "-p", "tsconfig.json", "--noEmit"],
        rootDir,
      );

      if (result.exitCode !== 0) {
        throw new Error(
          `Typecheck failed:\n${result.stdout}\n${result.stderr}`.trim(),
        );
      }

      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("artifacts", () => {
  it("updates manifest only when discovery structure changes", async () => {
    const rootDir = createTempProject({
      "src/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
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
        `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: false, version: 2 }) });`,
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
        `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
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
      "src/modules/widget/get.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => ({ ok: true }) });`,
      "src/modules/widget/upsert.mutation.ts": `${dispatchkitImportLine()}\nexport default defineMutation({ handler: async () => ({ id: "1" }) });`,
      "src/modules/widget/sync.action.ts": `${dispatchkitImportLine()}\nexport default defineAction({ handler: async () => ({ synced: true }) });`,
      "src/infra/data.ts": `${dispatchkitImportLine()}\nexport default defineInfra(() => ({ data: {} }));`,
      "src/infra/my-transport.ts": `${dispatchkitImportLine()}\nexport default defineTransport(() => ({ kind: "first" }));`,
      "src/infra/my-second-transport/index.ts": `${dispatchkitImportLine()}\nexport default defineTransport(() => ({ kind: "second" }));`,
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
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
