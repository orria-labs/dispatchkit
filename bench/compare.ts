/**
 * A/B benchmark: the working tree against a git revision, in one session.
 *
 *   bun run bench:compare                       # vs HEAD, 5 alternating runs, fail above +5%
 *   bun run bench:compare -- --ref origin/main --runs 7 --threshold 5
 *
 * Both sides run the *current* bench/runtime.bench.ts (copied into a temporary worktree of the
 * revision), alternating their order every run so machine-load drift affects both equally.
 * Compares the best (minimum) ns/op per scenario across runs: background load can only add
 * time, so the minimum is the least noisy estimate. Exits 1 when any scenario is slower than
 * the threshold.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    ref: { type: "string", default: "HEAD" },
    runs: { type: "string", default: "5" },
    threshold: { type: "string", default: "5" },
  },
});

const repoRoot = join(import.meta.dir, "..");
const runs = Math.max(1, Number(values.runs) || 1);
const threshold = Number(values.threshold);

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed in ${cwd}:\n${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

const best = (items: number[]): number => Math.min(...items);

const tempDir = mkdtempSync(join(tmpdir(), "dispatchkit-bench-"));
const refDir = join(tempDir, "ref");
// The working tree is copied next to the revision so both sides run from the same kind of
// location (the repository itself can be slower, e.g. while it is being indexed).
const currentDir = join(tempDir, "current");
run(["git", "worktree", "add", "--detach", "--quiet", refDir, values.ref], repoRoot);
try {
  for (const entry of ["src", "bench", "package.json", "tsconfig.json", "bunfig.toml"]) {
    cpSync(join(repoRoot, entry), join(currentDir, entry), { recursive: true });
  }
  symlinkSync(join(repoRoot, "node_modules"), join(currentDir, "node_modules"), "dir");
  // Older revisions may need other dependencies (e.g. 1.1.0 still used dotenv).
  const sameLock =
    readFileSync(join(refDir, "bun.lock"), "utf8") ===
    readFileSync(join(repoRoot, "bun.lock"), "utf8");
  if (sameLock) {
    symlinkSync(join(repoRoot, "node_modules"), join(refDir, "node_modules"), "dir");
  } else {
    run(["bun", "install", "--frozen-lockfile"], refDir);
  }
  cpSync(join(repoRoot, "bench", "runtime.bench.ts"), join(refDir, "bench", "runtime.bench.ts"));

  const sides = { ref: refDir, current: currentDir } as const;
  const samples: Record<keyof typeof sides, Record<string, number[]>> = { ref: {}, current: {} };
  for (let index = 0; index < runs; index += 1) {
    const order = index % 2 === 0 ? (["ref", "current"] as const) : (["current", "ref"] as const);
    for (const side of order) {
      const output = run(["bun", "bench/runtime.bench.ts", "--json", "--runs", "1"], sides[side]);
      const results = JSON.parse(output.trim().split("\n").at(-1)!) as Record<string, number>;
      for (const [name, value] of Object.entries(results)) {
        (samples[side][name] ??= []).push(value);
      }
    }
    process.stderr.write(`run ${index + 1}/${runs} done\n`);
  }

  const regressions: string[] = [];
  const rows = Object.keys(samples.current).map((name) => {
    const current = best(samples.current[name]!);
    const ref = samples.ref[name] ? best(samples.ref[name]) : undefined;
    const delta = ref ? ((current - ref) / ref) * 100 : undefined;
    if (delta !== undefined && delta > threshold) regressions.push(name);
    return {
      scenario: name,
      [values.ref]: ref ?? "-",
      current,
      delta: delta === undefined ? "-" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`,
    };
  });
  console.table(rows);
  if (regressions.length > 0) {
    console.error(
      `slower than ${values.ref} by more than ${threshold}%: ${regressions.join(", ")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`no scenario is slower than ${values.ref} by more than ${threshold}%`);
  }
} finally {
  run(["git", "worktree", "remove", "--force", refDir], repoRoot);
  rmSync(tempDir, { recursive: true, force: true });
}
