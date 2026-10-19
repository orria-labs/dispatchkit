# Benchmarks

```bash
bun run bench:compare                       # A/B: working tree vs HEAD (5 runs, fail above +5%)
bun run bench:compare -- --ref v1.1.0 --runs 7 --threshold 5
bun run bench                               # compare with baseline.json
bun run bench -- --check                    # exit 1 if a scenario is >5% slower than the baseline
bun run bench:update                        # rewrite baseline.json
```

`runtime.bench.ts` builds a temporary fixture project (4 operations, 3 transports) against the
local sources. Each scenario measures the median ns/op of 7 rounds after a forced GC and a warmup;
the suite repeats (`--runs`, default 3) and the best run is reported. Background load can only
add time, so the minimum is the least noisy estimate.

## Deciding whether a change is slower

Use `bun run bench:compare`. It copies the working tree and checks out the revision (default
`HEAD`) into temporary directories (installing the revision's own dependencies when its lockfile
differs), runs the **current** benchmark script on both sides in alternating order, and compares
the best ns/op per scenario. Because both sides share one session, machine-load drift affects
them equally: on a busy laptop an A/A comparison stays within about ±5%, while comparisons against
a stored baseline can drift by ±10–15%. If a scenario lands just above the threshold, rerun with
more runs (`--runs 9`) before treating it as a regression.

`baseline.json` documents the reference numbers for this machine and is updated deliberately
(`bench:update`) when a change is expected to move them.

## Scenarios

| Scenario                                 | What it measures                                                     |
| ---------------------------------------- | -------------------------------------------------------------------- |
| bus: query without schema / `$unsafe`    | CQRS guard, scope switch, handler call                               |
| bus: query with zod / valibot input      | the same plus Standard Schema validation                             |
| bus: nested query (2 levels)             | a handler calling another operation through `ctx.bus`                |
| transport: plain object / class instance | a transport method call through the context proxy                    |
| transport: `getTransportCtx()` …         | caller resolution and allowlist check (own file, allowlisted helper) |
| `buildRuntime` (warm, 7 modules)         | a rebuild with cached modules, no artifacts, no globals              |

## History

`baseline.json` is versioned: the commit that adds the suite records 1.1.0, later commits record
the optimized runtime. See the package README for the 1.1.0 → 1.2.0 A/B comparison.
