import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { generateRuntime } from "../../src/index.ts";
import {
  dispatchkitImportLine,
  runCommand,
  runtimeImport,
  withTempProject,
} from "../test-helpers.ts";

describe("types", () => {
  it("propagates generated config typing into buildRuntime return type", async () => {
    await withTempProject(
      {
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
      },
      async (rootDir) => {
        await generateRuntime({
          rootDir,
          srcDir: join(rootDir, "src"),
        });

        const result = runCommand(
          ["bun", "x", "tsc", "-p", "tsconfig.json", "--noEmit"],
          rootDir,
        );

        if (result.exitCode !== 0) {
          throw new Error(`Typecheck failed:\n${result.stdout}\n${result.stderr}`.trim());
        }

        expect(result.exitCode).toBe(0);
      },
    );
  });
});
