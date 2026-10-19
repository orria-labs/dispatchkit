/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- runtime.bus/transport are untyped here: these tests do not load generated types */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { buildRuntime } from "../../src/index.ts";
import {
  dispatchkitImportLine,
  runCommand,
  runtimeImport,
  withTempProject,
} from "../test-helpers.ts";

describe("runtime audit regressions", () => {
  it("preserves transport instances, private fields, cycles and asynchronous context", async () => {
    await withTempProject(
      {
        "src/transport/server.ts": `${dispatchkitImportLine()}
export const identity = Symbol("identity");
export class Server {
  #count = 1;
  self = this;
  list = [this];
  values = new Map([["ready", true]]);
  constructor() {
    Object.defineProperty(this, "hidden", { value: "secret", enumerable: false });
  }
  get count() { return this.#count; }
  set count(value) { this.#count = value; }
  [identity]() { return this.#count; }
  read() { return [getTransportCtx().config.SERVICE_NAME, this.#count]; }
  fluent() { return this; }
  async fluentAsync() { await Promise.resolve(); return this; }
  callback() { return () => getTransportCtx().config.SERVICE_NAME; }
  async later() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return this.read();
  }
}
export const original = new Server();
export default defineTransport(() => original);`,
      },
      async (rootDir) => {
        const first = await buildRuntime({ rootDir, SERVICE_NAME: "first" });
        const server = (first.transport as any).server;
        const module = await import(join(rootDir, "src/transport/server.ts"));
        expect(server).toBeInstanceOf(module.Server);
        expect(server.constructor).toBe(module.Server);
        expect(Object.getPrototypeOf(server)).toBe(module.Server.prototype);
        expect(server.self).toBe(server);
        expect(server.list[0]).toBe(server);
        expect(server.read).toBe(server.read);
        expect(server.fluent()).toBe(server);
        expect(await server.fluentAsync()).toBe(server);
        expect(server.hidden).toBe("secret");
        expect(Object.keys(server)).not.toContain("hidden");
        server.count = 3;
        expect(module.original.count).toBe(3);
        expect(server[module.identity]()).toBe(3);
        expect(server.values).toBeInstanceOf(Map);
        expect(server.values.get("ready")).toBe(true);
        expect(server.values.set("extra", false)).toBe(server.values);
        expect([...server.values]).toEqual([
          ["ready", true],
          ["extra", false],
        ]);

        const callback = server.callback();
        await buildRuntime({ rootDir, SERVICE_NAME: "second" });
        expect(server.read()).toEqual(["first", 3]);
        expect(callback()).toBe("first");
        expect(await server.later()).toEqual(["first", 3]);
      },
    );
  });

  it("isolates transport allowlists and allows each transport's own file", async () => {
    await withTempProject(
      {
        "src/lib/shared.ts": `${dispatchkitImportLine()}
export const readShared = () => getTransportCtx().config.SERVICE_NAME;`,
        "src/transport/plain.ts": `${dispatchkitImportLine()}
import { readShared } from "../lib/shared.ts";
export default defineTransport(() => ({
  read: () => getTransportCtx().config.SERVICE_NAME,
  shared: () => readShared(),
}));`,
        "src/transport/strict.ts": `${dispatchkitImportLine()}
import { readShared } from "../lib/shared.ts";
export default defineTransport(() => ({ read: () => readShared() }), {
  allowGetTransportCtxFrom: ["lib/shared.ts"],
});`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir });
        const transport = runtime.transport as any;
        expect(transport.strict.read()).toBe("dispatchkit-test-service");
        expect(transport.plain.read()).toBe("dispatchkit-test-service");
        expect(() => transport.plain.shared()).toThrow("DISPATCHKIT_CONTEXT_FORBIDDEN");
      },
    );
  });

  it("passes native HTTP and binary values to consumers without proxies", async () => {
    await withTempProject(
      {
        "src/transport/http.ts": `${dispatchkitImportLine()}
export default defineTransport(() => ({
  handle: async () => new Response("native response"),
  response: () => new Response("direct response"),
  bytes: new Uint8Array([65, 66]),
  buffer: new Uint8Array([67, 68]).buffer,
  stream: () => new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("stream response"));
    controller.close();
  } }),
}));`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        const http = (runtime.transport as any).http;
        const server = Bun.serve({ port: 0, fetch: () => http.handle() });
        try {
          expect(ArrayBuffer.isView(http.bytes)).toBe(true);
          expect([...new Uint8Array(http.buffer)]).toEqual([67, 68]);
          expect(await new Response(http.bytes).text()).toBe("AB");
          expect(await new Response(http.stream()).text()).toBe("stream response");
          expect(await http.response().text()).toBe("direct response");
          const response = await fetch(server.url);
          expect(response.status).toBe(200);
          expect(await response.text()).toBe("native response");
        } finally {
          await server.stop(true);
          await runtime.dispose();
        }
      },
    );
  });

  it("unwraps arguments and receivers from other transport instances", async () => {
    await withTempProject(
      {
        "src/lib/server.ts": `export class Server {
  #key = 1;
  same(other) { return this.#key === other.#key; }
}`,
        "src/transport/one.ts": `${dispatchkitImportLine()}
import { Server } from "../lib/server.ts";
export default defineTransport(() => new Server());`,
        "src/transport/two.ts": `${dispatchkitImportLine()}
import { Server } from "../lib/server.ts";
export default defineTransport(() => new Server());`,
      },
      async (rootDir) => {
        const first = await buildRuntime({ rootDir, mountGlobal: false });
        const second = await buildRuntime({ rootDir, mountGlobal: false });
        try {
          const one = (first.transport as any).one;
          const two = (first.transport as any).two;
          expect(one.same(two)).toBe(true);
          expect(one.same.call(two, one)).toBe(true);
          expect(one.same((second.transport as any).two)).toBe(true);
        } finally {
          await Promise.all([first.dispose(), second.dispose()]);
        }
      },
    );
  });

  it("uses the original console sink after a silent runtime", async () => {
    await withTempProject(
      {
        "probe.ts": `import { buildRuntime } from ${JSON.stringify(runtimeImport)};
const rootDir = import.meta.dir;
await buildRuntime({ rootDir, LOG_LEVEL: "silent" });
const runtime = await buildRuntime({ rootDir, LOG_LEVEL: "debug" });
runtime.logger.error("audit-error-visible");
runtime.logger.debug("audit-debug-visible");`,
      },
      (rootDir) => {
        const result = runCommand([process.execPath, "probe.ts"], rootDir);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("audit-error-visible");
        expect(result.stdout + result.stderr).toContain("audit-debug-visible");
        return Promise.resolve();
      },
    );
  });

  it("keeps constructor namespaces and __proto__ layer keys as ordinary entries", async () => {
    const before = Object.getOwnPropertyDescriptor(Object, "auditprobe");
    await withTempProject(
      {
        "src/modules/constructor/auditprobe.query.ts": `${dispatchkitImportLine()}
export default defineQuery({ handler: () => "safe" });`,
        "src/infra/__proto__.ts": `${dispatchkitImportLine()}
export default defineInfra(() => ({ marker: "infra" }));`,
        "src/transport/__proto__.ts": `${dispatchkitImportLine()}
export default defineTransport(() => ({ marker: "transport" }));`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir });
        const query = runtime.bus.query as any;
        expect(Object.getPrototypeOf(query)).toBeNull();
        expect(Object.getPrototypeOf(query.constructor)).toBeNull();
        expect(Object.getOwnPropertyDescriptor(Object, "auditprobe")).toEqual(before);
        expect(await query.constructor.auditprobe()).toBe("safe");
        expect(await query.constructorAuditprobe()).toBe("safe");
        expect(Object.getPrototypeOf(runtime.infra)).toBeNull();
        expect(Object.getPrototypeOf(runtime.transport)).toBeNull();
        expect(Object.hasOwn(runtime.infra, "__proto__")).toBe(true);
        expect(Object.hasOwn(runtime.transport, "__proto__")).toBe(true);
        expect((runtime.infra as any).__proto__.marker).toBe("infra");
        expect((runtime.transport as any).__proto__.marker).toBe("transport");
      },
    );
  });
});
