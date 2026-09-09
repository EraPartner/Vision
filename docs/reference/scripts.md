---
title: Scripts Reference
type: reference
date: 2026-09-09
tags: [reference, scripts, bun, testing, database, electron, native-runtime]
description: Authoritative guide to Vision package scripts and their intended use.
aliases: [scripts reference, package scripts]
related_code: [[package.json]]
---

# Scripts Reference

Run root scripts with `bun run <name>`. Run workspace scripts with
`bun run --filter '<workspace>' <name>`.

## Install and development

| Script             | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| `install:all`      | Install root workspaces                                      |
| `install:electron` | Install the Electron workspace with its frozen lockfile      |
| `dev`              | Launch native Electron development                           |
| `backend`          | Start the backend against the configured database            |
| `preview`          | Preview the frontend production build                        |
| `electron:dev`     | Launch Electron with the isolated native development profile |
| `electron:prod`    | Launch the Electron package entry point                      |

## Build and release inputs

| Script           | Purpose                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `build`          | Generate locales and build the production frontend                        |
| `build:dev`      | Build the development frontend                                            |
| `dist`           | Build the frontend and Electron distribution                              |
| `version:bump`   | Update versioned manifests atomically                                     |
| `native:prepare` | Prepare the pinned PostgreSQL, migration, Bun, and report-browser payload |

## Static and generated checks

| Script                    | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `lint`                    | Lint the frontend                                  |
| `lint:backend`            | Lint the backend                                   |
| `typecheck`               | Type-check the frontend                            |
| `validate-locales`        | Validate source/generated locale parity            |
| `generate-locales`        | Generate frontend and Electron locale outputs      |
| `generate:types`          | Generate frontend OpenAPI types                    |
| `check-endpoint-matrix`   | Verify the documented operation count              |
| `check-legacy-inventory`  | Validate legacy dispositions and TODO ownership    |
| `check-test-only-exports` | Reject production imports of test-only helpers     |
| `todo:list`               | Print the current TODO ledger                      |
| `todo:check`              | Verify TODO counts and ledger integrity            |
| `db:check-destructive`    | Reject unmarked destructive migration operations   |
| `db:check-heads`          | Require one Alembic head                           |
| `check`                   | Run the repository aggregate static and test gates |

## Tests

| Script                        | Purpose                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `test`                        | Backend Vitest suite                                             |
| `test:frontend`               | Frontend Vitest suite                                            |
| `test:electron`               | Electron, backup, runtime, and packaging Node tests              |
| `test:scripts`                | Repository script tests                                          |
| `test:e2e`                    | Playwright end-to-end suite                                      |
| `test:e2e:visual`             | Manual visual snapshot suite                                     |
| `test:db`                     | Backend suite against a disposable native PostgreSQL 18 cluster  |
| `native:db-smoke`             | Native migration, dump/restore, and attachment smoke             |
| `native:isolated-smoke`       | Full smoke with a disposable native cluster                      |
| `native:smoke`                | Native backend and health smoke                                  |
| `calibrate:category-outliers` | Privacy-preserving threshold backtest against a local Vision API |

`scripts/with-test-db.sh` uses caller-supplied `TEST_DATABASE_URL` when present. Otherwise it
creates a private native PostgreSQL 18 cluster, enables required extensions, migrates it, runs the
requested test task, and removes it on exit. It never uses the user's Vision database.

## Database

| Script               | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `db:migrate`         | Run the guarded migration command                                   |
| `db:upgrade`         | Upgrade to the current Alembic head                                 |
| `db:downgrade`       | Explicit downgrade through the guarded runner                       |
| `db:current`         | Show current revision                                               |
| `db:history`         | Show revision history                                               |
| `db:stamp`           | Stamp through the guarded runner                                    |
| `db:revision`        | Create an autogenerated revision                                    |
| `db:index-stats`     | Inspect index statistics                                            |
| `db:precision-drift` | Check stored precision drift                                        |
| `db:check`           | Check Alembic heads and migration fidelity in a disposable database |

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
