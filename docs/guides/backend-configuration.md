---
title: Backend Configuration & Infrastructure
type: guide
date: 2026-11-03
tags:
  [guide, backend, configuration, logging, database, infrastructure, phase-1]
status: active
description: Backend configuration management, logging, and database startup behavior
related_code:
  [
    "apps/node-backend/src/config/config.ts",
    "apps/node-backend/src/config/logger.ts",
    "apps/node-backend/src/main.ts",
    "apps/node-backend/src/database/migrate.ts",
  ]
---

# Backend Configuration & Infrastructure

## Configuration Management

**File:** [[apps/node-backend/src/config/config.ts]]

Centralized configuration module that loads settings from environment variables with `.env.local` support.

### Environment Loading

`config/loadDotenv.ts` loads `apps/node-backend/.env.local` first, then the repository-root
`.env`. Paths are resolved from the loader module, independently of the working directory.
Existing process variables win; the first file wins over the second because loading only fills
absent keys. File contents are not logged.

The loader skips both files when `VISION_SKIP_DOTENV=1`, `NODE_ENV=test`, or
`VISION_NATIVE_ENV_FILE` is configured. The native launcher owns its explicit environment input.
Tests of resolution and precedence use synthetic content. Bun's own automatic loading is separate;
use `bun --no-env-file` when a verification command must avoid it.

Startup checks connectivity before external warmup. Inflation still loads database/cache data
offline, but receives `allowExternal: false`; the later online recovery pass permits refresh.

### Settings Structure

```javascript
{
  debug: boolean,              // From DEBUG env var (default: true)
  server: {
    host: string,              // SERVER_HOST (default: localhost); must be loopback (ADR-233)
    port: number,              // PORT (default: 3002)
    environment: string,       // ENVIRONMENT or NODE_ENV (default: development)
  },
  database: {
    path: string,              // VISION_DATABASE_PATH (default: ./data/vision.sqlite3, development and test only)
    lockTimeoutMs: number,     // VISION_DB_LOCK_TIMEOUT_MS (default: 60000)
    echo: boolean,             // DB_ECHO (default: false)
  },
  api: {
    title: string,             // App title
    version: string,           // API version
    description: string,       // API description
  },
  admin: {
    enableResetDb: boolean,    // ENABLE_RESET_DB (default: false)
  },
  isProduction(): boolean,     // Helper
  isDevelopment(): boolean,    // Helper
}
```

### Usage

```javascript
import settings from "./config/config.ts";

const port = settings.server.port;
const isProd = settings.isProduction();
```

---

## Logging

**File:** [[apps/node-backend/src/config/logger.ts]]

Structured logger with configurable log levels and timestamp formatting. Supports both traditional `(message, extra)` and pino-style `(bindings, message)` calling conventions.

### Log Levels

| Level    | Code | Description                     |
| -------- | ---- | ------------------------------- |
| `debug`  | 0    | Detailed diagnostic information |
| `info`   | 1    | General operational messages    |
| `warn`   | 2    | Warning conditions              |
| `error`  | 3    | Error conditions                |
| `silent` | 4    | No output                       |

### Configuration

Controlled via environment variables:

| Variable         | Values                           | Default                      |
| ---------------- | -------------------------------- | ---------------------------- |
| `LOG_LEVEL`      | `debug`, `info`, `warn`, `error` | `debug` (dev), `info` (prod) |
| `ENABLE_LOGGING` | `true`, `false`                  | `true`                       |

### Usage

The logger accepts arguments in two styles:

**Traditional style (message, extra):**

```javascript
import { logger } from "./config/logger.ts";

logger.info("Server started", { port: 3002 });
logger.debug("Processing request", {
  method: "GET",
  path: "/api/transactions",
});
logger.warn("Rate limit approaching", { current: 180, max: 200 });
logger.error("Database connection failed", { error: err.message });
```

**Pino style (bindings, message):**

```javascript
logger.info({ port: 3002 }, "Server started");
logger.debug(
  { method: "GET", path: "/api/transactions" },
  "Processing request",
);
```

The `formatMessage` function automatically detects which style is used based on argument types.

### Output Format

```
2026-03-31T10:30:00.000Z [INFO] Server started {"port":3002}
```

### Log Level Adjustments

Several services have been optimized to use `debug` level for high-frequency or non-critical logs:

- **Currency rate fetching** — Individual ECB/open.er-api fetch logs and DB save logs (use `LOG_LEVEL=debug` to see rate sync details)
- **Belgian inflation fetching** — Statbel and Eurostat fetch logs and background refresh completion (use `LOG_LEVEL=debug` to monitor inflation data updates)
- **Price provider sanitization** — Kinesis spike sanitization logs are INFO only when corrections > 0 or failures > 0; otherwise debug
- **Cache warming** — Pre-warming messages removed from info/routes to reduce startup verbosity; progress still logged on successful completion

---

## Database Startup Behavior

**Files:** [[apps/node-backend/src/main.ts]], [[apps/node-backend/src/database/migrate.ts]]

The backend opens the SQLite file named by `VISION_DATABASE_PATH` in-process; there is no database
server or connection URL ([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]). Native Electron
passes `<userData>/database/vision.sqlite3`. Outside development and test the backend refuses to
start when `VISION_DATABASE_PATH` is not set.

### Startup Sequence

1. Runs `runMigrations()` on the file. The SQLite migration runner applies pending
   `db/migrations/` files in-process in one `BEGIN IMMEDIATE` transaction, installing the `0001`
   baseline first on an empty database, and records each one in `vision_migrations`. It refuses a
   database that has tables but no ledger, a migration this build does not know, or a changed
   checksum. Before it changes a database that holds data, it writes a `VACUUM INTO` copy to
   `pre-migration-backups/` next to the file.
2. Opens the shared connections and checks them once with `checkConnection()`
3. Starts the HTTP server
4. Fills, indexes and refreshes the summary tables (the former materialized views) in the
   post-listen warmup (`apps/node-backend/src/startup/warmup.ts`)

### Operational Model

- The database file lives in the application data directory under native Electron, or wherever
  the source-deployment operator points `VISION_DATABASE_PATH`.
- Backend process lifecycle is managed by Electron or the operator's process supervisor.
- **Schema is managed exclusively by `db/migrations/`** through the SQLite migration runner ([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]; [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]] superseded the Alembic decision in [[docs/adr/027-alembic-single-source-of-schema|ADR-027]]) — the legacy `schemaInit.js` was deleted in Phase 1 (2026-04-21)
- Migration commands are available via `bun run db:*` (see [[docs/reference/scripts|Scripts Reference]])

---

## Related

- [[docs/guides/setup|Setup Guide]] — Full local development setup
- [[docs/guides/deployment|Deployment Guide]] — Production deployment
- [[docs/guides/migrations|Migration Guide]] — Database schema management
- [[docs/architecture/backend-architecture|Backend Architecture]] — System architecture
