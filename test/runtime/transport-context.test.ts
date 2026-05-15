import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildRuntime } from "../../src/index.ts";
import { dispatchkitImportLine, withTempProject } from "../test-helpers.ts";

describe("runtime transport context allowlist", () => {
  it("supports routes shorthand and top-level getTransportCtx during transport import", async () => {
    await withTempProject(
      {
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
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
        const transport = runtime.transport as any;

        expect(transport.http.boot()).toBe("dispatchkit-test-service");
        expect(transport.http.route()).toBe("dispatchkit-test-service");
        expect(() => transport.http.forbidden()).toThrow("DISPATCHKIT_CONTEXT_FORBIDDEN");
      },
    );
  });

  it("treats allowGetTransportCtxFrom as extension of default locations", async () => {
    await withTempProject(
      {
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
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
        const transport = runtime.transport as any;

        expect(transport.http.direct()).toBe("dispatchkit-test-service");
        expect(transport.http.helper()).toBe("dispatchkit-test-service");
        expect(() => transport.http.forbidden()).toThrow("DISPATCHKIT_CONTEXT_FORBIDDEN");
      },
    );
  });

  it("allows getTransportCtx only from configured src-relative paths", async () => {
    await withTempProject(
      {
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
      },
      async (rootDir) => {
        const runtime = await buildRuntime({ rootDir, srcDir: join(rootDir, "src") });
        const transport = runtime.transport as any;

        expect(transport.mytransport.direct()).toBe("dispatchkit-test-service");
        expect(transport.mytransport.allowed()).toBe("dispatchkit-test-service");
        expect(() => transport.mytransport.forbidden()).toThrow(
          "DISPATCHKIT_CONTEXT_FORBIDDEN",
        );
      },
    );
  });
});
