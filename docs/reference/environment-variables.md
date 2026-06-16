---
title: Environment Variables Reference
type: reference
status: active
date: 2026-05-23
updated: 2026-06-16
tags: [reference, environment, configuration, deployment, docker, admin-auth, rate-limiting, trusted-proxies, dev-mode, ollama, streaming, research-providers, twelve-data, finnhub, fmp, alpha-vantage]
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
| `IMPORT_PIPELINE_V2` | `true` | No | Gate for import pipeline v2 (default on) | [[apps/node-backend/src/config/env.js\|env.js]] |
| `ATTACHMENTS_DIR` | `./data/attachments` | No | Filesystem root for receipt attachments (Phase 5A) | [[apps/node-backend/src/config/env.js\|env.js]] |
| `ATTACHMENT_MAX_SIZE_MB` | `10` | No | Per-file upload ceiling in MB | [[apps/node-backend/src/config/env.js\|env.js]] |
| `RATE_LIMIT_GLOBAL_MAX` | `1000` | No | Max requests per window for the app-wide baseline limiter mounted on `/api`. Per-route limiters stack on top. | [[apps/node-backend/src/middleware/rateLimiter.js\|rateLimiter.js]], [[apps/node-backend/src/config/env.js\|env.js]] |
| `RATE_LIMIT_GLOBAL_WINDOW_MS` | `60000` | No | Rolling window size (ms) for `globalRateLimiter`. Default 60 s. | [[apps/node-backend/src/middleware/rateLimiter.js\|rateLimiter.js]], [[apps/node-backend/src/config/env.js\|env.js]] |
| `TRUSTED_PROXIES` | _(unset)_ | No | Comma-separated IP addresses or CIDR ranges trusted for `X-Forwarded-For`. When unset the client IP is keyed on the raw socket address. Use this when running behind a reverse proxy — set to the proxy's IP (e.g. `192.168.1.1,10.0.0.0/8`). Validated by `ipMatchesRule()` helper. | [[apps/node-backend/src/middleware/rateLimiter.js\|rateLimiter.js]], [[apps/node-backend/src/config/config.js\|config.js]] |
| `VISION_DEV` | _(unset)_ | No | When `true`, enables dev-only bypasses: rate-limit skipping and wildcard CORS reflection. Previously controlled by `ENVIRONMENT=development`; now explicit and fail-safe. The backend `dev` npm script sets this automatically. Do **not** set in production. | [[apps/node-backend/src/config/config.js\|config.js]], [[apps/node-backend/src/main.js\|main.js]] |
| `VISION_BOOT_TRACE` | `1` (enabled) | No | Controls boot-phase timing output. When set to `0`, suppresses per-phase JSON lines written to stderr during startup (`[startup] {"phase":…,"ms":…}`). Enabled by default so cold-start diagnostics are always available. | [[apps/node-backend/src/main.js\|main.js]] |
| `VISION_CACHE_DIR` | `<repo_root>/.vision-cache` | No | Overrides the directory used for the Alembic skip-at-head cache (`alembic-head.json`). After a successful `alembic upgrade head`, the applied revision + a versions-directory fingerprint are stored here; on the next boot, if both match, the alembic invocation is skipped (~1–3 s warm-boot win). | [[apps/node-backend/src/database/migrate.js\|migrate.js]] |
| `PUPPETEER_EXECUTABLE_PATH` | _(unset)_ | No | Path to the Chromium binary used by Puppeteer for PDF report rendering. In Docker (Alpine, musl-linked), set this to the distro-packaged Chromium (e.g. `/usr/bin/chromium-browser`) so Puppeteer uses a compatible binary instead of its own bundled Chrome. Unset locally — Puppeteer falls back to its bundled Chrome. | [[apps/node-backend/src/services/reports/puppeteerRenderer.js\|puppeteerRenderer.js]] |

