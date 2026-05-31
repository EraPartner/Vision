---
title: Environment Variables Reference
type: reference
status: active
date: 2026-05-23
updated: 2026-04-25
tags: [reference, environment, configuration, deployment, docker, admin-auth]
description: Complete reference of all environment variables used by the Vision application
aliases: [env vars, environment variables, .env, configuration, env]
---

# Environment Variables Reference

> [!abstract] Overview
> Complete reference of all environment variables used by the Vision application. Organized by component (backend, frontend, Electron, Docker).

> [!tip] Quick Start
> Copy `.env` to `.env.local` and override only the values you need to change. The application has sensible defaults for local development.

## Backend Variables

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `DATABASE_URL` | `postgresql://ftm_user:ftm_password@localhost:5432/financial_transactions` | Yes | PostgreSQL connection string | [[apps/node-backend/src/config/config.js\|config.js]] |
| `PORT` | `3002` | No | Backend server port | [[apps/node-backend/src/config/config.js\|config.js]] |
| `SERVER_HOST` | `localhost` | No | Backend server host | [[apps/node-backend/src/config/config.js\|config.js]] |
| `HOSTNAME` | _(fallback for SERVER_HOST)_ | No | Alternative host variable | [[apps/node-backend/src/config/config.js\|config.js]] |
| `ENVIRONMENT` | `development` | No | Runtime environment | [[apps/node-backend/src/config/config.js\|config.js]] |
| `NODE_ENV` | _(fallback for ENVIRONMENT)_ | No | Alternative environment variable | [[apps/node-backend/src/config/config.js\|config.js]] |
| `DB_ECHO` | `false` | No | Log SQL queries | [[apps/node-backend/src/config/config.js\|config.js]] |
| `DB_POOL_SIZE` | `5` | No | PostgreSQL connection pool size | [[apps/node-backend/src/config/config.js\|config.js]] |
| `DB_MAX_OVERFLOW` | `10` | No | PostgreSQL pool max overflow | [[apps/node-backend/src/config/config.js\|config.js]] |
| `CORS_ORIGINS` | `http://localhost:5174,http://localhost:8080` | No | Comma-separated allowed origins | [[apps/node-backend/src/config/config.js\|config.js]] |
| `DEBUG` | `true` | No | Enable debug logging | [[apps/node-backend/src/config/config.js\|config.js]] |
| `LOG_LEVEL` | `debug` (dev), `info` (prod) | No | Log level: debug, info, warn, error | [[apps/node-backend/src/config/logger.js\|logger.js]] |
| `ENABLE_LOGGING` | `true` | No | Enable/disable logging | [[apps/node-backend/src/config/logger.js\|logger.js]] |
| `ENABLE_RESET_DB` | `false` | No | Enable database reset endpoint | [[apps/node-backend/src/config/config.js\|config.js]] |
| `APP_VERSION` | `unknown` | No | Application version string | [[apps/node-backend/src/routes/admin.js\|admin.js]] |
| `APP_IMAGE_TAG` | _(fallback for APP_VERSION)_ | No | Docker image tag as version | [[apps/node-backend/src/routes/admin.js\|admin.js]] |
| `ADMIN_AUTH_TOKEN` | _(unset)_ | No | Optional Bearer token for protecting `/api/admin/*`. When set, all admin requests must include `Authorization: Bearer <token>` (timing-safe compare); all others receive 401. When unset, admin routes are open at the auth layer — protection is the loopback-only port binding (`docker-compose.yml` binds to `127.0.0.1`) plus the CSRF guard (`csrfGuard.js`, mounted on `/api/admin`) that rejects cross-site state-changing requests. The prior RFC 1918 IP allowlist was removed. WARNING: If port binding changes to `0.0.0.0`, set `ADMIN_AUTH_TOKEN`. See [[docs/adr/063-admin-auth-csrf-guard\|ADR-063]] (supersedes [[docs/adr/037-admin-auth-localhost-fallback\|ADR-037]]). | [[apps/node-backend/src/config/config.js\|config.js]], [[apps/node-backend/src/main.js\|main.js]], [[apps/node-backend/src/middleware/adminAuth.js\|adminAuth.js]], [[apps/node-backend/src/middleware/csrfGuard.js\|csrfGuard.js]], [[docker-compose.yml]] |
| `ALEMBIC_BIN` | `alembic` | No | Path to alembic binary; override in containers where alembic is installed to a venv (e.g. `/venv/bin/alembic`). Used by `runMigrations()` on startup | [[apps/node-backend/src/database/migrate.js\|migrate.js]] |
| `ALEMBIC_CONFIG` | `config/alembic.ini` | No | Path to alembic config file relative to repo root, passed to alembic via `-c` flag | [[apps/node-backend/src/database/migrate.js\|migrate.js]] |
| `APP_TIMEZONE` | `Europe/Brussels` | No | Default timezone for business math (ADR-009) | [[apps/node-backend/src/config/env.js\|env.js]] |
| `AGGREGATIONS_V2_ENABLED` | `false` | No | Gate for aggregation v2 routes | [[apps/node-backend/src/config/env.js\|env.js]] |
| `IMPORT_PIPELINE_V2` | `false` | No | Gate for import pipeline v2 | [[apps/node-backend/src/config/env.js\|env.js]] |
| `ATTACHMENTS_DIR` | `./data/attachments` | No | Filesystem root for receipt attachments (Phase 5A) | [[apps/node-backend/src/config/env.js\|env.js]] |
| `ATTACHMENT_MAX_SIZE_MB` | `10` | No | Per-file upload ceiling in MB | [[apps/node-backend/src/config/env.js\|env.js]] |

