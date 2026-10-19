# Dispatchkit (`@orria/dispatchkit`)

Легковесный CQRS-lite runtime toolkit для Bun.

## Возможности

- CQRS-операции: `defineQuery`, `defineMutation`, `defineAction`
- Runtime-модули: `defineConfig`, `defineLogger`, `defineInfra`, `defineTransport`
- Сборка runtime: `buildRuntime()`
- Строгие CQRS guards во время выполнения
- Валидация config, `input` и `return` через Standard Schema
- Освобождение ресурсов через `onDispose()` и `runtime.dispose()`
- Хелперы контекста: `getModuleCtx()`, `getTransportCtx()`
- Генерация runtime-артефактов в `src/generated/runtime`
- CLI: `dispatchkit generate` и `dispatchkit generate --watch`

## Установка

```bash
bun add @orria/dispatchkit
```

Валидатор устанавливается отдельно. Для примеров с Zod ниже нужен `bun add zod`, для Valibot нужен `bun add valibot`. Zod не является обязательной зависимостью Dispatchkit. `dotenv` входит в пакет. Свой логгер, например `pino`, можно подключить через `defineLogger`.

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
│   ├── repo.ts
│   └── db/index.ts
└── transport/
    ├── http.ts
    └── cli/index.ts
```

## Быстрый старт

### 1) Описываем операции

```ts
// src/modules/widget/get.query.ts
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

- `runtime.bus.query.widget.get(input)`
- `runtime.bus.query.widget.get.$unsafe(input)`
- `runtime.bus.query.widget.get.$input`
- `runtime.bus.query.widget.get.$return`

Для вложенных путей также создаются групповые ключи:

- `modules/widget/get.query.ts` -> `runtime.bus.query.widget.get(...)`
- Плоский алиас тоже доступен: `runtime.bus.query.widgetGet(...)`

### 2) Опциональный runtime config

```ts
import { defineConfig } from "@orria/dispatchkit";
import { z } from "zod";

export default defineConfig(
  z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  }),
);
```

Базовые ключи runtime-конфига:

- `SERVICE_NAME`
- `SERVICE_DESCRIPTION`
- `SERVICE_VERSION`
- `LOG_LEVEL` (`fatal|error|warn|info|debug|trace|silent`)
- `NODE_ENV` (`development|production`)

Приоритет слияния, каждый следующий источник перезаписывает предыдущий:

1. Значения по умолчанию из `package.json`
2. `process.env`
3. `.env`
4. `buildRuntime(options).config`
5. Ключи конфига на верхнем уровне `buildRuntime(options)`

Схема получает объединённый конфиг и должна вернуть объект. Runtime объединяет результат валидации с базовыми ключами. Поэтому схема, удаляющая неизвестные свойства, сохраняет `SERVICE_NAME` и остальные базовые значения. После пользовательских преобразований базовые поля проходят повторную проверку. Без `defineConfig` runtime содержит только базовые ключи. Значение `NODE_ENV=test` преобразуется в `development`.

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
// src/infra/repo.ts
import { defineInfra } from "@orria/dispatchkit";

export default defineInfra(({ config, logger, onDispose }) => {
  logger.info("infra init", { service: config.SERVICE_NAME });
  const records = new Map<string, { id: string }>();
  onDispose(() => records.clear());

  return {
    get: (id: string) => records.get(id) ?? null,
  };
});
```

В `defineInfra()` доступны `{ config, logger, onDispose }`.

Поведение возвращаемого значения:

- `src/infra/database.ts` -> `runtime.infra.database`
- `src/infra/database/index.ts` -> `runtime.infra.database`
- Возвращаемое значение модуля присваивается этому ключу, в том числе экземпляры классов.

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

Обёртки transport поддерживают методы прототипов классов. Если собственное свойство одновременно non-configurable и non-writable, JavaScript требует вернуть исходное значение. Функции и объекты в таких свойствах не получают дополнительных обёрток контекста.

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
- `runtime.dispose()`

После успешной сборки Dispatchkit устанавливает `globalThis.runtime` и настроенную консоль. С `mountGlobal: false` экземпляр runtime не меняет эти глобальные значения. Хелперы контекста продолжают работать внутри его хендлеров и вызовов transport.

Относительные пути `srcDir`, `generatedDir` и `envFile` разрешаются от `rootDir`. По умолчанию `rootDir` равен текущей рабочей директории. Укажи `generateArtifacts: false`, если типы уже сгенерированы при сборке или файловая система runtime доступна только для чтения:

```ts
const runtime = await buildRuntime({
  rootDir: import.meta.dir,
  srcDir: "src",
  mountGlobal: false,
  generateArtifacts: false,
});
```

## Валидация через Standard Schema

`defineConfig`, а также `input` и `return` операций принимают валидаторы [Standard Schema v1](https://standardschema.dev/). Схемы Zod 4 и Valibot 1 работают напрямую. Поддерживается синхронная и асинхронная валидация, включая дополнительные проверки и преобразования. В одной операции можно использовать разные валидаторы:

```ts
// src/modules/increment.query.ts
import { defineQuery } from "@orria/dispatchkit";
import * as v from "valibot";
import { z } from "zod";

