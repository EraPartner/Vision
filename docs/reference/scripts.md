---
title: Scripts Reference
type: reference
date: 2026-10-12
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
    swift-baseline,
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
| `install:all`      | Install root workspaces                                      |
| `install:electron` | Install the Electron workspace with its frozen lockfile      |
| `dev`              | Launch native Electron development                           |
| `backend`          | Start the backend against the configured database            |
| `preview`          | Preview the frontend production build                        |
| `electron:dev`     | Launch Electron with the isolated native development profile |
| `electron:prod`    | Launch the Electron package entry point                      |

The Electron shell in `packaging/electron/` is strict TypeScript compiled into
`packaging/electron/out/` ([[docs/adr/196-electron-shell-typescript|ADR-196]]). The `dev`,
`electron:dev`, `electron:prod`, `native:*`, `demo:reset-native` and `test:electron` scripts run
`bun packaging/electron/build.ts` first and then run the compiled JavaScript, for example
`node packaging/electron/out/scripts/native-development.js`. The Electron package's own `start`,
`prepare:*` and `dist*` scripts run `bun build.ts` first in the same way.

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
| `typecheck:backend`       | Type-check backend source, tests and scripts       |
| `typecheck:scripts`       | Type-check repository scripts and their tests      |
| `typecheck:electron`      | Type-check the Electron shell and its preload      |
| `typecheck:packages`      | Type-check the shared packages (strict)            |
| `typecheck:python`        | Run `mypy --strict` over Alembic and scripts       |
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

| Script                          | Purpose                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `test`                          | Backend Vitest suite                                                                                                           |
| `test:frontend`                 | Build and run the full frontend Vitest suite against a disposable PostgreSQL 18 backend, including live API contracts          |
| `test:watch`                    | Watch the backend suite against a disposable PostgreSQL 18 database, including CI performance probes                           |
| `test:electron`                 | Build the Electron shell, then run its compiled `node:test` suites (`node --test 'packaging/electron/out/**/*.test.js'`)       |
| `test:scripts`                  | Repository script tests (`bun test scripts/tests`)                                                                             |
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
extensions, migrates it, runs the requested test task, and removes it on exit. An already-disposable
caller database requires `VISION_TEST_DB_USE_CALLER=1`. It never uses the user's Vision database by
default.

For the guarded legacy-retirement migrations, run:

```bash
VISION_TEST_DB_TASK=legacy-retirements scripts/with-test-db.sh
VISION_TEST_DB_TASK=statement-contract scripts/with-test-db.sh
```

These modes refuse caller-managed databases. They create a disposable PostgreSQL 18 cluster and
prove the 0104 through 0106 migration lifecycles or the dropped statement-scalar application and
rollback contract. Legacy retirement starts at 0105 and downgrades to 0103 to reconstruct the
empty legacy cache; ADR-090 starts at 0102. Their rollback checks do not cross the later
forward-only audit-chain migration 0117. The ADR-088 contract task reconstructs its compatibility
columns with the real rollback script before testing the guarded drop against the fresh baseline.

## Database

