---
title: Environment Variables Reference
type: reference
status: active
date: 2026-04-11
tags: [reference, environment, configuration, deployment]
description: Complete reference of all environment variables used by the Vision application
aliases: [env vars, environment variables, .env, configuration, env]
---

# Environment Variables Reference

> [!abstract] Overview
> Complete reference of all environment variables used by the Vision application. Organized by component (backend, frontend, Docker).

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
| `ADMIN_AUTH_TOKEN` | _(unset)_ | No | Optional Bearer token for protecting `/api/admin/*`; when unset, admin routes remain open for backward compatibility | [[apps/node-backend/src/config/config.js\|config.js]], [[apps/node-backend/src/main.js\|main.js]] |

## Kinesis Price Provider

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `KINESIS_BASE_URL` | `https://api.kinesis.money/api/market-data/trendlines` | No | Kinesis API base URL | [[apps/node-backend/src/config/kinesisConfig.js\|kinesisConfig.js]] |
| `KINESIS_DEFAULT_TIMEFRAME` | `60` | No | Default timeframe in days | [[apps/node-backend/src/config/kinesisConfig.js\|kinesisConfig.js]] |
| `KINESIS_DEFAULT_FROM_DATE` | `2019-01-01T08:47:55.843Z` | No | Default start date for history | [[apps/node-backend/src/config/kinesisConfig.js\|kinesisConfig.js]] |

## Frontend Variables

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `VITE_API_URL` | `http://localhost:3002` | No | Backend API URL | [[apps/frontend/src/lib/api.ts\|api.ts]] |
| `VITE_LOG_LEVEL` | `debug` (dev), `warn` (prod) | No | Frontend log level | [[apps/frontend/src/lib/logger.ts\|logger.ts]] |
| `VITE_ENABLE_LOGGING` | `true` | No | Enable frontend logging | [[apps/frontend/src/lib/logger.ts\|logger.ts]] |

## Docker/Deployment Variables

| Variable | Default | Required | Description | Code |
|----------|---------|----------|-------------|------|
| `POSTGRES_PASSWORD` | _(none)_ | Yes | PostgreSQL admin password | [[docker-compose.yml\|docker-compose.yml]] |
| `POSTGRES_USER` | `ftm_user` | No | PostgreSQL username | [[docker-compose.yml\|docker-compose.yml]] |
| `POSTGRES_DB` | `financial_transactions` | No | PostgreSQL database name | [[docker-compose.yml\|docker-compose.yml]] |

## Related

- [[docs/guides/setup\|Setup Guide]] - Local development setup
- [[docs/guides/deployment\|Deployment Guide]] - Production deployment
- [[docs/guides/backend-configuration\|Backend Configuration]] - Config module details
- [[docs/troubleshooting\|Troubleshooting]] - Common configuration issues
