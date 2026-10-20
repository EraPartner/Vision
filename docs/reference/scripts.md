---
title: Scripts Reference
type: reference
date: 2026-10-20
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
`electron:dev`, `electron:prod`, `native:prepare`, `native:*smoke`, `demo:reset-native`
and `test:electron` scripts run `bun packaging/electron/build.ts` first and then run the compiled JavaScript, for example
`node packaging/electron/out/scripts/native-development.js`. The Electron package's own `start`,
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
| `native:prepare` | Prepare the pinned PostgreSQL and report-browser development payload      |

## Static and generated checks

| Script                       | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `lint`                       | Run frontend ESLint, `lint:deps` and `lint:dead` in parallel |
| `lint:deps`                  | Check cross-workspace import boundaries (dependency-cruiser, `config/dependency-cruiser.cjs`) |
| `lint:dead`                  | Report unused files, exports and dependencies (knip, `config/knip.json`) |
| `lint:backend`               | Lint the backend                                   |
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
| `db:lint`                    | Squawk lint of `db/migrations/*.sql` (destructive DDL) |
| `search:ast`                 | Structural code search with ast-grep (`bun run search:ast -l ts -p 'sumMoney($$$)' apps`) |
| `check`                      | Run the repository aggregate static and test gates |

## Tests

| Script                          | Purpose                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `test`                          | Backend Vitest suite                                                                                                           |
| `test:frontend`                 | Build and run the full frontend Vitest suite against a disposable PostgreSQL 18 backend, including live API contracts          |
| `test:watch`                    | Watch the backend suite against a disposable PostgreSQL 18 database, including CI performance probes                           |
| `test:electron`                 | Build the Electron shell, then run its compiled `node:test` suites (`node --test 'packaging/electron/out/**/*.test.js'`)       |
| `test:scripts`                  | Repository script tests (`bun test scripts/tests`; the jsdom flow-visualizer test runs under `node --test`)                    |
| `test:packages`                 | Shared package Vitest suite, including the Belgian tax engine tests (`packages/shared-utils/tests`)                            |
| `test:db`                       | Backend suite against a disposable native PostgreSQL 18 cluster                                                                |
| `native:db-smoke`               | Native migration, dump/restore, and attachment smoke                                                                           |
| `native:isolated-smoke`         | Full smoke with a disposable native cluster                                                                                    |
| `native:smoke`                  | Offline disposable native backend, audit enrollment, protected device move, valid backup restore and tampered backup rejection |
| `calibrate:category-outliers`   | Privacy-preserving threshold backtest against a local Vision API                                                               |
| `evaluate:local-ai`             | Score a live Ollama model with fixed synthetic tool oracles                                                                    |
| `evaluate:cloud-privacy`        | Inspect deterministic synthetic cloud-assistance traffic                                                                       |
| `evaluate:codex-seatbelt-smoke` | Offline macOS file and network boundary probe for synthetic Codex                                                              |
| `evaluate:codex-subscription`   | Opt-in device login and one fixed fictional Codex turn; requires `VISION_EXPERIMENTAL_CODEX_BINARY`                            |

`scripts/with-test-db.sh` ignores inherited database URLs by default. It creates a private native
PostgreSQL 18 cluster with a generated password and SCRAM authentication, enables required
extensions, migrates it, runs the backend suite (or the forwarded Vitest arguments), and removes it on exit. An already-disposable
caller database requires `VISION_TEST_DB_USE_CALLER=1`. It never uses the user's Vision database by
default. `VISION_TEST_DB_VERIFY_CODEGEN=1` additionally runs `bun run db:codegen --verify` after the
migration so `schema.generated.ts` cannot drift from the migrated schema; CI sets it.

## Database

All database scripts use the Kysely migrator in `apps/node-backend/src/database/migrate.ts`
([[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]). They read `DATABASE_URL`
(falling back to `config/.env.local`) and use `DATABASE_URL_MIGRATIONS` as the owner role when set.

| Script            | Purpose                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `db:migrate`      | Apply every pending migration in `db/migrations/`; refuses objects without a migration ledger           |
| `db:migrate:down` | Revert the latest migration; refuses when it has no `.down.sql`                                      |
| `db:status`       | List migrations and when each was applied                                                            |
| `db:new`          | Create `db/migrations/NNNN_<name>.sql` (`bun run db:new -- <name>`)                                  |
| `db:lint`         | Squawk lint of migration SQL with `config/squawk.toml`                                               |
| `db:codegen`      | Regenerate `apps/node-backend/src/database/schema.generated.ts` from `.kysely-codegenrc.json`       |
| `db:index-stats`  | Inspect index statistics                                                                             |

`apps/node-backend/scripts/postgres-mcp.ts` is not a package script. It is the read-only
PostgreSQL MCP server that `.mcp.json` registers for Claude Code; it reads only
`VISION_MCP_DATABASE_URL` and refuses non-loopback hosts
([[docs/adr/227-claude-code-static-analysis-aids|ADR-227]]).
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
bun run native:prepare
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
