---
title: Scripts Reference
type: reference
date: 2026-10-17
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
`electron:dev`, `electron:prod`, `native:prepare`, `native:*smoke`, `demo:reset-native`,
`demo:reset-vision-native` and `test:electron` scripts run `bun packaging/electron/build.ts` first and then run the compiled JavaScript, for example
`node packaging/electron/out/scripts/native-development.js`. The Electron package's own `start`,
`prepare:*` and `dist*` scripts run `bun build.ts` first in the same way.

`demo:reset-native` asks Electron's Vision Demo to restore its canonical seed at the next launch.
`demo:reset-vision-native` writes the same request into `Vision Native Demo/` for Vision Native
Demo (`native-demo-cli.js reset --execute --target vision-native-demo`; `--target vision-native`
picks the standard Vision Native variant).

## Root install scripts

| Script              | Purpose                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `install.sh`        | Build the Electron Vision app and install it to `/Applications/Vision.app`                  |
| `install-demo.sh`   | Build the Electron Vision Demo app with synthetic data                                      |
| `install-native.sh` | Build Vision Native Demo (Release) and install it to `/Applications/Vision Native Demo.app` |

`install-native.sh` needs `xcodegen` and `xcodebuild`. It prepares the runtime payload with the
same steps as `install-demo.sh` (`prepare_native_macos_build`, then `prepare-native-runtime` and
`build-demo-seed` from `packaging/electron/scripts/`) into `apps/native/build/payload/`, and the
Xcode build stages it into `Contents/Resources/runtime/` and `Contents/Resources/demo-seed/` before
signing. The script then checks the staged files and the signature. It builds the Demo variant
unless `VISION_NATIVE_VARIANT=standard` is set, which installs `/Applications/Vision Native.app`. Set
`VISION_NATIVE_SKIP_PAYLOAD=1` to build without a payload. It signs with the free personal team from
`VISION_NATIVE_TEAM_ID`, or from `VISION_NATIVE_TEAM_ID = <id>` in
`apps/native/Config/Local.xcconfig`, or ad-hoc with a warning when neither is set. The Swift package
and the Debug app are built and tested in CI, without a payload, by the `native-macos` job
("Native (macOS)") on a GitHub-hosted `macos-26` runner. The job runs when `apps/native/`,
`packaging/electron/backup/`, `install-native.sh`, `ci.yml`, `packaging/electron/audit-anchor.ts`
or `packaging/electron/scripts/native-audit-fixture.ts` changes, on every push to `main`, and when
the diff cannot be classified. It uploads a plain and an encrypted backup bundle and an audit
transfer written by the Swift code, and the `native-interop` job opens them on Linux with the
Electron readers ([[docs/architecture/native-app|Vision Native App Architecture]]).

The separate `Native End-to-End Smoke` workflow (`.github/workflows/native-e2e.yml`, run by
`.github/scripts/native-e2e-smoke.sh <app> <out> <mode>`) runs on pushes to `codex/native-phase-*`
branches and on manual dispatch, on `macos-26`. It builds PostgreSQL 18.6 with OpenSSL, the Demo
runtime payload and the Debug `Vision Native Demo.app`, then smokes the app in `retained` (control,
`VISION_NATIVE_WEB_FREE=0`), `helper` (`VISION_NATIVE_HELPER_DOCUMENT=1`) and `native` (no
variable: the Debug Demo default) modes. A mode
passes when the app stays alive, the backend port from `settings.json` answers `/health` and, in
helper mode, the log reports `helper document ready` (`native-only document ready` in native mode;
`native-only storage unavailable` fails it). `native-e2e.yml` and `native-branch.yml` skip
documentation-only pushes (`paths-ignore: docs/**`). Each run keeps the unified log, a screenshot and a `metrics-<mode>.txt` (bundle
size and resident memory of the app tree and WebKit services, also written to the step summary) as the
`native-e2e` artifact. A non-blocking last step builds the Electron Demo (`--demo --dir`, with `VISION_FRONTEND_DIST`
and `VISION_CHROMIUM_SOURCE` exported from the payload step) and runs the
`electron` mode, the phase-0 baseline that ADR-204's phase-4 exit compares the native numbers with
([[docs/adr/208-vision-native-without-web-content|ADR-208]]).