export default defineQuery({
  input: z.string().regex(/^\d+$/).transform(Number),
  return: v.pipe(v.number(), v.transform(String)),
  handler: ({ input }) => input + 1,
});
```

Bus принимает входной тип input-схемы. Хендлер получает её выходной тип после валидации. Хендлер возвращает входной тип return-схемы, а bus возвращает её выходной тип. Если return-схемы нет, тип результата bus выводится из хендлера.

Если хендлер вызывает собственный метод сгенерированного bus, укажи явный тип возвращаемого значения хендлера, чтобы TypeScript разрешил рекурсию.

```ts
await runtime.bus.query.increment("41"); // "42"
await runtime.bus.query.increment.$unsafe(41); // 42
```

`$unsafe` пропускает обе схемы вместе со всеми преобразованиями. Он принимает значение, которое обычно получает хендлер, и возвращает исходный результат хендлера. Ограничения CQRS продолжают действовать. `$input` и `$return` содержат исходные объекты схем или `undefined`, если схемы не заданы.

### Elysia и TypeBox

Схемам `t` из Elysia нужен адаптер. Путь импорта зависит от версии TypeBox:

| Источник схем                      | Установка вместе с Dispatchkit | Импорт адаптера                 |
| ---------------------------------- | ------------------------------ | ------------------------------- |
| Elysia 1, `@sinclair/typebox` 0.34 | `bun add @sinclair/typebox`    | `@orria/dispatchkit/typebox`    |
| Elysia 2, `typebox` 1              | `bun add typebox`              | `@orria/dispatchkit/typebox-v1` |

Адаптеры подключаются отдельно, ядро не загружает TypeBox. Интеграция Elysia 2 проверяется на `elysia@2.0.0-beta.14` и `typebox@1.3.28`.

```ts
import { standardSchema } from "@orria/dispatchkit/typebox";
// Elysia 1
import { t } from "elysia";

const input = standardSchema(t.Object({ id: t.String() }));
```

Для Elysia 2 используй `standardSchema(schema, context?)` из `@orria/dispatchkit/typebox-v1`. Необязательный `context` связывает имена с внешними схемами. В Elysia 2 `t.Numeric()` сохраняет отдельные типы входа и выхода:

```ts
// Elysia 2
import { defineQuery } from "@orria/dispatchkit";
import { standardSchema } from "@orria/dispatchkit/typebox-v1";
import { t } from "elysia";

export default defineQuery({
  input: standardSchema(t.Object({ count: t.Numeric() })),
  handler: ({ input }) => input.count + 1,
});
// Вход bus: { count: string | number }. Результат: number.
```

Адаптер TypeBox 0.34 принимает `standardSchema(schema, references?)` и сохраняет проверки и преобразования `Decode`. Для явного разделения типов до и после преобразования используй `Type.Transform` из самого TypeBox:

```ts
import { defineQuery } from "@orria/dispatchkit";
import { standardSchema } from "@orria/dispatchkit/typebox";
import { Type } from "@sinclair/typebox";

export default defineQuery({
  input: standardSchema(
    Type.Transform(Type.String())
      .Decode((value) => value.length)
      .Encode(String),
  ),
  handler: ({ input }) => input * 2,
});
// Вход bus: string. Вход хендлера и результат bus: number.
```

Elysia 1 объявляет `t.Numeric()` как `TNumber`, хотя во время выполнения принимает числовые строки. Её `t.Transform` тоже предоставляет другой статический тип, чем версия TypeBox. Адаптер сохраняет эти преобразования при выполнении, но не может восстановить входные типы, которые отсутствуют в декларациях Elysia. Если важна точная типизация входа, используй `Type.Transform`. Оба адаптера используют синхронные API декодирования TypeBox. Они не запускают HTTP-преобразования Elysia, подстановку значений по умолчанию или очистку полей.

Схемы Elysia 2, зависящие от её внутренней очереди асинхронных проверок, вызывают `DISPATCHKIT_TYPEBOX_ASYNC_REFINE_UNSUPPORTED`. Это касается проверки сигнатур файлов через `t.File({ type: "image/png" })` и `t.Files({ type: "image/png" })`. Для проверки содержимого файлов используй HTTP pipeline Elysia или валидатор Standard Schema с асинхронной валидацией. Базовый `t.File()` и ограничения размера поддерживаются, как и `t.Numeric()`, `t.BooleanString()` и `t.Date()`.

## Жизненный цикл ресурсов

Фабрики infra и transport получают `onDispose(callback)`. Регистрируй освобождение сразу после создания ресурса:

```ts
// src/transport/http.ts
import { defineTransport } from "@orria/dispatchkit";

