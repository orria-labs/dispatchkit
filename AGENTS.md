# Agent guidelines for `@orria/dispatchkit`

Bun-only TypeScript package (Bun 1.4.3+, TypeScript 7). Sources in `src/`, tests in `test/`,
benchmarks in `bench/`.

## Before every commit

```bash
bun run verify   # bun fmt --check, bun lint --max-warnings=0, bun check, bun test ./test
```

- Format with `bun fmt`, lint with `bun lint` (type-aware, zero warnings), type check with
  `bun check`. Do not add Prettier, ESLint or tsc-based checks.
- Do not define `lint`, `fmt` or `check` scripts in `package.json`: `bun lint`/`bun fmt`/`bun check`
  would run them instead of the built-ins.

## Compatibility

- Published releases are a contract. Minor and patch versions must not change observable
  behaviour of the public API: error codes and messages, timing of validation and handlers
  (microtasks included), transport proxy semantics, discovery and infra start-up order, config
  precedence, generated artifacts.
- `test/runtime/compat-1.1.test.ts` pins behaviour that optimizations once broke. Keep it green;
  extend it when you find another difference.

## Performance rule

**Changes must not make the runtime slower.** No benchmark scenario may get more than **5%**
slower than the code it replaces; the expected outcome is equal or faster.

1. Before committing a change to `src/`, run the A/B comparison against the commit you started
   from:

   ```bash
   bun run bench:compare                    # working tree vs HEAD
   bun run bench:compare -- --ref main      # a branch vs main
   ```

2. It must end with `no scenario is slower than <ref> by more than 5%` (exit code 0). The
   comparison alternates both versions in one session; on a loaded machine its noise is about
   ±5%, so if a scenario lands slightly above the limit, rerun with `--runs 9` before concluding
   it is a regression. Never raise `--threshold` to make a change pass.
3. A real regression is fixed or the change is dropped. The only exception is a correctness or
   compatibility fix that cannot be made without the cost; then state the measured cost in the
   commit message and get explicit approval from a maintainer.
4. When a change makes things faster on purpose, refresh the reference numbers with
   `bun run bench:update` and commit `bench/baseline.json` with the change.
5. New hot paths get a scenario in `bench/runtime.bench.ts` in the same change.

## Commits

Conventional commit messages (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`), one
logical change per commit, each commit passing `bun run verify`.
