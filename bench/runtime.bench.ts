/**
 * Runtime micro-benchmarks.
 *
 *   bun run bench               compare with bench/baseline.json
 *   bun run bench -- --check    exit 1 when a scenario regresses beyond the threshold (default 25%)
 *   bun run bench:update        rewrite bench/baseline.json
 *
 * Every scenario reports the median ns/op of several rounds after warmup.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { buildRuntime } from "../src/index.ts";

type Baseline = {
  meta: { bun: string; platform: string; arch: string; cpu: string; date: string };
  results: Record<string, number>;
};
type Scenario = { name: string; iterations: number; run: () => unknown };

const ROUNDS = 7;
const repoRoot = join(import.meta.dir, "..");
const baselinePath = join(import.meta.dir, "baseline.json");
const entry = JSON.stringify(join(repoRoot, "src", "index.ts"));

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    update: { type: "boolean" },
    check: { type: "boolean" },
    threshold: { type: "string", default: "25" },
  },
});

const FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "bench-service", version: "1.0.0" }),
  "src/modules/ping.query.ts": `import { defineQuery } from ${entry};
export default defineQuery({ handler: async ({ input }) => input });`,
  "src/modules/zod.query.ts": `import { defineQuery } from ${entry};
import { z } from "zod";
export default defineQuery({ input: z.object({ a: z.number() }), handler: async ({ input }) => input });`,
  "src/modules/valibot.query.ts": `import { defineQuery } from ${entry};
import * as v from "valibot";
export default defineQuery({ input: v.object({ a: v.number() }), handler: async ({ input }) => input });`,
  "src/modules/nested.query.ts": `import { defineQuery } from ${entry};
export default defineQuery({ handler: async ({ input, bus }) => bus.query.ping(input) });`,
  "src/transport/plain.ts": `import { defineTransport, getTransportCtx } from ${entry};
export default defineTransport(() => ({
  noop: () => 1,
  ctx: () => getTransportCtx().config.SERVICE_NAME,
}));`,
  "src/transport/instance.ts": `import { defineTransport } from ${entry};
class Server { #hits = 0; hit() { return ++this.#hits; } }
export default defineTransport(() => new Server());`,
  "src/transport/guarded.ts": `import { defineTransport, getTransportCtx } from ${entry};
import { readName } from "../lib/name.ts";
export default defineTransport(() => ({ ctx: () => readName() }), {
  allowGetTransportCtxFrom: ["lib/**/*.ts"],
});`,
  "src/lib/name.ts": `import { getTransportCtx } from ${entry};
export const readName = () => getTransportCtx().config.SERVICE_NAME;`,
};

function createFixture(): string {
  const rootDir = mkdtempSync(join(tmpdir(), "dispatchkit-bench-"));
  for (const [path, content] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(rootDir, path)), { recursive: true });
    writeFileSync(join(rootDir, path), content);
  }
  symlinkSync(join(repoRoot, "node_modules"), join(rootDir, "node_modules"), "dir");
  return rootDir;
}

const median = (samples: number[]): number =>
  [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]!;

async function measure({ iterations, run }: Scenario): Promise<number> {
  const call = async () => {
    const result = run();
    if (result instanceof Promise) await result;
  };
  for (let index = 0; index < Math.min(iterations, 5_000); index += 1) await call();

  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = Bun.nanoseconds();
    for (let index = 0; index < iterations; index += 1) await call();
    samples.push((Bun.nanoseconds() - start) / iterations);
  }
  return Math.round(median(samples) * 10) / 10;
}

async function readBaseline(): Promise<Baseline | undefined> {
  const file = Bun.file(baselinePath);
  return (await file.exists()) ? ((await file.json()) as Baseline) : undefined;
}

const rootDir = createFixture();
try {
  const srcDir = join(rootDir, "src");
  const buildOptions = { rootDir, srcDir, generateArtifacts: false, mountGlobal: false } as const;

  const buildStart = Bun.nanoseconds();
  const runtime = await buildRuntime(buildOptions);
  const coldBuildMs = (Bun.nanoseconds() - buildStart) / 1e6;

  // The fixture has no generated types: access members dynamically.
  const bus = runtime.bus as unknown as Record<
    string,
    Record<string, (input?: unknown) => unknown>
  >;
  const transport = runtime.transport as unknown as Record<string, Record<string, () => unknown>>;
  const query = bus.query!;
  const ping = query.ping as ((input?: unknown) => unknown) & {
    $unsafe: (input?: unknown) => unknown;
  };

  const scenarios: Scenario[] = [
    { name: "bus: query without schema", iterations: 200_000, run: () => ping({}) },
    { name: "bus: query $unsafe", iterations: 200_000, run: () => ping.$unsafe({}) },
    { name: "bus: query with zod input", iterations: 200_000, run: () => query.zod!({ a: 1 }) },
    {
      name: "bus: query with valibot input",
      iterations: 200_000,
      run: () => query.valibot!({ a: 1 }),
    },
    { name: "bus: nested query (2 levels)", iterations: 200_000, run: () => query.nested!({}) },
    {
      name: "transport: plain object method",
      iterations: 500_000,
      run: () => transport.plain!.noop!(),
    },
    {
      name: "transport: class instance method",
      iterations: 500_000,
      run: () => transport.instance!.hit!(),
    },
    {
      name: "transport: getTransportCtx() from own file",
      iterations: 500_000,
      run: () => transport.plain!.ctx!(),
    },
    {
      name: "transport: getTransportCtx() via allowlist",
      iterations: 50_000,
      run: () => transport.guarded!.ctx!(),
    },
    {
      name: "buildRuntime (warm, 7 modules)",
      iterations: 30,
      run: () => buildRuntime(buildOptions),
    },
  ];

  const results: Record<string, number> = {};
  for (const scenario of scenarios) {
    results[scenario.name] = await measure(scenario);
  }

  const baseline = await readBaseline();
  const threshold = Number(values.threshold);
  const regressions: string[] = [];
  const rows = scenarios.map(({ name }) => {
    const current = results[name]!;
    const previous = baseline?.results[name];
    const delta = previous ? ((current - previous) / previous) * 100 : undefined;
    if (delta !== undefined && delta > threshold) regressions.push(name);
    return {
      scenario: name,
      "ns/op": current,
      baseline: previous ?? "-",
      delta: delta === undefined ? "-" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`,
    };
  });

  console.log(`cold buildRuntime: ${coldBuildMs.toFixed(1)} ms (first import of all modules)`);
  console.table(rows);

  if (values.update) {
    const next: Baseline = {
      meta: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model ?? "unknown",
        date: new Date().toLocaleDateString("sv"), // local YYYY-MM-DD
      },
      results,
    };
    await Bun.write(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`baseline written to ${baselinePath}`);
  } else if (values.check && regressions.length > 0) {
    console.error(`regressions over ${threshold}%: ${regressions.join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(rootDir, { recursive: true, force: true });
}
