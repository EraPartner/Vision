---
title: Package.json Scripts Reference
type: reference
status: active
date: 2026-04-29
updated: 2026-06-26
tags: [reference, scripts, npm, bun, build, commands, phase-1, testing, e2e, mutation-testing, quote-backfill, gap-fill]
description: Complete reference of all npm/bun scripts available in the Vision project — root, frontend workspace, and backend workspace.
aliases: [scripts, npm scripts, bun scripts, commands, build commands, run commands]
---

# Package.json Scripts Reference

> [!abstract] Overview
> Vision is a Bun workspace with scripts at three levels: the repo root (`package.json`), the frontend (`apps/frontend/package.json`), and the backend (`apps/node-backend/package.json`). The tables below mirror those three files verbatim.

> [!info] Workspace conventions
> - Root scripts dispatch into workspaces via `bun run --filter '<pkg-name>' <script>`.
> - Frontend workspace name: `vision-frontend`. Backend: `financial-transaction-manager-node`.
> - Run a workspace script from anywhere with `bun --cwd apps/frontend run <script>` or the root proxy if present.

## Root scripts (`package.json`)

### Install / development

| Script | Command | Description |
|--------|---------|-------------|
| `install:all` | `bun install` | Install workspace dependencies (frontend + backend + packages/types). |
| `dev` | `concurrently … backend dev … frontend dev` | Run both workspaces' `dev` scripts in parallel with coloured prefixes. |
| `backend` | `bun run --filter '…-node' start` | Start the backend in production mode (no watcher). |
| `update` | `bun update` | Refresh dependency graph to the latest allowed versions. |

### Build

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `npm run generate-locales-if-not-ci && bun run --filter 'vision-frontend' build` | Production frontend build, preceded by locale generation outside CI. |
| `build:dev` | `bun run --filter 'vision-frontend' build:dev` | Frontend build in development mode (no minification). |
| `dist` | `npm run build && cd packaging/electron && npm run dist` | Full Electron desktop build (signs + notarises on macOS in CI). |
| `preview` | `bun run --filter 'vision-frontend' preview` | Serve the built frontend bundle locally for smoke-testing. |
| `generate:types` | `openapi-typescript openapi.yaml -o apps/frontend/src/types/generated.ts` | Regenerate the TypeScript types from `openapi.yaml` (ADR-031). |

### Locales

| Script | Command | Description |
|--------|---------|-------------|
| `generate-locales` | `node scripts/generate-locales.js` | Build typed `en.ts` / `nl.ts` from `i18n/source/*.json`. |
| `generate-locales-if-not-ci` | conditional `node scripts/generate-locales.js` | Skipped automatically inside CI (`$CI` set). |
| `sanitize-locales` | `node scripts/generate-locales.js --sanitize-only` | Normalise quotes / whitespace in existing locale bundles. |
| `sync-nl` | `node scripts/sync-nl-with-en.js` | Add any keys present in `en.json` but missing in `nl.json` (placeholder Dutch). |
| `validate-locales` | `node scripts/validate-locales.js` | Parity, placeholder, type, source key-usage, and generated-output drift checks across `en.json` ↔ `nl.json` and `apps/frontend/src/**/*.{ts,tsx}`; fails CI on any error. See [[docs/i18n/translations#validation--validate-locales-checks\|i18n — Validation checks]]. |

### Linting & type-checking

| Script | Command | Description |
|--------|---------|-------------|
| `lint` | `bun run --filter 'vision-frontend' lint` | ESLint on the frontend workspace. |
| `lint:backend` | `bun run --filter '…-node' lint` | ESLint on the backend workspace. |
| `typecheck` | `bun run --filter 'vision-frontend' typecheck` | TypeScript type-check of the frontend (runs: `tsc -p tsconfig.app.json --noEmit && tsc -p tsconfig.node.json --noEmit`). No emit; fails on type errors only. |
| `check-endpoint-matrix` | `node scripts/check-endpoint-matrix.js` | Guards `docs/reference/api-endpoint-matrix.md` against drift from `openapi.yaml`: counts HTTP operations in the spec and compares to the `api_operation_count` frontmatter value; exits 1 on mismatch (caught in CI). |

### Testing

| Script | Command | Description |
|--------|---------|-------------|
| `test` | `bun run --filter '…-node' test` | Backend unit + integration tests (Vitest). |
| `test:frontend` | `bun run --filter 'vision-frontend' test` | Frontend unit + integration tests (Vitest + RTL + MSW). |
| `test:all` | `concurrently … backend test … frontend test` | Run both test suites in parallel. |
| `test:watch` | `bun run --filter '…-node' test:watch` | Backend tests in watch mode. |
| `test:coverage` | `bun run --filter 'vision-frontend' test:coverage` | Frontend test coverage (V8). |
| `test:e2e` | `bun run --filter 'vision-frontend' test:e2e` | Playwright E2E (smoke, dialogs-edge, critical-flows, mutations-parity, network-drift, a11y). |
| `test:e2e:visual` | `bun run --filter 'vision-frontend' test:e2e:visual` | Update visual regression baselines that are missing. |

### Database (Alembic)

Alembic is the single source of schema DDL ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]). The node-backend shells out to `alembic upgrade head` on startup via `src/database/migrate.js`.

