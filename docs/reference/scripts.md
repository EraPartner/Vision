---
title: Scripts Reference
type: reference
date: 2026-11-03
tags:
  [
    reference,
    scripts,
    bun,
    testing,
    database,
    electron,
    native-runtime,
    ai,
    privacy,
  ]
description: Authoritative guide to Vision package scripts and their intended use.
aliases: [scripts reference, package scripts]
related_code: [[package.json]]
---

# Scripts Reference

Run root scripts with `bun run <name>`. Run workspace scripts with
`bun run --filter '<workspace>' <name>`.

The scripts behind them in `scripts/` and `apps/node-backend/scripts/` are strict TypeScript that
Bun runs directly, for example `bun scripts/validate-locales.ts`. Run them with Bun, not `node`
([[docs/adr/195-repository-scripts-typescript|ADR-195]]).

## Install and development

| Script             | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| `install:electron` | Install the Electron workspace with its frozen lockfile      |
| `dev`              | Launch native Electron development                           |
| `backend`          | Start the backend against the configured database            |
| `preview`          | Preview the frontend production build                        |
| `electron:dev`     | Launch Electron with the isolated native development profile |
| `electron:prod`    | Launch the Electron package entry point                      |

The Electron shell in `packaging/electron/` is strict TypeScript compiled into
`packaging/electron/out/` ([[docs/adr/196-electron-shell-typescript|ADR-196]]). The `dev`,
`electron:dev`, `electron:prod`, `native:*smoke`, `demo:reset-native`
and `test:electron` scripts run `bun packaging/electron/build.ts` first and then run the compiled JavaScript, for example
`node packaging/electron/out/scripts/native-development.js` (compiled from `packaging/electron/scripts/native-development.ts`). The Electron package's own `start`,
`prepare:*` and `dist*` scripts run `bun build.ts` first in the same way.

`demo:reset-native` asks Electron's Vision Demo to restore its canonical seed at the next launch.

## Root install scripts

| Script              | Purpose                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `install.sh`        | Build the Electron Vision app and install it to `/Applications/Vision.app`                  |
| `install-demo.sh`   | Build the Electron Vision Demo app with synthetic data                                      |

## Build and release inputs

| Script           | Purpose                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `build`          | Generate locales and build the production frontend                        |
| `build:dev`      | Build the development frontend                                            |
| `dist`           | Build the frontend and Electron distribution                              |
| `version:bump`   | Update versioned manifests atomically                                     |

## Static and generated checks

| Script                       | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `lint`                       | Run frontend, backend and project ESLint, `lint:deps` and `lint:dead` in parallel |
| `lint:deps`                  | Check cross-workspace import boundaries (dependency-cruiser, `config/dependency-cruiser.cjs`) |
| `lint:dead`                  | Report unused files, exports and dependencies (knip, `config/knip.json`) |
| `lint:backend`               | Lint the backend (`src/`, `tests/`, `scripts/`)    |
| `lint:projects`              | Lint `packages/*`, `packaging/electron` and `scripts/` (`eslint.projects.config.mjs`) |
| `typecheck`                  | Type-check the frontend                            |
| `typecheck:backend`          | Type-check backend source, tests and scripts       |
| `typecheck:scripts`          | Type-check repository scripts and their tests      |
| `typecheck:electron`         | Type-check the Electron shell and its preload      |
| `typecheck:packages`         | Type-check the shared packages and their tests     |
| `validate-locales`           | Validate source/generated locale parity            |
| `generate-locales`           | Generate frontend and Electron locale outputs      |
| `generate:types`             | Generate frontend OpenAPI types                    |
| `check-endpoint-matrix`      | Verify the documented operation count              |
| `check-legacy-inventory`     | Validate legacy dispositions and TODO ownership    |
| `check-test-only-exports`    | Reject production imports of test-only helpers     |
| `check:package-boundaries`   | Enforce private internal package boundaries        |
| `check:agent-instructions`   | Check agent instruction and skill structure        |
| `check:workflow-supply-chain`| Enforce the GitHub workflow supply-chain policy    |
| `todo:list`                  | Print the current TODO ledger                      |
| `todo:check`                 | Verify TODO counts and ledger integrity            |
| `search:ast`                 | Structural code search with ast-grep (`bun run search:ast -l ts -p 'sumMoney($$$)' apps`) |
| `check`                      | Run the repository aggregate static and test gates |

## Tests

