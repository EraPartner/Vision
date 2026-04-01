---
title: Package.json Scripts Reference
type: reference
status: active
date: 2026-03-31
tags: [reference, scripts, npm, bun, build, commands]
description: Complete reference of all npm/bun scripts available in the Vision project
aliases: [scripts, npm scripts, bun scripts, commands, build commands, run commands]
---

# Package.json Scripts Reference

> [!abstract] Overview
> All available scripts from the root `package.json`. Run with `bun run <script-name>`.

## Development

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `dev` | `concurrently "bun --cwd apps/node-backend run dev" "bun --cwd apps/frontend run dev"` | Run both backend and frontend dev servers | Daily development |
| `dev:backend` | `bun --cwd apps/node-backend run dev` | Run only backend dev server | Backend-only work |
| `dev:frontend` | `bun --cwd apps/frontend run dev` | Run only frontend dev server | Frontend-only work |

## Build

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `build` | `bun --cwd apps/frontend run build && bun run locale:generate` | Production build + locale generation | Before deployment |
| `build:dev` | `bun --cwd apps/frontend run build:dev` | Development build (no minification) | Debugging build issues |
| `build:backend` | `bun --cwd apps/node-backend run build` | Backend build | Backend deployment |
| `locale:generate` | `node scripts/generate-locales.js` | Generate TypeScript locale files from JSON | After adding translation keys |

## Linting & Quality

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `lint` | `eslint apps/frontend/src` | ESLint on frontend code | Before committing |
| `lint:fix` | `eslint apps/frontend/src --fix` | ESLint with auto-fix | Fixing lint errors |
| `typecheck` | `bun --cwd apps/frontend run typecheck` | TypeScript type checking | Before committing |

## Testing

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `test` | `bun --cwd apps/node-backend vitest run` | Run all backend tests | Before committing |
| `test:watch` | `bun --cwd apps/node-backend vitest` | Watch mode for backend tests | During test development |
| `test:coverage` | `bun --cwd apps/node-backend vitest run --coverage` | Run tests with coverage | Coverage reporting |

## Database

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `db:setup` | `node scripts/setup-postgres.js` | Setup local PostgreSQL instance | First-time setup |
| `db:start` | `node scripts/start-postgres.js` | Start local PostgreSQL server | Starting dev environment |
| `db:stop` | `node scripts/stop-postgres.js` | Stop local PostgreSQL server | Stopping dev environment |
| `db:upgrade` | `cd alembic && ../venv/bin/python3 -m alembic -c ../config/alembic.ini upgrade head` | Run all pending migrations | After pulling new migrations |
| `db:revision` | `cd alembic && ../venv/bin/python3 -m alembic -c ../config/alembic.ini revision --autogenerate -m` | Create new migration | After schema changes |

## Docker

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `docker:dev` | `docker compose up --build` | Start dev environment with Docker | Docker-based development |
| `docker:dev:down` | `docker compose down` | Stop Docker dev environment | Stopping Docker |
| `docker:dev:rebuild` | `docker compose up --build --force-recreate` | Rebuild Docker containers | After Dockerfile changes |

## Electron

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `electron:dev` | `bun run build:dev && electron .` | Run Electron app in dev mode | Desktop app development |
| `electron:prod` | `bun run build && electron .` | Run Electron app in prod mode | Testing production desktop build |

## Quick Reference by Task

### Starting Development
```bash
bun run db:start      # Start database
bun run dev           # Start backend + frontend
```

### Before Committing
```bash
bun run lint          # Check code quality
bun run test          # Run tests
bun run db:upgrade    # Apply any new migrations
```

### Adding a Feature
```bash
bun run db:revision -- "describe_change"  # Create migration
bun run dev                               # Test locally
bun run test                              # Verify tests pass
```

### Deploying
```bash
bun run build         # Production build
# Then deploy via Docker or Electron packaging
```

## Related

- [[docs/guides/setup\|Setup Guide]] - Full setup instructions
- [[docs/guides/migrations\|Migration Guide]] - Database migration management
- [[docs/guides/deployment\|Deployment Guide]] - Production deployment
- [[AGENTS.md]] - Coding standards and build commands
