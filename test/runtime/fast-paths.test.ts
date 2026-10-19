/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- runtime.transport is untyped here: these tests do not load generated types */
import { describe, expect, it } from "bun:test";

import { buildRuntime } from "../../src/index.ts";
import { dispatchkitImportLine, withTempProject } from "../test-helpers.ts";

const imp = dispatchkitImportLine();

const serverTransport = `${imp}
class Server {
  options = { port: 80 };
  #label = "";
  get name() { return getTransportCtx().config.SERVICE_NAME; }
  set label(value: string) { this.#label = value + "@" + getTransportCtx().config.SERVICE_NAME; }
  get label() { return this.#label; }
  port() { return this.options.port; }
  setPort(port: number) { this.options.port = port; }
}
export default defineTransport(() => new Server());`;

describe("runtime fast paths", () => {
  it("keeps accessors in the owning transport context while data properties skip it", async () => {
    await withTempProject({ "src/transport/server.ts": serverTransport }, async (rootA) => {
      const a = await buildRuntime({
        rootDir: rootA,
        mountGlobal: false,
        config: { SERVICE_NAME: "A" },
      });
      await withTempProject({ "src/transport/server.ts": serverTransport }, async (rootB) => {
        const b = await buildRuntime({ rootDir: rootB, config: { SERVICE_NAME: "B" } });
        const server = (a.transport as any).server;

        expect(server.name).toBe("A");
        server.label = "x";
        expect(server.label).toBe("x@A");

        server.options.port = 8080;
        expect(server.port()).toBe(8080);
        server.setPort(9000);
        expect(server.options.port).toBe(9000);
        await b.dispose();
      });
      await a.dispose();
    });
  });

  it("resolves allowlisted callers in directories with parentheses and custom stack formatters", async () => {
    await withTempProject(
      {
        "src/app/(group)/route.ts": `${imp}
export const readName = () => getTransportCtx().config.SERVICE_NAME;`,
        "src/lib/other.ts": `${imp}
export const readOther = () => getTransportCtx().config.SERVICE_NAME;`,
        "src/transport/http.ts": `${imp}
import { readName } from "../app/(group)/route.ts";
import { readOther } from "../lib/other.ts";
export default defineTransport(() => ({ route: () => readName(), other: () => readOther() }), {
  allowGetTransportCtxFrom: ["app/**/*.ts"],
});`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        const http = (runtime.transport as any).http;
        expect(http.route()).toBe("dispatchkit-test-service");
        expect(() => void http.other()).toThrow("DISPATCHKIT_CONTEXT_FORBIDDEN");

        const previous: unknown = Reflect.get(Error, "prepareStackTrace");
        Error.prepareStackTrace = (_error, callSites) => callSites;
        try {
          expect(http.route()).toBe("dispatchkit-test-service");
          expect(() => void http.other()).toThrow("DISPATCHKIT_CONTEXT_FORBIDDEN");
        } finally {
          Reflect.set(Error, "prepareStackTrace", previous);
        }
        await runtime.dispose();
      },
    );
  });

  it("reports validator exceptions and issues from synchronous and asynchronous schemas", async () => {
    await withTempProject(
      {
        "src/modules/sync.query.ts": `${imp}
import { z } from "zod";
export default defineQuery({ input: z.object({ n: z.number() }), handler: (ctx) => ctx.input.n });`,
        "src/modules/throws.query.ts": `${imp}
const schema = { "~standard": { version: 1, vendor: "custom", validate: () => { throw new Error("boom"); } } };
export default defineQuery({ input: schema, handler: () => 1 });`,
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, mountGlobal: false });
        const query = (runtime.bus as any).query;

        expect(await query.sync({ n: 2 })).toBe(2);
        const invalid = await query.sync({ n: "x" }).catch((error: Error) => error);
        expect(invalid.message).toContain("sync failed input validation");
        expect(invalid.cause.issues[0].path).toEqual(["n"]);

        const thrown = await query.throws({}).catch((error: Error) => error);
        expect(thrown.message).toContain("throws failed input validation");
        expect(thrown.cause.message).toBe("boom");
        await runtime.dispose();
      },
    );
  });
});
