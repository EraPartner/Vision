---
title: Setup Guide
type: guide
status: active
date: 2026-08-30
updated: 2026-08-30
tags:
  [
    guide,
    setup,
    development,
    local,
    phase-1,
    native-runtime,
    postgresql,
    docker-compose,
    onboarding,
  ]
description: Complete setup instructions for Docker-free native development, with optional Docker Compose
aliases: [setup-guide, installation, getting-started, local-dev]
related_code: [[package.json]]
---

# Setup Guide

This guide covers setting up Vision for local development.

> [!tip] Devcontainer option
> If you want to run `claude --dangerously-skip-permissions` safely, use the devcontainer instead of the steps below. See [[docs/guides/devcontainer|Devcontainer Guide]] for setup instructions. Normal development on the host is covered here.

## Prerequisites

| Tool                              | Version | Notes                                                                |
| --------------------------------- | ------- | -------------------------------------------------------------------- |
| [Bun](https://bun.sh/)            | 1.3.14  | Package manager, development runtime, and backend compiler           |
| PostgreSQL build source           | 18.6    | One-time native payload input; its host service does not need to run |
| [Python](https://www.python.org/) | 3.12    | One-time Alembic executable build with pinned project requirements   |
| [Node.js](https://nodejs.org/)    | 20+     | Electron packaging tooling                                           |
| [Docker](https://www.docker.com/) | Latest  | Optional Compose deployment and synthetic Demo runtime only          |

## Quick Start

### 1. Clone and Install

```bash
# Clone the repository
git clone <repository-url>
cd Vision

# Install dependencies
bun install
```

### 2. Environment Configuration

Env vars live in a few well-defined files — there is **no** root `.env.local` (retired in [[docs/adr/080-layered-env-loading-shared-secrets|ADR-080]]). See [[docs/reference/environment-variables|environment-variables]] for the authoritative layering. Native Electron stores generated database credentials under its restricted application-data runtime directory and passes an allowlisted environment to the backend.

```bash
# Shared source-development and optional Docker config (provider keys and Docker database values):
cp .env.example .env
# then replace the placeholder password (openssl rand -hex 32)

# Local-dev backend overrides (localhost DATABASE_URL, CORS, ports) — layered over root .env:
#   apps/node-backend/.env.local

# Frontend dev vars (VITE_-prefixed only, e.g. VITE_API_URL):
cp apps/frontend/.env.local.example apps/frontend/.env.local
```

**Running Alembic migrations outside Docker:** `alembic/env.py` loads `config/.env.local` (if present) and reads `DATABASE_URL` (or `DATABASE_URL_MIGRATIONS`). Put the migration connection string there, or export it in the shell before `bun run db:upgrade`.

### 3. Database Setup

#### Option A: Vision-managed PostgreSQL 18 (Recommended on macOS)

Prepare the pinned native payload, then start the development runtime:

```bash
bun run install:electron
bun run native:prepare
bun run dev
```

The preparer copies PostgreSQL 18.6 from a verified build source; the source service does not need
to be running. It also builds the standalone migration executable and copies the Puppeteer-pinned
Chrome Headless Shell. See [[docs/guides/native-macos-runtime#prerequisites|Native macOS Runtime
Guide — Prerequisites]] for the exact build inputs.

The native launcher initializes a private development cluster under `Vision Development`, creates
separate administrator, owner/migration, and application roles, creates the database from
`template0`, enables required extensions, runs the repository migration runner, and waits for
detailed readiness. It refuses a PostgreSQL version other than 18.6, broader-than-loopback
networking, and port collisions.

An existing Docker-backed installation must use the explicit verified importer. Native startup
will not replace or bypass it. Follow [[docs/guides/native-macos-runtime|Native macOS Runtime
Guide]].

#### Option B: Docker Compose (Optional)

```bash
# Start the full stack (db + app with automatic migrations)
bun run docker:dev
```

Startup flow runs automatically via `docker-entrypoint.sh`:

1. Waits for PostgreSQL to be ready
2. Runs Vision's guarded migration runner to bootstrap or migrate the schema
3. Starts the backend application
4. After backend start, non-blocking startup tasks run in background (cache warming, price provider refresh, Kinesis history sanitization)

**Docker data boundary:** `docker-compose.dev.yml` uses the Docker provider's `postgres_data`
volume. It does not share the private native database used by packaged Vision.app. The embedded
Compose directory and credential mirroring remain only for explicit Docker-provider compatibility.
Never run native and Docker writers at the same time.

**Database schema:** As of Phase 1 (2026-04-21), Alembic is the single source of schema DDL ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]). The legacy `schemaInit.js` has been deleted. Fresh databases are bootstrapped by running `alembic/versions/0001_initial_database_schema.py`, which creates all 27 tables, enums, indexes, and triggers in a single baseline migration.

The clean reset command destroys the dedicated clean-test volume. Never use it for a real or shared
Vision data volume:

```bash
bun run docker:clean:reset
```

This recreates the clean Postgres volume before boot.

### 4. Start Development Server

```bash
# Native Electron, PostgreSQL, backend, and production frontend
bun run electron:dev

# Or run Vite and the backend separately against an already configured native database
bun run dev
```

The application will be available at:

- **Frontend**: http://localhost:8080 (or the next free Vite port)
- **Backend API**: http://localhost:3002

## Development Commands

### Root Commands

| Command                   | Description                                                  |
| ------------------------- | ------------------------------------------------------------ |
| `bun run dev`             | Run both backend and frontend                                |
| `bun run electron:dev`    | Run Electron against isolated Vision Development native data |
| `bun run electron:docker` | Run Electron with the optional Docker provider               |
| `bun run build`           | Production build (generates locales)                         |
| `bun run build:dev`       | Development build                                            |
| `bun run lint`            | ESLint on frontend                                           |
| `bun run test`            | Run all backend tests                                        |
| `bun run test:watch`      | Watch mode for tests                                         |

### Database Commands

| Command               | Description            |
| --------------------- | ---------------------- |
| `bun run db:upgrade`  | Run Alembic migrations |
| `bun run db:revision` | Create new migration   |

### Docker Commands

| Command                      | Description           |
| ---------------------------- | --------------------- |
| `bun run docker:dev`         | Start dev environment |
| `bun run docker:dev:down`    | Stop dev environment  |
| `bun run docker:dev:rebuild` | Rebuild containers    |

### Native Runtime Commands

| Command                                                         | Description                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `bun run native:prepare`                                        | Build the pinned native development/package payload          |
| `bun run native:preflight -- --backup "[BACKUP_PATH]"`          | Non-cutover Docker-to-native safety and readiness preflight  |
| `bun run native:cutover -- --backup "[BACKUP_PATH]" --execute`  | Execute the verified, explicit Docker-to-native migration    |
| `bun run native:rollback-stale-docker -- --accept-stale-docker` | Explicitly discard native writes and select preserved Docker |
| `bun run native:db-smoke`                                       | PostgreSQL 18 migration, dump/restore, and attachment smoke  |
| `bun run native:isolated-smoke`                                 | Full smoke with a disposable loopback PostgreSQL 18 cluster  |
| `bun run native:smoke`                                          | Full native backend and loopback health smoke                |

## Project Structure

```
Vision/
├── apps/
│   ├── frontend/          # React frontend
│   │   └── src/
│   │       ├── components/  # UI components
│   │       ├── contexts/    # React contexts
│   │       ├── pages/       # Page components
│   │       └── hooks/       # Custom hooks
│   └── node-backend/     # Express API
│       └── src/
│           ├── routes/      # API endpoints
│           ├── services/   # Business logic
│           ├── repositories/ # Data access
│           └── middleware/  # Express middleware
├── alembic/
│   └── versions/          # Database migrations
├── config/                # Shared configuration (alembic.ini)
├── docker-entrypoint.sh   # Docker startup script (runs migrations)
├── i18n/                  # Localization files
├── docs/                  # Knowledge base
└── packaging/electron/    # Electron desktop app
```

## Environment Variables

| Variable       | Description                  | Default               |
| -------------- | ---------------------------- | --------------------- |
| `DATABASE_URL` | PostgreSQL connection string | Required              |
| `VITE_API_URL` | Frontend API URL             | http://localhost:3002 |
| `PORT`         | Server port                  | 3002                  |
| `LOG_LEVEL`    | Logging level                | info                  |
| `CORS_ORIGINS` | Allowed CORS origins         | http://localhost:8080 |

## Running Tests

### Backend Tests

```bash
# Run all tests
bun run test

# Include DB-backed suites through a private temporary PostgreSQL 18 cluster
bun run test:db

# Watch mode
bun run test:watch

# Run specific test file
bun vitest run src/path/to/test.test.js

# Run specific test by name
bun vitest run --test-name-pattern="testName"
```

`bun run test:db` prefers installed PostgreSQL 18 tools and does not start the Homebrew service.
Docker remains an optional fallback. See
[[docs/testing/testing#Against a real Postgres|real PostgreSQL test guide]]. It documents provider
and port overrides.

### Frontend Tests

Tests for the frontend use React Testing Library. See [[docs/testing/index|Testing Documentation]] for details.

## Troubleshooting

### Database Connection Issues

```bash
# Native: run the read-only runtime and backup-directory preflight
bun run native:preflight -- --backup "/absolute/readable/backup/directory"

# Docker only: check the optional database service
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps db
```

### Port Already in Use

```bash
# Find process using port 3002
lsof -i :3002

# Ask the owning process to stop cleanly
kill <PID>
```

### Migration Issues

```bash
# Check current migration status
bun run db:current

# View migration history
bun run db:history

# Apply pending migrations through Vision's guarded runner
bun run db:upgrade
```

Do not stamp, downgrade, reset, or manually edit a real database to bypass a migration failure.
Collect the exact error and preserve a logical backup before recovery work.

## Next Steps

- Read [[docs/guides/deployment|Deployment Guide]] for production setup
- Read [[docs/guides/contributing|Contributing Guide]] to start contributing
- Explore [[docs/features/index|Features Documentation]]
