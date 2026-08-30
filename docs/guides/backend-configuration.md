---
title: Backend Configuration & Infrastructure
type: guide
date: 2026-08-30
tags:
  [guide, backend, configuration, logging, database, infrastructure, phase-1]
status: active
description: Backend configuration management, logging, and database startup behavior
related_code:
  [
    "apps/node-backend/src/config/config.js",
    "apps/node-backend/src/config/logger.js",
    "apps/node-backend/src/main.js",
    "apps/node-backend/src/database/migrate.js",
  ]
---

# Backend Configuration & Infrastructure

## Configuration Management

**File:** [[apps/node-backend/src/config/config.js]]

Centralized configuration module that loads settings from environment variables with `.env.local` support.

### Environment Loading

On import, the module:

1. Checks for `.env.local` at the project root
2. Parses key=value pairs (ignoring comments and blank lines)
3. Only sets variables that aren't already defined in `process.env`
4. Logs the loaded `LOG_LEVEL` and `ENABLE_LOGGING` values

### Settings Structure

```javascript
{
  debug: boolean,              // From DEBUG env var (default: true)
  server: {
    host: string,              // SERVER_HOST or HOSTNAME (default: localhost)
    port: number,              // PORT (default: 3002)
    environment: string,       // ENVIRONMENT or NODE_ENV (default: development)
  },
  database: {
    url: string,               // DATABASE_URL (default: postgresql://ftm_user:ftm_password@localhost:5432/...)
    echo: boolean,             // DB_ECHO (default: false)
    poolSize: number,          // DB_POOL_SIZE (default: 5)
    maxOverflow: number,       // DB_MAX_OVERFLOW (default: 10)
  },
  api: {
    title: string,             // App title
    version: string,           // API version
    description: string,       // API description
    corsOrigins: string[],     // CORS_ORIGINS (comma-separated)
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
import settings from "./config/config.js";

const port = settings.server.port;
const isProd = settings.isProduction();
```

---

## Logging

**File:** [[apps/node-backend/src/config/logger.js]]

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
import { logger } from "./config/logger.js";

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

**Files:** [[apps/node-backend/src/main.js]], [[apps/node-backend/src/database/migrate.js]]

The backend process connects to `DATABASE_URL` and waits for readiness. In native mode the Electron
runtime provider manages the private PostgreSQL process and supplies that URL; in Docker or custom
deployments the database lifecycle remains external to the backend.

### Startup Sequence

1. Polls `checkConnection()` with exponential backoff (40 attempts, 50ms → 1000ms)
2. Runs `runMigrations()` once a DB connection is available. This performs the required
   `alembic_version VARCHAR(64)` preflight before invoking Alembic.
3. Refreshes materialized views (runtime artifacts)
4. Starts the HTTP server only after DB readiness and schema initialization are confirmed

### Operational Model

- Database lifecycle is managed by the active runtime provider: native Electron or optional Docker
  Compose.
- Backend process lifecycle is managed by Node/Bun and container restart policy
- **Schema is managed exclusively by Alembic** ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]) — the legacy `schemaInit.js` was deleted in Phase 1 (2026-04-21)
- Alembic migrations are available via `bun run db:*` commands

---

## Related

- [[docs/guides/setup|Setup Guide]] — Full local development setup
- [[docs/guides/deployment|Deployment Guide]] — Production deployment
- [[docs/guides/migrations|Migration Guide]] — Database schema management
- [[docs/architecture/backend-architecture|Backend Architecture]] — System architecture