## Build and release inputs

| Script           | Purpose                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `build`          | Generate locales and build the production frontend                        |
| `build:dev`      | Build the development frontend                                            |
| `dist`           | Build the frontend and Electron distribution                              |
| `version:bump`   | Update versioned manifests atomically                                     |
| `native:prepare` | Prepare the pinned PostgreSQL, migration, Bun, and report-browser payload |

The frontend workspace also provides the optional
`bun run --filter vision-frontend build:native-helper` command. Run it **after** the ordinary
frontend build. Its isolated Vite configuration adds `dist/native-helper.html` and confines
all bootstrap/lazy chunks to `dist/native-helper-assets/`, preserving ordinary index/assets
and their budgets. It loads no normal preload plugin or public files. The entry stays inert
until a trusted native host explicitly bootstraps it; building does not enable the SDK mode, which
requires `VISION_NATIVE_HELPER_DOCUMENT=1` in a Debug Demo build (the Debug Demo otherwise defaults to the native-only mode, which loads no helper). The command accepts
`--out-dir <dir>`; `scripts/lib/native-mac-build.sh` runs it after the ordinary Vite build against
the staged frontend directory so native runtime payloads include the helper.
See [[docs/adr/207-vision-native-helper-document|ADR-207]] and
[[docs/architecture/native-app|native integration gates]].

## Static and generated checks

| Script                       | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `lint`                       | Lint the frontend                                  |
| `lint:backend`               | Lint the backend                                   |
| `typecheck`                  | Type-check the frontend                            |
| `typecheck:backend`          | Type-check backend source, tests and scripts       |
| `typecheck:scripts`          | Type-check repository scripts and their tests      |
| `typecheck:electron`         | Type-check the Electron shell and its preload      |
| `typecheck:packages`         | Type-check the shared packages (strict)            |
| `typecheck:python`           | Run `mypy --strict` over Alembic and scripts       |
| `validate-locales`           | Validate source/generated locale parity            |
| `generate-locales`           | Generate frontend and Electron locale outputs      |
| `generate:types`             | Generate frontend OpenAPI types                    |
| `native:generate`            | Run the four Vision Native generators below        |
| `native:generate-api`        | Generate the Swift OpenAPI client                  |
| `native:generate-tokens`     | Generate the Swift design tokens                   |
| `native:generate-strings`    | Generate the Vision Native String Catalog          |
| `native:generate-navigation` | Generate the Swift sidebar registry                |
| `check-endpoint-matrix`      | Verify the documented operation count              |
| `check-legacy-inventory`     | Validate legacy dispositions and TODO ownership    |
| `check-test-only-exports`    | Reject production imports of test-only helpers     |
| `todo:list`                  | Print the current TODO ledger                      |
| `todo:check`                 | Verify TODO counts and ledger integrity            |
| `db:check-destructive`       | Reject unmarked destructive migration operations   |
| `db:check-heads`             | Require one Alembic head                           |
| `check`                      | Run the repository aggregate static and test gates |

The `native:generate*` scripts run Bun directly (no Electron build) and write the committed Swift
sources of Vision Native phase 2 ([[docs/architecture/native-app|Vision Native]]):
`scripts/native-openapi.ts` reads `openapi.yaml` and the operationIds in
`apps/native/openapi-operations.txt`; `scripts/native-design-tokens.ts` reads
`apps/frontend/src/styles/tokens.css`, `skin-v2.css` and `themes.ts`; `scripts/native-strings.ts`
copies the keys in `apps/native/i18n-keys.txt` from `i18n/source/{en,nl}.json` into
`apps/native/Sources/VisionNativeUI/Resources/Localizable.xcstrings`; and
`scripts/native-navigation.ts` reads `apps/frontend/src/lib/navigation.ts`. CI's Verify Generated
Artifacts job runs `native:generate` and fails when anything below `apps/native/` changes.

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
[[docs/adr/204-vision-native-swift-app-target|ADR-204]] phase 0 performance baseline and golden
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