| Script | Command | Description |
|--------|---------|-------------|
| `db:upgrade` | `venv/bin/alembic -c config/alembic.ini upgrade head` | Apply all pending migrations. |
| `db:downgrade` | `venv/bin/alembic -c config/alembic.ini downgrade -1` | Roll back the latest migration. |
| `db:current` | `venv/bin/alembic -c config/alembic.ini current` | Show the current migration version. |
| `db:history` | `venv/bin/alembic -c config/alembic.ini history` | Show migration history. |
| `db:stamp` | `venv/bin/alembic -c config/alembic.ini stamp head` | Mark DB at a revision without running migrations. |
| `db:revision` | `venv/bin/alembic … revision --autogenerate -m` | Create a new migration. |
| `db:index-stats` | `bun run apps/node-backend/scripts/index-stats.js` | Dump per-index usage stats from `pg_stat_user_indexes`. |
| `db:precision-drift` | `bun run apps/node-backend/scripts/check-precision-drift.js` | Check NUMERIC columns for precision drift across snapshots. |
| `quotes:densify` | `bun run apps/node-backend/scripts/densify-asset-history.js` | One-time gap-fill: runs `backfillHoldingGaps` across all investments to heal sparse `asset_price_history`, then recomputes portfolio snapshots if new rows were written. Safe to re-run (idempotent). Run once after upgrading from a version where Binance history was capped at 365 days. See [[docs/adr/065-daily-gap-fill-dense-asset-history\|ADR-065]]. |

### Docker

| Script | Command | Description |
|--------|---------|-------------|
| `docker:dev` | `npm run generate-locales-if-not-ci && docker compose -f docker-compose.yml -f docker-compose.dev.yml up` | Start the dev stack (Postgres + app). |
| `docker:dev:down` | `docker compose … down` | Stop the dev stack. |
| `docker:dev:rebuild` | `npm run generate-locales-if-not-ci && … down && … up --build` | Rebuild app image. |
| `docker:clean` | `npm run generate-locales-if-not-ci && docker compose -f docker-compose.yml -f docker-compose.clean.yml up --build` | Start a first-run / onboarding stack. |
| `docker:clean:down` | `docker compose … down` | Stop the clean stack. |
| `docker:clean:reset` | `npm run generate-locales-if-not-ci && … down -v && … up --build` | Reset clean volumes and restart. |
| `docker:logs` | `docker compose … logs -f app` | Tail backend logs. |

### Electron

The wrappers spawn Electron from `packaging/electron/`, layering a docker-compose override based on the desired flavour.

