---
title: Backend Configuration & Infrastructure
type: guide
date: 2026-03-31
tags: [guide, backend, configuration, logging, database, infrastructure]
status: active
description: Backend configuration management, logging, and PostgreSQL lifecycle utilities
related_code: ["apps/node-backend/src/config/config.js", "apps/node-backend/src/config/logger.js", "apps/node-backend/src/database/postgresManager.js"]
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
    url: string,               // DATABASE_URL (default: postgresql://ftm_user@localhost:5433/...)
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
import settings, { getSettings } from './config/config.js';

const port = settings.server.port;
const isProd = settings.isProduction();
```

---

## Logging

**File:** [[apps/node-backend/src/config/logger.js]]

Structured logger with configurable log levels and timestamp formatting.

### Log Levels

| Level | Code | Description |
|-------|------|-------------|
| `debug` | 0 | Detailed diagnostic information |
| `info` | 1 | General operational messages |
| `warn` | 2 | Warning conditions |
| `error` | 3 | Error conditions |
| `silent` | 4 | No output |

### Configuration

Controlled via environment variables:

| Variable | Values | Default |
|----------|--------|---------|
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `debug` (dev), `info` (prod) |
| `ENABLE_LOGGING` | `true`, `false` | `true` |

### Usage

```javascript
import { logger } from './config/logger.js';

logger.info('Server started', { port: 3002 });
logger.debug('Processing request', { method: 'GET', path: '/api/transactions' });
logger.warn('Rate limit approaching', { current: 180, max: 200 });
logger.error('Database connection failed', { error: err.message });
```

### Output Format

```
2026-03-31T10:30:00.000Z [INFO] Server started {"port":3002}
```

---

## PostgreSQL Manager

**File:** [[apps/node-backend/src/database/postgresManager.js]]

Utility for managing the lifecycle of a local PostgreSQL server during development. Uses `pg_ctl` for server control.

> **Note:** This is for **local development only**. Production uses Docker-managed PostgreSQL containers.

### Class: PostgresManager

```javascript
import PostgresManager from './database/postgresManager.js';

const manager = new PostgresManager(); // Uses project root detection
// Or override: new PostgresManager('/custom/project/root');
```

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `isInitialized()` | `boolean` | Checks if `postgres_data/base` directory exists |
| `isRunning()` | `boolean` | Checks if PostgreSQL server is running via `pg_ctl status` |
| `setup()` | `Promise<boolean>` | Initializes data directory with `initdb` |
| `start()` | `Promise<boolean>` | Starts server with `pg_ctl start` (15s timeout) |
| `stop()` | `Promise<boolean>` | Stops server with `pg_ctl stop -m fast` (10s timeout) |
| `getStatus()` | `Promise<object>` | Returns `{running, message, port, dataDir, logFile}` |

### Default Configuration

| Setting | Value |
|---------|-------|
| Data directory | `<projectRoot>/postgres_data` |
| Log file | `<projectRoot>/postgres_data/postgres.log` |
| Port | 5433 (non-standard to avoid conflicts) |

### Usage Flow

```javascript
const manager = new PostgresManager();

// Setup if needed
if (!manager.isInitialized()) {
  await manager.setup();
}

// Start server
await manager.start();

// Check status
const status = await manager.getStatus();
console.log(status.message); // "PostgreSQL is running"

// Stop server
await manager.stop();
```

### Integration with npm Scripts

The `db:start`, `db:stop`, and `db:setup` npm scripts wrap this functionality:

```bash
bun run db:setup    # Initialize PostgreSQL data directory
bun run db:start    # Start local PostgreSQL server
bun run db:stop     # Stop local PostgreSQL server
```

---

## Related

- [[docs/guides/setup|Setup Guide]] — Full local development setup
- [[docs/guides/deployment|Deployment Guide]] — Production deployment
- [[docs/guides/migrations|Migration Guide]] — Database schema management
- [[docs/architecture/backend-architecture|Backend Architecture]] — System architecture
