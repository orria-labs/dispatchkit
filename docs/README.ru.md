# Dispatchkit (`@orria/dispatchkit`)

Легковесный CQRS-lite runtime toolkit для Bun.

## Возможности

- CQRS-операции: `defineQuery`, `defineMutation`, `defineAction`
- Runtime-модули: `defineConfig`, `defineLogger`, `defineInfra`, `defineTransport`
- Сборка runtime: `buildRuntime()`
- Строгие CQRS guards во время выполнения
- Опциональная валидация `input` и `return` через `zod`
- Хелперы контекста: `getModuleCtx()`, `getTransportCtx()`
- Генерация runtime-артефактов в `src/generated/runtime`
- CLI: `dispatchkit generate` и `dispatchkit generate --watch`

## Установка

```bash
bun add @orria/dispatchkit zod
```

`dotenv` уже входит в зависимости. `pino` (или другой логгер) подключается опционально через `defineLogger`.

## Минимальная структура приложения

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

## Быстрый старт

### 1) Описываем операции

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

Каждая операция появляется в `runtime.bus`:

- `runtime.bus.query.userGet(input)`
- `runtime.bus.query.userGet.$unsafe(input)`
- `runtime.bus.query.userGet.$input`
- `runtime.bus.query.userGet.$return`

Для вложенных путей также создаются групповые ключи:

- `modules/widget/get.query.ts` -> `runtime.bus.query.widget.get(...)`
- Плоский алиас тоже доступен: `runtime.bus.query.widgetGet(...)`

### 2) Опциональный runtime config

```ts
import { defineConfig } from "@orria/dispatchkit";
import { z } from "zod";

export default defineConfig(
  z.object({
    FEATURE_FLAG: z.boolean().default(false),
  }),
);
```

Базовые ключи runtime-конфига:

- `SERVICE_NAME`
- `SERVICE_DESCRIPTION`
- `SERVICE_VERSION`
- `LOG_LEVEL` (`fatal|error|warn|info|debug|trace|silent`)
- `NODE_ENV` (`development|production`)

Приоритет слияния (последний источник перезаписывает предыдущий):

1. Значения по умолчанию из `package.json`
2. `.env`
3. Overrides из `buildRuntime(options)` (`options.config` и top-level ключи)

### 3) Опциональный логгер

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

Если `src/logger.ts` отсутствует, Dispatchkit использует fallback-логгер на базе `console` с фильтрацией по `LOG_LEVEL`.

### 4) Infra-модули

```ts
import { defineInfra } from "@orria/dispatchkit";

export default defineInfra(async ({ config, logger }) => {
  logger.info("infra init", { service: config.SERVICE_NAME });

  return {
    repo: {
      get: (id: string) => ({ id }),
    },
  };
});
```

В `defineInfra()` в `ctx` доступны только `{ config, logger }`.

Поведение возвращаемого значения:

- Plain-объекты из нескольких infra-модулей объединяются в `runtime.infra` по верхнеуровневым ключам.
- Можно возвращать non-plain объект (например instance класса, как `PrismaClient`).
- Non-plain результат нельзя объединить с результатами других infra-модулей (runtime выбросит `DISPATCHKIT_INFRA_INVALID_RESULT`).

### 5) Transport-модули

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

`allowGetTransportCtxFrom` расширяет стандартные разрешенные места вызова `getTransportCtx()`.
Поддерживаются shorthand-значения вроде `"http"`.

### 6) Собираем runtime

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

Что возвращается:

- `runtime.config`
- `runtime.logger`
- `runtime.infra`
- `runtime.bus`
- `runtime.transport`

После успешной сборки также монтируется `globalThis.runtime`.

## Хелперы контекста

- `getModuleCtx()` возвращает `{ config, logger, infra, bus }`
- `getTransportCtx()` возвращает `{ config, logger, bus }`

Матрица контекстов фабрик/хендлеров:

- `defineLogger((config) => ...)` -> `config`
- `defineInfra((ctx) => ...)` -> `{ config, logger }`
- `defineTransport((ctx) => ...)` -> `{ config, logger, bus }`
- `defineQuery/defineMutation/defineAction.handler(ctx)` -> `{ config, logger, infra, bus, input }`

При некорректном доступе выбрасываются структурированные ошибки:

- `DISPATCHKIT_CONTEXT_UNAVAILABLE`
- `DISPATCHKIT_CONTEXT_FORBIDDEN`

## CQRS Guards

Runtime принудительно ограничивает цепочки вызовов:

- `query` -> только `query`
- `mutation` -> `query`, `mutation`
- `action` -> `query`, `mutation`, `action`

Нарушение вызывает `DISPATCHKIT_CQRS_GUARD`.

## Правила Discovery

Dispatchkit сканирует `srcDir` по шаблонам:

- `modules/**/*.query.ts`
- `modules/**/*.mutation.ts`
- `modules/**/*.action.ts`
- `infra/*.ts` и `infra/**/index.ts`
- `transport/*.ts` и `transport/**/index.ts`

Примечания:

- `*.d.ts` игнорируются
- Коллизии имен операций и transport-ключей приводят к ошибке
- Infra-модуль, который экспортирует `defineTransport(...)`, считается transport-модулем

## Генерируемые артефакты

Директория по умолчанию: `src/generated/runtime`

- `manifest.json`
- `bus.d.ts`
- `runtime.d.ts`
- `index.ts`

`manifest.json` перезаписывается только если изменилась discovery-структура.

## CLI

```bash
# одноразовая генерация
dispatchkit generate

# watch-режим
dispatchkit generate --watch

# кастомные пути
dispatchkit generate --srcDir ./src --generatedDir ./src/generated/runtime
```

Опции:

- `--rootDir <path>`
- `--srcDir <path>`
- `--generatedDir <path>`
- `--watch`
- `--intervalMs <ms>`

## Локальная сборка пакета

```bash
bun run build
```
