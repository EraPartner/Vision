---
title: Package.json Scripts Reference
type: reference
status: active
date: 2026-04-29
updated: 2026-05-02
tags: [reference, scripts, npm, bun, build, commands, phase-1, testing, e2e, mutation-testing]
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

## Security & Dependency Hygiene

| Script / Command | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `bun audit` | `bun audit` | Scan lockfile/dependencies for known vulnerabilities | Before release, after dependency updates |
| `bun update` | `bun update` | Refresh dependency graph to latest allowed versions | Planned maintenance windows |

For transitive vulnerability remediation patterns, see [[docs/security/dependency-security-remediation-2026-04|Dependency Security Remediation (2026-04)]] and root config in [[package.json]].

## Testing

### Backend

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `test` | `bun --cwd apps/node-backend vitest run` | Run all backend tests | Before committing |
| `test:watch` | `bun --cwd apps/node-backend vitest` | Watch mode for backend tests | During test development |
| `test:coverage` | `bun --cwd apps/node-backend vitest run --coverage` | Run tests with coverage | Coverage reporting |

### Frontend

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `test:frontend` | `bun --cwd apps/frontend vitest run` | Run all frontend unit + integration tests (Vitest + RTL + MSW) | Before committing |
| `test:frontend:watch` | `bun --cwd apps/frontend vitest` | Watch mode for frontend tests | During test development |
| `test:coverage` | `bun --cwd apps/frontend vitest run --coverage` | Run frontend tests with V8 coverage | Coverage reporting (Phase F1: 17/11/10/18) |
| `test:e2e` | `bun run --filter 'vision-frontend' test:e2e` | Run Playwright E2E tests (smoke, dialogs-edge, critical-flows, mutations-parity, network-drift, a11y) | Before pushing; validates real browser behavior |
| `test:e2e:visual` | `bun run --filter 'vision-frontend' test:e2e:visual` | Update Playwright visual regression baselines | After intentional visual changes |
| `test:e2e:update-snapshots` | `bun run --filter 'vision-frontend' test:e2e:update-snapshots` | Update all Playwright snapshots | After intentional changes to pages |
| `test:mutation` | `bun --cwd apps/frontend run test:mutation` | Run Stryker mutation testing on scoped modules (currency + API client) | Measure test quality baseline (opt-in, not in CI) |

## Database

Alembic is the single source of schema DDL ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]). The node-backend shells out to `alembic upgrade head` on startup via `src/database/migrate.js`; there is no longer a `schemaInit.js` idempotent bootstrap.

### Root-scoped (repo root `package.json`)

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `db:upgrade` | `venv/bin/alembic -c config/alembic.ini upgrade head` | Run all pending migrations | After pulling new migrations |
| `db:downgrade` | `venv/bin/alembic -c config/alembic.ini downgrade -1` | Roll back the latest migration | Migration recovery/testing |
| `db:current` | `venv/bin/alembic -c config/alembic.ini current` | Show current migration version | Verify schema state |
| `db:history` | `venv/bin/alembic -c config/alembic.ini history` | Show migration history | Inspect revision chain |
| `db:stamp` | `venv/bin/alembic -c config/alembic.ini stamp head` | Mark DB at a revision without running migrations | Recovery/bootstrap workflows |
| `db:revision` | `venv/bin/alembic -c config/alembic.ini revision --autogenerate -m` | Create new migration | After schema changes |

### Backend-scoped (`apps/node-backend/package.json`)

Shorthand wrappers that resolve the repo root and invoke alembic directly. Run from `apps/node-backend/` or via `bun --cwd apps/node-backend run <script>`.

| Script | Command | Description |
|--------|---------|-------------|
| `db:migrate` | `alembic upgrade head` | Apply all pending migrations |
| `db:migrate:down` | `alembic downgrade -1` | Revert the latest migration |
| `db:new-migration` | `alembic revision -m <slug>` | Create a new empty revision |
| `db:reset` | `alembic downgrade base && alembic upgrade head` | Wipe and reapply the full chain |

## Docker

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `docker:dev` | `npm run generate-locales-if-not-ci && docker compose -f docker-compose.yml -f docker-compose.dev.yml up` | Start dev environment with Docker | Docker-based development |
| `docker:dev:down` | `docker compose -f docker-compose.yml -f docker-compose.dev.yml down` | Stop Docker dev environment | Stopping Docker |
| `docker:dev:rebuild` | `npm run generate-locales-if-not-ci && docker compose -f docker-compose.yml -f docker-compose.dev.yml down && docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build` | Rebuild Docker containers | After Dockerfile changes |
| `docker:clean` | `npm run generate-locales-if-not-ci && docker compose -f docker-compose.yml -f docker-compose.clean.yml up --build` | Start clean-slate environment | First-run/onboarding testing |
| `docker:clean:down` | `npm run generate-locales-if-not-ci && docker compose -f docker-compose.yml -f docker-compose.clean.yml down` | Stop clean-slate environment | End clean test run |
| `docker:clean:reset` | `npm run generate-locales-if-not-ci && docker compose -f docker-compose.yml -f docker-compose.clean.yml down -v && docker compose -f docker-compose.yml -f docker-compose.clean.yml up --build` | Reset clean volume and restart | Repeat clean-state tests |
| `docker:logs` | `docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f app` | Tail backend logs | Runtime debugging |

## Electron

| Script | Command | Description | When to Use |
|--------|---------|-------------|-------------|
| `electron:dev` | `bun run build:dev && electron .` | Run Electron app in dev mode | Desktop app development |
| `electron:prod` | `bun run build && electron .` | Run Electron app in prod mode | Testing production desktop build |

## Quick Reference by Task

### Starting Development
```bash
bun run docker:dev    # Start Docker stack (db + app)
bun run dev           # Optional web-only frontend+backend loop
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