## AI Chat / Ollama

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `OLLAMA_URL` | _(unset)_ | No | Base URL for local Ollama server | [[apps/node-backend/src/config/env.js\|env.js]] |
| `OLLAMA_DEFAULT_MODEL` | `llama3.1:8b` | No | Default model for AI chat | [[apps/node-backend/src/config/env.js\|env.js]] |
| `OLLAMA_REQUEST_TIMEOUT_MS` | `600000` | No | Chat request timeout | [[apps/node-backend/src/config/env.js\|env.js]] |
| `OLLAMA_HEALTH_TIMEOUT_MS` | `3000` | No | Health-check timeout | [[apps/node-backend/src/config/env.js\|env.js]] |
| `AI_CHAT_ENABLED` | `false` | No | Feature gate for AI chat endpoint | [[apps/node-backend/src/config/env.js\|env.js]] |
| `AI_CHAT_RATE_LIMIT` | `30` | No | Per-minute rate limit | [[apps/node-backend/src/config/env.js\|env.js]] |
| `AI_CHAT_MAX_HISTORY` | `30` | No | Max prior turns sent to model | [[apps/node-backend/src/config/env.js\|env.js]] |
| `AI_CHAT_MAX_TOOL_ROWS` | `500` | No | Cap on rows returned to tool calls | [[apps/node-backend/src/config/env.js\|env.js]] |

## Kinesis Price Provider

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `KINESIS_BASE_URL` | `https://api.kinesis.money/api/market-data/trendlines` | No | Kinesis API base URL | [[apps/node-backend/src/config/kinesisConfig.js\|kinesisConfig.js]] |
| `KINESIS_DEFAULT_TIMEFRAME` | `60` | No | Default timeframe in days | [[apps/node-backend/src/config/kinesisConfig.js\|kinesisConfig.js]] |
| `KINESIS_DEFAULT_FROM_DATE` | `2019-01-01T08:47:55.843Z` | No | Default start date for history | [[apps/node-backend/src/config/kinesisConfig.js\|kinesisConfig.js]] |

## Frontend Variables

| Variable | Default | Required | Validation | Description | Code |
|----------|---------|----------|-----------|-------------|------|
| `VITE_API_URL` | `http://localhost:3002` | No | Valid URL string or empty; validated by Zod on boot | Backend API URL | [[apps/frontend/src/lib/env.ts\|env.ts]] |
| `VITE_LOG_LEVEL` | `debug` (dev), `warn` (prod) | No | One of `debug`, `info`, `warn`, `error`, `silent` or empty; validated by Zod on boot | Frontend log level | [[apps/frontend/src/lib/env.ts\|env.ts]] |
| `VITE_ENABLE_LOGGING` | `true` | No | String coerced to boolean (`'true'` → true, empty → default); validated by Zod on boot | Enable frontend logging | [[apps/frontend/src/lib/env.ts\|env.ts]] |

