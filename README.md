# Dispatchkit (`@orria/dispatchkit`)

Lightweight CQRS-lite runtime toolkit for Bun.

## Features

- CQRS operation definitions: `defineQuery`, `defineMutation`, `defineAction`
- Runtime modules: `defineConfig`, `defineLogger`, `defineInfra`, `defineTransport`
- Runtime builder: `buildRuntime()`
- Strict CQRS call guards at runtime
- Optional `zod` validation for operation `input` and `return`
- Context helpers: `getModuleCtx()`, `getTransportCtx()`
- Runtime artifact generation into `src/generated/runtime`
- CLI: `dispatchkit generate` and `dispatchkit generate --watch`

## Installation

```bash
bun add @orria/dispatchkit zod
```

`dotenv` is included as a dependency. `pino` (or any logger) is optional via `defineLogger`.

## Minimal App Structure

```text
src/
├── index.ts
├── config.ts              # optional (defineConfig)
├── logger.ts              # optional (defineLogger)
├── modules/
│   └── widget/
│       ├── get.query.ts
│       ├── upsert.mutation.ts
│       └── upsert.action.ts
├── infra/
│   ├── storage.ts
│   └── db/index.ts
└── transport/
    ├── http.ts
    └── cli/index.ts
```

## Quick Start

### 1) Define operations

```ts
import { defineQuery } from "@orria/dispatchkit";
import { z } from "zod";

export default defineQuery({
  input: z.object({ id: z.string() }),
  return: z.object({ id: z.string() }).nullable(),
  handler: async (ctx) => {
    return ctx.infra.repo.get(ctx.input.id);
  },
});
```

Each operation becomes available on `runtime.bus`:

- `runtime.bus.query.userGet(input)`
- `runtime.bus.query.userGet.$unsafe(input)`
- `runtime.bus.query.userGet.$input`
- `runtime.bus.query.userGet.$return`

Nested module paths also generate grouped keys:

- `modules/widget/get.query.ts` -> `runtime.bus.query.widget.get(...)`
- Flat alias is also present: `runtime.bus.query.widgetGet(...)`

### 2) Optional runtime config

```ts
import { defineConfig } from "@orria/dispatchkit";
import { z } from "zod";

export default defineConfig(
  z.object({
    FEATURE_FLAG: z.boolean().default(false),
  }),
);
```

Built-in runtime config keys:

- `SERVICE_NAME`
- `SERVICE_DESCRIPTION`
- `SERVICE_VERSION`
- `LOG_LEVEL` (`fatal|error|warn|info|debug|trace|silent`)
- `NODE_ENV` (`development|production`)

Config merge priority (later overrides earlier):

1. Defaults from `package.json`
2. `.env` file
3. `buildRuntime(options)` overrides (`options.config` and top-level keys)

### 3) Optional logger

```ts
import { defineLogger } from "@orria/dispatchkit";
import pino from "pino";

export default defineLogger((config) => {
  const logger = pino({
    name: String(config.SERVICE_NAME),
    level: String(config.LOG_LEVEL),
  });

  return {
    logger,
    console,
  };
});
```

If `src/logger.ts` is missing, Dispatchkit uses a fallback `console`-based logger filtered by `LOG_LEVEL`.

### 4) Infra modules

```ts
import { defineInfra } from "@orria/dispatchkit";

export default defineInfra(() => ({
  repo: {
    get: (id: string) => ({ id }),
  },
}));
```

All infra module return objects are merged into `runtime.infra`.

### 5) Transport modules

```ts
import { defineTransport } from "@orria/dispatchkit";

export default defineTransport(
  () => ({
    ping: () => "pong",
  }),
  {
    allowGetTransportCtxFrom: ["http", "transport/http/**/*.ts"],
  },
);
```

`allowGetTransportCtxFrom` extends default allowed locations for `getTransportCtx()`.
Shorthand values like `"http"` are supported.

### 6) Build runtime

```ts
import { buildRuntime } from "@orria/dispatchkit";

const runtime = await buildRuntime({
  rootDir: process.cwd(),
  srcDir: "./src",
  generatedDir: "./src/generated/runtime",
  envFile: "./.env",
  SERVICE_NAME: "my-service",
});
```

Runtime shape:

- `runtime.config`
- `runtime.logger`
- `runtime.infra`
- `runtime.bus`
- `runtime.transport`

`globalThis.runtime` is also mounted after successful build.

## Context Helpers

- `getModuleCtx()` returns `{ config, logger, infra, bus }`
- `getTransportCtx()` returns `{ config, logger, bus }`

Invalid context access throws structured errors:

- `XPR_CONTEXT_UNAVAILABLE`
- `XPR_CONTEXT_FORBIDDEN`

## CQRS Guards

Runtime enforces call chain restrictions:

- `query` -> only `query`
- `mutation` -> `query`, `mutation`
- `action` -> `query`, `mutation`, `action`

Invalid calls throw `XPR_CQRS_GUARD`.

## Discovery Rules

Dispatchkit scans under `srcDir`:

- `modules/**/*.query.ts`
- `modules/**/*.mutation.ts`
- `modules/**/*.action.ts`
- `infra/*.ts` and `infra/**/index.ts`
- `transport/*.ts` and `transport/**/index.ts`

Notes:

- `*.d.ts` files are ignored
- Operation and transport naming collisions throw errors
- An infra module exporting `defineTransport(...)` is treated as transport

## Generated Artifacts

Default output directory: `src/generated/runtime`

- `manifest.json`
- `bus.d.ts`
- `runtime.d.ts`
- `index.ts`

`manifest.json` is rewritten only when the discovery structure changes.

## CLI

```bash
# one-time generation
dispatchkit generate

# watch mode
dispatchkit generate --watch

# custom paths
dispatchkit generate --srcDir ./src --generatedDir ./src/generated/runtime
```

Options:

- `--rootDir <path>`
- `--srcDir <path>`
- `--generatedDir <path>`
- `--watch`
- `--intervalMs <ms>`

## Build This Package Locally

```bash
bun run build
```

## Documentation

- Russian version: [`docs/README.ru.md`](docs/README.ru.md)