| Script                          | Purpose                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `test`                          | Backend Vitest suite                                                                                                           |
| `test:frontend`                 | Build the frontend, then run the full frontend Vitest suite against the production backend on a temporary SQLite database, including live API contracts |
| `test:watch`                    | Watch the backend suite, including CI performance probes                                                                       |
| `test:electron`                 | Build the Electron shell, then run its compiled `node:test` suites (`node --test 'packaging/electron/out/**/*.test.js'`)       |
| `test:scripts`                  | Repository script tests (`bun test scripts/tests`; the jsdom flow-visualizer test runs under `node --test`)                    |
| `test:packages`                 | Shared package Vitest suite, including the Belgian tax engine tests (`packages/shared-utils/tests`)                            |
| `native:isolated-smoke`         | Run `native:smoke` in a child process with a minimal environment and its own temporary application-data directory and SQLite database |
| `native:smoke`                  | Offline disposable native backend on a temporary SQLite database, encrypted backup restore, and restore into a second fresh runtime (device move) |
| `calibrate:category-outliers`   | Privacy-preserving threshold backtest against a local Vision API                                                               |
| `evaluate:local-ai`             | Score a live Ollama model with fixed synthetic tool oracles                                                                    |

The backend suite needs no database server. A Vitest global setup
(`apps/node-backend/tests/setup/sqliteTemplate.ts`) migrates one SQLite template file per run, and
every test file gets its own copy of it (`tests/setup/sqliteDatabase.ts`), so database tests always
run. `tests/database/codegen.test.ts` fails when `schema.generated.ts` drifts from the migrated
schema. `test:frontend` runs `scripts/run-frontend-tests.sh`, which starts the backend through
`.github/scripts/with-native-stack.sh` on a fresh SQLite file in a temporary directory.

## Database

The `db:migrate`, `db:migrate:down`, `db:status` and `db:new` scripts run
`apps/node-backend/scripts/db-migrate.ts`, which uses the migration runner in
`apps/node-backend/src/database/migrate.ts`, the same code the app runs on boot
([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]). They open the SQLite file named by
`VISION_DATABASE_PATH` (falling back to `config/.env.local`). Before the runner migrates a database
that already holds data, it writes a `VACUUM INTO` copy to `pre-migration-backups/` next to the
database and keeps the newest three.

| Script            | Purpose                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `db:migrate`      | Apply every pending migration in `db/migrations/` in one transaction; refuses a database with tables but no ledger, a migration this build does not know, or a changed migration |
| `db:migrate:down` | Revert the latest migration; refuses when it has no `.down.sql`                                      |
| `db:status`       | List migrations and when each was applied                                                            |
| `db:new`          | Create `db/migrations/NNNN_<name>.sql` (`bun run db:new -- <name>`)                                  |
| `db:codegen`      | Regenerate `schema.generated.ts` and `schemaMap.generated.ts` in `apps/node-backend/src/database/` from an in-memory database built by the migrations, with `apps/node-backend/db-codegen.config.json`; `--verify` exits 1 on drift |
| `db:index-stats`  | List the indexes of the `transactions` table with their columns, and their sizes when the SQLite build has `dbstat` |

`apps/node-backend/scripts/sqlite-mcp.ts` is not a package script. It is the read-only SQLite MCP
server that `.mcp.json` registers for Claude Code as `vision-sqlite`; it opens only the file named
by `VISION_MCP_DATABASE_PATH`, never `VISION_DATABASE_PATH`, read-only and with
`PRAGMA query_only = ON` ([[docs/adr/227-claude-code-static-analysis-aids|ADR-227]]).
`apps/node-backend/scripts/typescript-mcp.ts` is the TypeScript navigation MCP server that
`.mcp.json` registers next to it; it wraps the repository's own `tsserver`
([[docs/adr/228-typescript-navigation-mcp|ADR-228]]).

See [[docs/guides/migrations|Database Migration Guide]] for the workflow.

## Locales and maintenance

`sync-nl` copies missing English source keys into Dutch source as an explicit starting point;
translations still require review. `sanitize-locales` repairs generated-compatible locale shape.
`quotes:densify` runs the asset-history densification maintenance task.

`calibrate:category-outliers` requires `VISION_CALIBRATION_API_BASE_URL` pointing to a loopback-only
running Vision instance. It discards category labels, recipients, accounts, memos, and comments,
then reports only aggregate sensitivity and timing counts. It never writes to the database.

## Common sequences

```bash
# Daily native development
bun run install:electron
bun run dev

# Focused verification
bun run lint
bun run lint:backend
bun run typecheck
bun run typecheck:electron
bun run test
bun run test:frontend
bun run test:electron

# Desktop release candidate
bun run check
bun run native:isolated-smoke
bun run dist
```

## Related

- [[docs/guides/setup|Setup Guide]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/guides/migrations|Database Migrations]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