| Script                        | Purpose                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db:migrate`                  | Run the guarded migration command                                                                                                                                                  |
| `db:upgrade`                  | Upgrade to the current Alembic head                                                                                                                                                |
| `db:downgrade`                | Explicit downgrade through the guarded runner                                                                                                                                      |
| `db:current`                  | Show current revision                                                                                                                                                              |
| `db:history`                  | Show revision history                                                                                                                                                              |
| `db:stamp`                    | Stamp through the guarded runner                                                                                                                                                   |
| `db:revision`                 | Create an autogenerated revision                                                                                                                                                   |
| `db:index-stats`              | Inspect index statistics                                                                                                                                                           |
| `db:legacy-status`            | Read-only status for the six manual legacy database contracts                                                                                                                      |
| `db:check`                    | Check Alembic heads and migration fidelity in a disposable database                                                                                                                |
| `db:backup-before-baseline`   | Create and restore-test a new logical backup before upgrading an older maintained revision; leaves the source unchanged                                                            |
| `db:bridge-baseline`          | Restore-test a new logical backup and bridge a contracted 0118 database to 0119 during approved maintenance                                                                        |
| `db:convert-legacy-baseline`  | Convert the reviewed maintained 0118 legacy shape to canonical 0119 with a full backup, verified archive export, UTC timestamp rule, retained prior database, and recovery journal |
| `db:rollback-legacy-baseline` | Restore the prior database name only before new writes and only when both manifests still match the conversion journal                                                             |

`db:legacy-status` connects with `DATABASE_URL_MIGRATIONS` when configured, otherwise with the
normal application database URL. It opens a read-only transaction and reports only the target
database identity, Alembic revisions, session counts, relation and column shapes, aggregate row
counts, and parity mismatch counts. It never prints the connection URL, application rows, or other
sessions' SQL. The report is evidence for selecting a maintenance target; it does not prove the
stopped-writer state or restore-tested backup and never applies a contract. The maintained
installation's operator waived elapsed-time soak gates for the current legacy retirement on
2026-09-13; the report identifies unfinished import batches that still block `tx_hash` removal.
Pass `--native` to read the maintained macOS Vision runtime's private connection settings without
printing them: `bun run db:legacy-status --native`. The target fingerprint in the report must still
be reviewed before any maintenance operation.

## Locales and maintenance

`sync-nl` copies missing English source keys into Dutch source as an explicit starting point;
translations still require review. `sanitize-locales` repairs generated-compatible locale shape.
`quotes:densify` runs the asset-history densification maintenance task.

`calibrate:category-outliers` requires `VISION_CALIBRATION_API_BASE_URL` pointing to a loopback-only
running Vision instance. It discards category labels, recipients, accounts, memos, and comments,
then reports only aggregate sensitivity and timing counts. It never writes to the database.

## Native rewrite baseline

`scripts/native-baseline.ts` has no package script. Run it on the Mac, in your own terminal, with
`bun scripts/native-baseline.ts`. It records the
[[docs/adr/203-vision-native-swift-app-target|ADR-203]] phase 0 performance baseline and golden
screenshots of the Vision Demo app; phase 4 reruns it against Vision Native. It needs only Bun, the
Demo app and macOS built-ins (`open`, `osascript`, `ps`, `du`, `sysctl`, `screencapture`), so a
sandboxed agent that cannot launch apps or list processes cannot run it. Give the terminal
Accessibility access (System Events window count and keystrokes) and Screen Recording access
(fallback captures).

| Flag                 | Purpose                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `--skip-screenshots` | Measure only; skip the golden screenshots                                   |
| `--skip-launch`      | Use the running app instead of three quit-and-relaunch cold launches        |
| `--port <n>`         | Backend port; defaults to `appPort` in the app's userData `settings.json`   |
| `--cdp-port <n>`     | DevTools port passed as `--remote-debugging-port`; defaults to 9222         |
| `--app <name>`       | `Vision Demo` (default) or `Vision Native`; the real Vision app is rejected |

The script writes to `.vision-cache/swift-baseline/<app slug>/` (gitignored; `vision-demo` or
`vision-native`, so both baselines can coexist for comparison): `toolchain.md`, `baseline.md`
and `baseline.json` (each number with its method), and `screenshots/<theme>-<lang>/<route>.png`
with `screenshots/index.md`. It measures bundle sizes with `du`, three cold launches until
`/health` returns 200 and a window exists, the summed RSS of every process inside the bundle or
`~/Library/Application Support/<app>/` plus its descendants (after 60 s idle on Home and after
scrolling `/transactions` to the bottom), and the `/transactions` scroll frame rate. It drives the
renderer at `http://localhost:<appPort>` over the Chromium DevTools Protocol, which the Electron
shell does not block. Screenshots cover every route in
[[docs/reference/frontend-routes|Frontend Routes]] and `routePreload.ts` in light and dark, English
and Dutch, at 1440x900, plus the Settings sections, command palette and shortcuts overlay in light
English. Theme, language and admin mode are switched through `PUT /api/settings/theme_settings` and
`app_settings`, and the original values are restored at the end, also on error or Ctrl-C. Without a
DevTools endpoint the script falls back to `screencapture -l` of the `G <key>` shortcut pages. Never
point it at the real Vision app.

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