> [!info] Frontend Env Validation (ADR-030)
> All three `VITE_*` variables are validated at boot time by Zod schema in `apps/frontend/src/lib/env.ts`. Misconfiguration fails immediately on app startup with an aggregated error message. See [[docs/adr/030-frontend-environment-schema|ADR-030]] for details.

## Electron Variables

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `VISION_HEALTH_POLL_ATTEMPTS` | `200` | No | Max readiness poll attempts for warm (normal) boots; 200 × 300ms ≈ 56s timeout. Triggers the slow-start modal on expiry. Polls `GET /health/detailed` (materializedViews-gated) for the initial navigation, `GET /health` for watchdog/restart flows. | [[packaging/electron/main.js\|main.js]] |
| `VISION_HEALTH_POLL_INTERVAL_MS` | `300` | No | Interval (ms) between readiness poll retries at startup | [[packaging/electron/main.js\|main.js]] |
| `VISION_HEALTH_POLL_BUILD_ATTEMPTS` | `600` | No | Max readiness poll attempts after a cold/dev build (image pulled or built during that launch); 600 × 300ms ≈ 3 min. Build launches skip the slow-start modal and fall through to the recoverable error page on expiry. | [[packaging/electron/main.js\|main.js]] |
| `VISION_BACKUP_PASSPHRASE` | _(unset)_ | No | AES-GCM passphrase for encrypted backups. When set, bypasses Electron `safeStorage` / macOS Keychain entirely — the shell reads this env var before querying the Keychain, so no login-password prompts occur. Useful on unsigned builds (ad-hoc code identity) or in CI/automation. Unset → falls back to Keychain-stored passphrase, or unencrypted backup if none configured. | [[packaging/electron/main.js\|main.js]] |
| `VISION_COMPOSE_OVERRIDE` | _(unset)_ | No | Filename (relative to `workDir`) layered onto base `docker-compose.yml` | [[packaging/electron/main.js\|main.js]] |

## Docker/Deployment Variables

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `POSTGRES_PASSWORD` | _(none)_ | Yes | PostgreSQL admin password | [[docker-compose.yml\|docker-compose.yml]] |
| `POSTGRES_USER` | `ftm_user` | No | PostgreSQL username | [[docker-compose.yml\|docker-compose.yml]] |
| `POSTGRES_DB` | `financial_transactions` | No | PostgreSQL database name | [[docker-compose.yml\|docker-compose.yml]] |
| `PORT` | `3002` | No | Host port → app container mapping; also read by backend at startup | [[docker-compose.yml\|docker-compose.yml]] |
| `DB_HOST` | `db` | No | Postgres host injected into app container for Alembic | [[docker-compose.yml\|docker-compose.yml]] |
| `DB_PORT` | `5432` | No | Postgres port for Alembic migrations | [[docker-compose.yml\|docker-compose.yml]] |
| `DB_USER` | `ftm_user` | No | Postgres user for Alembic migrations | [[docker-compose.yml\|docker-compose.yml]] |
| `DB_NAME` | `financial_transactions` | No | Postgres database for Alembic migrations | [[docker-compose.yml\|docker-compose.yml]] |

## Source-of-Truth

Canonical backend schema: [[apps/node-backend/src/config/env.js|env.js]] — Zod-validated, loaded at boot. See [[docs/adr/030-frontend-environment-schema|ADR-030]] for the frontend equivalent.

## Shared Variables

Cross-surface vars — must agree across layers:

| Variable | Surfaces |
|----------|----------|
| `DATABASE_URL` | backend, docker-compose (`.env`) |
| `POSTGRES_PASSWORD` | `.env` file, substituted into `DATABASE_URL` |
| `PORT` | backend, docker-compose (`${PORT:-3002}`) |
| `CORS_ORIGINS` | backend, docker-compose (`http://localhost:${PORT:-3002}`) |
| `SERVER_HOST` | backend (`0.0.0.0` inside container) |

## Noted Inconsistencies

_None currently flagged._ Re-audit when adding cross-surface vars.

## Related

- [[docs/guides/setup\|Setup Guide]] - Local development setup
- [[docs/guides/deployment\|Deployment Guide]] - Production deployment
- [[docs/guides/backend-configuration\|Backend Configuration]] - Config module details
- [[docs/troubleshooting\|Troubleshooting]] - Common configuration issues
