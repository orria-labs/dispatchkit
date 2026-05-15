import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildRuntime } from "../../src/index.ts";
import { dispatchkitImportLine, withTempProject } from "../test-helpers.ts";

describe("data config", () => {
  it("applies defaults < env < options and extends schema from config.ts", async () => {
    await withTempProject(
      {
        ".env": "SERVICE_NAME=from-env\nLOG_LEVEL=error\nCUSTOM_FLAG=env-value\n",
        "src/config.ts": `${dispatchkitImportLine()}\nimport { z } from "zod";\nexport default defineConfig(z.object({ CUSTOM_FLAG: z.string(), FEATURE_TOGGLE: z.string().default("from-schema") }));`,
        "src/modules/ping.query.ts": `${dispatchkitImportLine()}\nexport default defineQuery({ handler: async () => getModuleCtx().config });`,
      },
      async (rootDir) => {
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
      },
    );
  });
});