export default defineTransport(({ onDispose }) => {
  const server = Bun.serve({
    port: 3000,
    fetch: () => new Response("ok"),
  });
  onDispose(() => {
    server.stop(true);
  });
  return server;
});
```

Вызывай `await runtime.dispose()` при завершении приложения. Освобождение выполняется один раз, в обратном порядке регистрации, с ожиданием каждого callback. Ошибка одного callback не прерывает остальные; все ошибки освобождения возвращаются в `AggregateError`. Новые вызовы bus после dispose завершаются ошибкой. Dispatchkit не устанавливает обработчики сигналов процесса и не закрывает незарегистрированные ресурсы.

Если `buildRuntime()` завершается ошибкой, он выполняет зарегистрированные callbacks освобождения и сохраняет ранее установленный runtime и консоль. Сборка нового runtime не закрывает предыдущий. Сохрани его ссылку и вызови `dispose()`, когда он больше не нужен.

## Хелперы контекста

- `getModuleCtx()` возвращает `{ config, logger, infra, bus }`
- `getTransportCtx()` возвращает `{ config, logger, bus }`

Матрица контекстов фабрик/хендлеров:

- `defineLogger((config) => ...)` -> `config`
- `defineInfra((ctx) => ...)` -> `{ config, logger, onDispose }`
- `defineTransport((ctx) => ...)` -> `{ config, logger, bus, onDispose }`
- `defineQuery/defineMutation/defineAction.handler(ctx)` -> `{ config, logger, infra, bus, input }`

При некорректном доступе выбрасываются структурированные ошибки:

- `DISPATCHKIT_CONTEXT_UNAVAILABLE`
- `DISPATCHKIT_CONTEXT_FORBIDDEN`

Bun кеширует модули приложения; код на верхнем уровне выполняется один раз за процесс. Transport-модуль может вызвать `getTransportCtx()` при первом импорте, но сохранённое значение продолжает ссылаться на первый runtime, когда другой runtime использует тот же модуль. Для нескольких экземпляров runtime читай зависящие от него значения внутри фабрик, хендлеров или методов transport.

## Ограничения CQRS

Runtime принудительно ограничивает цепочки вызовов:

- `query` -> только `query`
- `mutation` -> `query`, `mutation`
- `action` -> `query`, `mutation`, `action`

Нарушение вызывает `DISPATCHKIT_CQRS_GUARD`.

## Поиск модулей

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

Runtime и CLI используют одинаковые правила поиска модулей. Статический анализ поддерживает алиасы именованных импортов, namespace imports, объявления `const`, локальные импорты и реэкспорты. Генератор не выполняет код приложения. Динамические обёртки и изменяемые определения, тип которых нельзя установить статически, вызывают `DISPATCHKIT_DISCOVERY_UNKNOWN_DEFINITION`. Экспортируй `defineInfra(...)` или `defineTransport(...)` одним из поддерживаемых способов.

## Генерируемые артефакты

Директория по умолчанию: `src/generated/runtime`

- `manifest.json`
- `bus.d.ts`
- `runtime.d.ts`
- `index.ts`

`manifest.json` перезаписывается только если изменилась discovery-структура.

Запускай `dispatchkit generate` перед проверкой типов и включай сгенерированные декларации в TypeScript-проект. Для стандартного пути `src/generated/runtime` подходит шаблон `include` вида `src/**/*.ts`.

## CLI

```bash
# одноразовая генерация
dispatchkit generate

# watch-режим
dispatchkit generate --watch

# кастомные пути
dispatchkit generate --srcDir ./src --generatedDir ./src/generated/runtime
```

`--watch` обновляет сгенерированные типы и manifest при изменении файлов. Он не перезагружает модули приложения в запущенном процессе.

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