| Script | Command | Description |
|--------|---------|-------------|
| `electron:dev` | `… VISION_COMPOSE_OVERRIDE=docker-compose.dev.yml electron …` | Run Electron against the dev compose stack. |
| `electron:prod` | `… electron packaging/electron/main.js` | Run Electron against the base compose stack. |
| `electron:clean` | `… VISION_COMPOSE_OVERRIDE=docker-compose.clean.yml electron …` | Run Electron against the clean compose stack. |

## Frontend workspace scripts (`apps/frontend/package.json`)

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `vite` | Vite dev server with HMR (port 5174). |
| `build` | `GENERATE_LOCALES_AST=1 node ../../scripts/generate-locales.js && vite build` | Locale codegen + Vite production build. |
| `build:dev` | `vite build --mode development` | Build without minification, useful for debugging. |
| `preview` | `vite preview` | Serve the production build at a local port. |
| `lint` | `eslint .` | Frontend ESLint. |
| `test` | `vitest run` | Vitest one-shot. |
| `test:coverage` | `vitest run --coverage` | Vitest with V8 coverage. |
| `test:e2e` | `playwright test e2e/{smoke,dialogs-edge,critical-flows,mutations-parity,network-drift,a11y}.spec.ts` | Playwright real-browser suite. |
| `test:e2e:visual` | `playwright test --update-snapshots=missing e2e/visual.spec.ts` | Add missing visual baselines (does not overwrite existing). |
| `test:e2e:update-snapshots` | `playwright test --update-snapshots` | Overwrite *all* Playwright snapshots — run after intentional UI changes. |
| `test:mutation` | `stryker run` | Stryker mutation testing on scoped modules (currency + API client). Opt-in; not in CI. |

## Backend workspace scripts (`apps/node-backend/package.json`)

| Script | Command | Description |
|--------|---------|-------------|
| `start` | `bun run src/main.js` | Production-mode backend (no watcher). |
| `dev` | `VISION_DEV=true bun --watch src/main.js` | Backend dev server with watch reload (port 3002). |
| `test` | `bun vitest run` | Vitest one-shot. |
| `test:watch` | `bun vitest` | Vitest watch mode. |
| `lint` | `eslint src/` | Backend ESLint. |
| `lint:fix` | `eslint src/ --fix` | Backend ESLint with auto-fix. |
| `db:migrate` | `cd ../.. && alembic upgrade head` | Backend-relative wrapper around `db:upgrade`. |
| `db:migrate:down` | `cd ../.. && alembic downgrade -1` | Backend-relative wrapper around `db:downgrade`. |
| `db:new-migration` | `cd ../.. && alembic revision -m` | Create a new empty revision. |
| `db:reset` | `cd ../.. && alembic downgrade base && alembic upgrade head` | Wipe and reapply the full chain. |

## Quick reference by task

### Daily development

```bash
bun run docker:dev    # Postgres + backend in containers
bun run dev           # Optional: frontend + backend dev servers without docker
```

### Before committing

```bash
bun run lint && bun run lint:backend
bun run test:all
bun run validate-locales
```

### Adding a migration

```bash
bun run db:revision -- "describe_change"
# edit alembic/versions/<n>_describe_change.py
bun run db:upgrade
```

### Building a desktop release

```bash
bun run dist          # Builds frontend + packs Electron app via packaging/electron
```

### Security & dependency hygiene

```bash
bun audit             # Vulnerability scan
bun update            # Refresh dependency graph
```

For transitive vulnerability remediation patterns, see [[docs/security/dependency-security-remediation-2026-04|Dependency Security Remediation (2026-04)]].

## Related

- [[docs/guides/setup\|Setup Guide]] - Full setup instructions
- [[docs/guides/migrations\|Migration Guide]] - Database migration management
- [[docs/guides/deployment\|Deployment Guide]] - Production deployment
- [[AGENTS.md]] - Coding standards and build commands
