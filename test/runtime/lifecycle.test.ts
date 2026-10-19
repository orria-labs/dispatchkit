import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { buildRuntime, getModuleCtx } from "../../src/index.ts";
import { dispatchkitImportLine, withTempProject } from "../test-helpers.ts";

const imp = dispatchkitImportLine();

describe("runtime lifecycle", () => {
  it("imports transports located in infra once, after infra is ready", async () => {
    (globalThis as any).__infraTransportImports = 0;
    try {
      await withTempProject(
        {
          "src/infra/db.ts": `${imp} export default defineInfra(() => ({ ready: true }));`,
          "src/infra/http.ts": `${imp}
globalThis.__infraTransportImports++;
const name = getTransportCtx().config.SERVICE_NAME;
const ready = getModuleCtx().infra.db.ready;
export default defineTransport(() => ({ name, ready }));`,
        },
        async (rootDir) => {
          const runtime = await buildRuntime({ rootDir, mountGlobal: false });
          expect((runtime.transport as any).http.name).toBe("dispatchkit-test-service");
          expect((runtime.transport as any).http.ready).toBe(true);
          expect((globalThis as any).__infraTransportImports).toBe(1);
          await runtime.dispose();
        },
      );
    } finally {
      delete (globalThis as any).__infraTransportImports;
    }
  });

  it("keeps the active runtime and console intact after a failed rebuild", async () => {
    await withTempProject({}, async (rootDir) => {
      const first = await buildRuntime({ rootDir });
      const mountedConsole = console;
      await expect(buildRuntime({ rootDir, NODE_ENV: "invalid" })).rejects.toThrow("NODE_ENV");
      expect((globalThis as any).runtime).toBe(first);
      expect(console).toBe(mountedConsole);
      expect(getModuleCtx().config).toBe(first.config);
      await first.dispose();
    });
  });

  it("isolates top-level transport imports across concurrent applications", async () => {
    const files = {
      "src/transport/http.ts": `${imp}
await Bun.sleep(5);
const name = getTransportCtx().config.SERVICE_NAME;
export default defineTransport(() => ({ name }));`,
    };
    await withTempProject(files, async (firstRoot) => {
      await withTempProject(files, async (secondRoot) => {
        const [first, second] = await Promise.all([
          buildRuntime({
            rootDir: firstRoot,
            SERVICE_NAME: "first",
            mountGlobal: false,
            generateArtifacts: false,
          }),
          buildRuntime({
            rootDir: secondRoot,
            SERVICE_NAME: "second",
            mountGlobal: false,
            generateArtifacts: false,
          }),
        ]);
        expect((first.transport as any).http.name).toBe("first");
        expect((second.transport as any).http.name).toBe("second");
        await Promise.all([first.dispose(), second.dispose()]);
      });
    });
  });

  it("rejects reentrant builds during module evaluation instead of deadlocking", async () => {
    await withTempProject(
      {
        "src/transport/http.ts": `${imp}
import { buildRuntime } from ${JSON.stringify(join(import.meta.dir, "../../src/index.ts"))};
await buildRuntime({ rootDir: import.meta.dir });
export default defineTransport(() => ({}));`,
      },
      async (rootDir) => {
        await expect(buildRuntime({ rootDir, mountGlobal: false })).rejects.toThrow(
          "DISPATCHKIT_REENTRANT_BUILD",
        );
      },
    );
    // A rejected import must also release the evaluation queue.
    await withTempProject({}, async (rootDir) => {
      const runtime = await buildRuntime({ rootDir, mountGlobal: false });
      await runtime.dispose();
    });
  });

  it("cleans resources in reverse order and disposes only once", async () => {
    const events: string[] = [];
    (globalThis as any).__lifecycleEvents = events;
    try {
      await withTempProject(
        {
          "src/infra/db.ts": `${imp} export default defineInfra(({ onDispose }) => { onDispose(() => { globalThis.__lifecycleEvents.push("db"); }); return {}; });`,
          "src/transport/http.ts": `${imp} export default defineTransport(({ onDispose }) => { onDispose(async () => { globalThis.__lifecycleEvents.push("http"); }); return {}; });`,
          "src/modules/ping.query.ts": `${imp} export default defineQuery({ handler: () => 1 });`,
        },
        async (rootDir) => {
          const runtime = await buildRuntime({ rootDir, mountGlobal: false });
          expect(await (runtime.bus as any).query.ping()).toBe(1);
          await Promise.all([runtime.dispose(), runtime.dispose()]);
          expect(events).toEqual(["http", "db"]);
          await expect((runtime.bus as any).query.ping()).rejects.toThrow(
            "DISPATCHKIT_RUNTIME_DISPOSED",
          );
        },
      );
    } finally {
      delete (globalThis as any).__lifecycleEvents;
    }
  });

  it("rolls back registered resources if initialization fails", async () => {
    const events: string[] = [];
    (globalThis as any).__lifecycleEvents = events;
    try {
      await withTempProject(
        {
          "src/infra/db.ts": `${imp} export default defineInfra(({ onDispose }) => { onDispose(() => { globalThis.__lifecycleEvents.push("db"); }); return {}; });`,
          "src/transport/http.ts": `${imp} export default defineTransport(({ onDispose }) => { onDispose(() => { globalThis.__lifecycleEvents.push("http"); }); throw new Error("listen failed"); });`,
        },
        async (rootDir) => {
          await expect(buildRuntime({ rootDir })).rejects.toThrow("listen failed");
          expect(events).toEqual(["http", "db"]);
        },
      );
    } finally {
      delete (globalThis as any).__lifecycleEvents;
    }
  });

  it("runs cleanup in its original runtime context after another runtime is mounted", async () => {
    const events: string[] = [];
    (globalThis as any).__lifecycleEvents = events;
    try {
      await withTempProject(
        {
          "src/infra/db.ts": `${imp} export default defineInfra(({ onDispose }) => {
  onDispose(async () => {
    await Promise.resolve();
    globalThis.__lifecycleEvents.push("db:" + getModuleCtx().config.SERVICE_NAME);
  });
  return {};
});`,
          "src/transport/http.ts": `${imp} export default defineTransport(({ onDispose }) => {
  onDispose(async () => {
    await Promise.resolve();
    globalThis.__lifecycleEvents.push("http:" + getTransportCtx().config.SERVICE_NAME);
  });
  return {};
});`,
        },
        async (rootDir) => {
          const first = await buildRuntime({ rootDir, SERVICE_NAME: "first" });
          const second = await buildRuntime({ rootDir, SERVICE_NAME: "second" });
          await first.dispose();
          expect(events).toEqual(["http:first", "db:first"]);
          expect((globalThis as any).runtime).toBe(second);
          await second.dispose();
          expect(events).toEqual(["http:first", "db:first", "http:second", "db:second"]);
        },
      );
    } finally {
      delete (globalThis as any).__lifecycleEvents;
    }
  });

  it("preserves factory contexts during initialization rollback", async () => {
    const events: string[] = [];
    (globalThis as any).__lifecycleEvents = events;
    try {
      await withTempProject(
        {
          "src/infra/db.ts": `${imp} export default defineInfra(({ onDispose }) => {
  onDispose(() => { globalThis.__lifecycleEvents.push(getModuleCtx().config.SERVICE_NAME); });
  return {};
});`,
          "src/transport/http.ts": `${imp} export default defineTransport(({ onDispose }) => {
  onDispose(() => { globalThis.__lifecycleEvents.push(getTransportCtx().config.SERVICE_NAME); });
  throw new Error("initialization failed");
});`,
        },
        async (rootDir) => {
          await expect(buildRuntime({ rootDir, SERVICE_NAME: "rollback" })).rejects.toThrow(
            "initialization failed",
          );
          expect(events).toEqual(["rollback", "rollback"]);
        },
      );
    } finally {
      delete (globalThis as any).__lifecycleEvents;
    }
  });

  it("isolates concurrent builds and can run without globals or artifact writes", async () => {
    const active = (globalThis as any).runtime;
    const mountedConsole = console;
    await withTempProject(
      {
        "src/transport/http.ts": `${imp} export default defineTransport(async ({ config }) => {
  await Bun.sleep(config.SERVICE_NAME === "first" ? 20 : 1);
  const name = getModuleCtx().config.SERVICE_NAME;
  return { read: () => name, live: () => getTransportCtx().config.SERVICE_NAME };
});`,
      },
      async (rootDir) => {
        const options = { rootDir, mountGlobal: false, generateArtifacts: false };
        const [first, second] = await Promise.all([
          buildRuntime({ ...options, SERVICE_NAME: "first" }),
          buildRuntime({ ...options, SERVICE_NAME: "second" }),
        ]);
        expect((first.transport as any).http.read()).toBe("first");
        expect((second.transport as any).http.read()).toBe("second");
        expect((first.transport as any).http.live()).toBe("first");
        expect((second.transport as any).http.live()).toBe("second");
        expect((globalThis as any).runtime).toBe(active);
        expect(console).toBe(mountedConsole);
        expect(existsSync(join(rootDir, "src/generated"))).toBe(false);
        await Promise.all([first.dispose(), second.dispose()]);
      },
    );
  });
});