## AI Chat / Ollama

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `OLLAMA_URL` | _(unset)_ | No | Base URL for local Ollama server | [[apps/node-backend/src/config/env.js\|env.js]] |
| `OLLAMA_DEFAULT_MODEL` | `llama3.1:8b` | No | Default model for AI chat | [[apps/node-backend/src/config/env.js\|env.js]] |
| `OLLAMA_REQUEST_TIMEOUT_MS` | `600000` | No | Budget for the connect + prompt-eval phase (time to first chunk). If no chunk arrives within this window the request is aborted with `TIMEOUT`. Once the first chunk arrives this timer is replaced by the idle window below. | [[apps/node-backend/src/config/env.js\|env.js]] |
| `OLLAMA_STREAM_IDLE_TIMEOUT_MS` | `120000` | No | Inactivity window between chunks during a streaming response. The timer re-arms on every received chunk; only an actual gap of this length aborts the stream. Total generation time is therefore unbounded. Surfaces in `settings.ollama.streamIdleTimeoutMs`. | [[apps/node-backend/src/config/env.js\|env.js]] |
| `OLLAMA_HEALTH_TIMEOUT_MS` | `3000` | No | Health-check timeout | [[apps/node-backend/src/config/env.js\|env.js]] |
| `AI_CHAT_ENABLED` | `true` | No | Feature gate for AI chat endpoint | [[apps/node-backend/src/config/env.js\|env.js]] |
| `AI_CHAT_RATE_LIMIT` | `30` | No | Per-minute rate limit | [[apps/node-backend/src/config/env.js\|env.js]] |
| `AI_CHAT_MAX_HISTORY` | `30` | No | Max prior turns sent to model | [[apps/node-backend/src/config/env.js\|env.js]] |
| `AI_CHAT_MAX_TOOL_ROWS` | `500` | No | Cap on rows returned to tool calls | [[apps/node-backend/src/config/env.js\|env.js]] |

## Kinesis Price Provider

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `KINESIS_BASE_URL` | `https://api.kinesis.money/api/market-data/trendlines` | No | Kinesis API base URL | [[apps/node-backend/src/config/kinesisConfig.js\|kinesisConfig.js]] |
| `KINESIS_DEFAULT_TIMEFRAME` | `60` | No | Default timeframe in days | [[apps/node-backend/src/config/kinesisConfig.js\|kinesisConfig.js]] |
| `KINESIS_DEFAULT_FROM_DATE` | `2019-01-01T08:47:55.843Z` | No | Default start date for history | [[apps/node-backend/src/config/kinesisConfig.js\|kinesisConfig.js]] |

## Research Providers (ADR-079)

API keys for the multi-provider Research aggregation layer. Each is **optional**:
a provider whose key is absent is dropped from the capability chain (the research
suite degrades to whichever providers are keyed — Yahoo needs no key). See
[[docs/adr/079-multi-provider-research-aggregation|ADR-079]] and
[[docs/features/research|Research]].

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `TWELVE_DATA_API_KEY` | — | No | Twelve Data key — quotes/charts (free tier 8/min, 800/day) | [[apps/node-backend/src/services/research/providerKeys.js\|providerKeys.js]] |
| `FINNHUB_API_KEY` | — | No | Finnhub key — news, US fundamentals (free tier 60/min) | [[apps/node-backend/src/services/research/providerKeys.js\|providerKeys.js]] |
| `FMP_API_KEY` | — | No | Financial Modeling Prep key — fundamentals (free tier 250/day) | [[apps/node-backend/src/services/research/providerKeys.js\|providerKeys.js]] |
| `ALPHA_VANTAGE_API_KEY` | — | No | Alpha Vantage key — fallback quotes/fundamentals (free tier ~25/day) | [[apps/node-backend/src/services/research/providerKeys.js\|providerKeys.js]] |

## Frontend Variables

| Variable | Default | Required | Validation | Description | Code |
|----------|---------|----------|-----------|-------------|------|
| `VITE_API_URL` | `http://localhost:3002` | No | Valid URL string or empty; validated by Zod on boot | Backend API URL | [[apps/frontend/src/lib/env.ts\|env.ts]] |
| `VITE_LOG_LEVEL` | `debug` (dev), `warn` (prod) | No | One of `debug`, `info`, `warn`, `error`, `silent` or empty; validated by Zod on boot | Frontend log level | [[apps/frontend/src/lib/env.ts\|env.ts]] |
| `VITE_ENABLE_LOGGING` | `true` | No | String coerced to boolean (`'true'` → true, empty → default); validated by Zod on boot | Enable frontend logging | [[apps/frontend/src/lib/env.ts\|env.ts]] |
| `VITE_DEVTOOLS` | _(unset)_ | No | — | When `"true"`, enables React Query Devtools in production builds. On the local Vite dev server, devtools are always enabled via `import.meta.env.DEV` regardless of this variable. Injected as a Docker build arg in `docker-compose.dev.yml`. Do **not** set in production. | [[apps/frontend/src/App.tsx\|App.tsx]] |

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
