---
title: Package.json Scripts Reference
type: reference
status: active
date: 2026-04-29
updated: 2026-08-23
tags: [reference, scripts, npm, bun, build, commands, phase-1, testing, e2e, mutation-testing, quote-backfill, gap-fill, migrations, destructive-ddl, todo-stamps]
description: Complete reference of all npm/bun scripts available in the Vision project — root, frontend workspace, and backend workspace.
aliases: [scripts, npm scripts, bun scripts, commands, build commands, run commands]
---

# Package.json Scripts Reference

> [!abstract] Overview
> Vision is a Bun workspace with scripts at three levels: the repo root (`package.json`), the frontend (`apps/frontend/package.json`), and the backend (`apps/node-backend/package.json`). The tables below mirror those three files verbatim. The separate Electron build workspace (`packaging/electron/package.json`) is intentionally out of scope here — its scripts are release-tooling internals invoked only via the root `dist`/`electron:*` wrappers; see [[packaging/release/README.md]].

> [!info] Workspace conventions
> - Root scripts dispatch into workspaces via `bun run --filter '<pkg-name>' <script>`.
> - Frontend workspace name: `vision-frontend`. Backend: `financial-transaction-manager-node`.
> - Run a workspace script from anywhere with `bun --cwd apps/frontend run <script>` or the root proxy if present.

## Root scripts (`package.json`)

### Install / development

| Script | Command | Description |
|--------|---------|-------------|
| `install:all` | `bun install` | Install workspace dependencies; the root `prepare` hook also installs the separate Electron package outside CI. |
| `prepare` | hooks setup + conditional frozen Electron install | Lifecycle hook — installs Git hooks, then installs `packaging/electron` dependencies outside CI when that directory and Bun are available. The Electron package's own `postinstall` materializes its pinned local binary. |
| `hooks:setup` | `node scripts/setup-git-hooks.js` | Manually (re)install the git hooks (same script as `prepare`). |
| `install:electron` | `bun install --frozen-lockfile --cwd packaging/electron` | Install the separate Electron dependency tree and run its local binary installer. CI and release use their explicit `--ignore-scripts` variants instead. |
| `dev` | `concurrently … backend dev … frontend dev` | Run both workspaces' `dev` scripts in parallel with coloured prefixes. |
| `backend` | `bun run --filter '…-node' start` | Start the backend in production mode (no watcher). |
| `update` | `bun update` | Refresh dependency graph to the latest allowed versions. |

### Build

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `npm run generate-locales-if-not-ci && bun run --filter 'vision-frontend' build` | Production frontend build, preceded by locale generation outside CI. |
| `build:dev` | `bun run --filter 'vision-frontend' build:dev` | Frontend build in development mode (no minification). |
| `dist` | `npm run build && cd packaging/electron && npm run dist` | Full Electron desktop build. Output is **unsigned / ad-hoc; no notarization** (`packaging/electron/package.json` sets `identity: null`, `hardenedRuntime: false`, and CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false`) — see [[packaging/release/README.md]] for the release posture. |
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
| `check-compose-sync` | `node scripts/check-compose-sync.js` | Guards `packaging/electron/resources/docker-compose.yml` against drifting from the root `docker-compose.yml` on the compose project `name:`, the database image and platform, and the top-level named `volumes:`. These decide which PostgreSQL runtime starts against which user-data volume; mismatched volumes caused the v1.0.2 data-loss bug, while a platform mismatch can select the broken ARM64 PostgreSQL entrypoint. Node stdlib only, so it runs with nothing but a checkout. Add `--self-test` to exercise the parser's own fixtures. Enforced by CI's `verify-compose-sync`, `release.yml`'s `verify` job, and `.githooks/pre-push`. See [[docs/adr/051-docker-compose-sync-named-volumes\|ADR-051]]. |
| `check-todo-stamps` | `python3 scripts/check-todo-stamps.py` | Guards `TODO.md`'s commit stamps against pre-squash rot: every `· <sha>` and `partial-<sha>` token must be reachable from `origin/main`, because a `- [x]` is only proof if the next reader's `git show <sha>` works. See the table below for the five verdicts and the flags. Python stdlib only, **fully offline**, ~0.2 s. Enforced by CI's `verify-todo-stamps` and `.githooks/pre-push`. |

#### How `check-todo-stamps` classifies a stamp

A SHA copied off a feature branch dies when that branch squash-merges. The convention in `TODO.md`'s *Status markers* section therefore has two publication modes: a pull request uses the merge or squash commit and carries `(#NN)`; the approved local LockBox direct-to-`main` workflow uses its signed implementation commit without a PR number and publishes the following TODO bookkeeping commit in the same fast-forward push. The convention was swept clean in `711279a` (#147) and rotted straight back, then swept again on 2026-08-13 for **83** SHAs. This checker is the guard that replaces a third sweep.

| Verdict | Meaning | Effect |
|---------|---------|--------|
| `OK` | The SHA is reachable from the base branch. | — |
| `ROT` | Not on the base branch, but its `(#NN)` **has** a squash-merge commit there — the branch SHA died in that squash. | **exit 1**; the error names the exact merge commit to re-point at |
| `OPEN` | Not on the base branch and its `(#NN)` has **no** merge commit there, i.e. that PR has not landed. Stamping before the merge exists is explicitly permitted. | reported, never fails |
| `PENDING` | Not yet on the base branch, no `(#NN)`, but reachable from `HEAD` — either a feature-branch stamp missing its PR number or the direct-to-`main` LockBox pair before its push completes. | warning; fatal under `--strict`; becomes `OK` after an approved direct-to-`main` push |
| `ORPHAN` | On neither the base branch nor `HEAD`, and no `(#NN)` to recover it from. | **exit 1** |

> [!info] No network, no token
> "Has PR #NN landed?" is answered from the base branch itself — a landed PR leaves a squash commit whose **subject line** ends in `(#NN)` (matching the subject matters: commit *bodies* cite PR numbers too, so `git log --grep` over-matches). That offline proxy is what separates `ROT` from `OPEN`, so CI needs no API call, no token and no extra permissions, and the verdict is deterministic. `--verify-open` optionally upgrades the proxy to a GitHub API confirmation and **degrades gracefully** — with no network, no token, or any API error it prints a notice, keeps the offline verdicts, and leaves the exit code unchanged.

> [!warning] Shallow clones
> Ancestry answers on a shallow clone are *false*, not merely incomplete (see the ⚠️ at the top of `TODO.md`: the 2026-08-05 sweep was corrupted by exactly this). On a shallow repository the checker prints a loud warning and **exits 0** rather than emit invented verdicts — so the pre-push hook never blocks a shallow working copy. `--require-full-history` turns that into a hard failure; CI passes it, because CI checks out with `fetch-depth: 0` and a shallow checkout there means the workflow is broken.

Flags: `--list` (inventory every token, always exit 0) · `--strict` (`PENDING` becomes fatal) · `--self-test` (fixture suite over a fake git resolver, run by CI before the real scan) · `--require-full-history` · `--verify-open` · `--file <path>` · `--base <ref>`.

### Testing

| Script | Command | Description |
|--------|---------|-------------|
| `test` | `bun run --filter '…-node' test` | Backend unit + integration tests (Vitest). Without `TEST_DATABASE_URL` the DB-backed suites self-skip and the run prints a loud INCOMPLETE RUN banner after the summary — see [[docs/testing/testing#the-skip-banner\|the skip banner]]. |
| `test:db` | `scripts/with-test-db.sh` | Backend suite against a throwaway `postgres:18-alpine` container (started, migrated to head, removed on exit) — the same shape as CI's Test (Backend) job. Arguments are forwarded to vitest. Requires Docker + the Alembic toolchain unless `TEST_DATABASE_URL` points to an already-migrated scratch database; the Codex cloud setup provisions that native PostgreSQL fallback when no usable pre-existing Docker daemon is available. |
| `test:frontend` | `bun run --filter 'vision-frontend' test` | Frontend unit + integration tests (Vitest + RTL + MSW). |
| `test:all` | `concurrently … backend test … frontend test` | Run both test suites in parallel. |
| `test:watch` | `bun run --filter '…-node' test:watch` | Backend tests in watch mode. |
| `test:coverage` | `bun run --filter 'vision-frontend' test:coverage` | Frontend test coverage (V8). |
| `test:e2e` | `bun run --filter 'vision-frontend' test:e2e` | Playwright E2E (smoke, dialogs-edge, critical-flows, mutations-parity, network-drift, a11y). |
| `test:e2e:visual` | `bun run --filter 'vision-frontend' test:e2e:visual` | Update visual regression baselines that are missing. |

### Database (Alembic)

Alembic is the single source of schema DDL ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]). The node-backend shells out to `alembic upgrade head` on startup via `src/database/migrate.js`.

Every script that *writes* the alembic version table (`db:migrate`/`db:upgrade`/`db:downgrade`/`db:stamp`, and the backend workspace's `db:migrate`/`db:migrate:down`/`db:reset`) routes through `apps/node-backend/scripts/db-migrate.js`, which runs the boot-path `stampBaselineIfLegacy()` preflight first. A bare `alembic` invocation auto-creates `alembic_version.version_num` as `VARCHAR(32)` — too narrow for this chain's revision ids — so a fresh database dies on revision 3 with `value too long for type character varying(32)`; the preflight creates/widens the column at `VARCHAR(64)`. The wrapper reads `DATABASE_URL` (falling back to `config/.env.local`, like `alembic/env.py`), prefers `venv/bin/alembic` when it exists (override with `ALEMBIC_BIN`), and takes an optional trailing target, e.g. `bun run db:downgrade base` or `bun run db:stamp <revision>`. Read-only/authoring scripts (`db:current`, `db:history`, `db:revision`) still call alembic directly.

| Script | Command | Description |
|--------|---------|-------------|
| `db:migrate` | `bun run apps/node-backend/scripts/db-migrate.js` | Apply all pending migrations via the boot-path runner (same as `db:upgrade`). Used by CI and `scripts/with-test-db.sh`. |
| `db:upgrade` | `bun run … db-migrate.js upgrade` | Apply pending migrations (default target `head`; optional trailing target revision). |
| `db:downgrade` | `bun run … db-migrate.js downgrade` | Roll back the latest migration (default target `-1`; optional trailing target, e.g. `base`). |
| `db:current` | `venv/bin/alembic -c config/alembic.ini current` | Show the current migration version. |
| `db:history` | `venv/bin/alembic -c config/alembic.ini history` | Show migration history. |
| `db:stamp` | `bun run … db-migrate.js stamp` | Mark DB at a revision without running migrations (default `head`; optional trailing revision). |
| `db:revision` | `venv/bin/alembic … revision --autogenerate -m` | Create a new migration. |
| `db:index-stats` | `bun run apps/node-backend/scripts/index-stats.js` | Dump per-index usage stats from `pg_stat_user_indexes`. |
| `db:check-destructive` | `python3 scripts/check-destructive-migrations.py` | Static scan of `alembic/versions/` (does **not** touch the database): fails on destructive DDL in `upgrade()` — `DROP TABLE`/`DROP COLUMN`, an unreplaced view/trigger/function/type drop, or any `ALTER COLUMN … TYPE` — that carries no `# destructive-ok: <reason>` marker. Migrations auto-apply on every boot, so this is the guard against repeating the 0055 premature-drop crash. Add `--self-test` to exercise the checker's own fixtures, `--list` to inventory findings without failing. Enforced in CI by `verify-destructive-migrations`. See [[docs/guides/migrations#destructive-ddl-and-the-destructive-ok-marker\|Migration Guide]]. |
| `db:precision-drift` | `bun run apps/node-backend/scripts/check-precision-drift.js` | Static source scan (does **not** touch the database): flags `transactions ↔ *_raw_transactions` joins doing rounding-sensitive `amount` arithmetic, so a future NUMERIC widening has evidence. Prints nothing today. |
| `quotes:densify` | `bun run apps/node-backend/scripts/densify-asset-history.js` | One-time gap-fill: runs `backfillHoldingGaps` across all investments to heal sparse `asset_price_history`, then recomputes portfolio snapshots if new rows were written. Safe to re-run (idempotent). Run once after upgrading from a version where Binance history was capped at 365 days. See [[docs/adr/065-daily-gap-fill-dense-asset-history\|ADR-065]]. |

### Docker

| Script | Command | Description |
|--------|---------|-------------|
| `docker:dev` | `npm run generate-locales-if-not-ci && docker compose -f docker-compose.yml -f docker-compose.dev.yml up` | Start the dev stack (Postgres + app). |
| `docker:dev:down` | `docker compose … down` | Stop the dev stack. |
| `docker:dev:rebuild` | `npm run generate-locales-if-not-ci && docker pull --platform linux/amd64 postgres:18-alpine && docker run … postgres --version && … down && … up --build` | Pull and verify the amd64 Postgres image in a disposable container, then rebuild the native app image and start the dev stack. The dev Compose override temporarily runs only Postgres under amd64 emulation because the current upstream ARM64 Alpine image has broken entrypoint scripts. The command stops before shutdown if the image test fails; named data volumes are preserved. |
| `docker:clean` | `npm run generate-locales-if-not-ci && docker compose -f docker-compose.yml -f docker-compose.clean.yml up --build` | Start a first-run / onboarding stack. |
| `docker:clean:down` | `docker compose … down` | Stop the clean stack. |
| `docker:clean:reset` | `npm run generate-locales-if-not-ci && … down -v && … up --build` | Reset clean volumes and restart. |
| `docker:logs` | `docker compose … logs -f app` | Tail backend logs. |

### Electron

The wrappers spawn Electron from `packaging/electron/`, layering a docker-compose override based on the desired flavour. A normal root `bun install` prepares this separate package and its pinned Electron binary; run `bun run install:electron` to repair or refresh it explicitly.

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
| `db:migrate` | `bun run scripts/db-migrate.js` | Apply all pending migrations — same wrapper (and behavior) as the root `db:migrate`/`db:upgrade`. |
| `db:migrate:down` | `bun run scripts/db-migrate.js downgrade` | Roll back the latest migration — same wrapper as the root `db:downgrade`. |
| `db:new-migration` | `cd ../.. && alembic revision -m` | Create a new empty revision. |
| `db:reset` | `bun run scripts/db-migrate.js reset` | Wipe (`downgrade base`) and reapply the full chain to `head`. |

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
bun run check-todo-stamps   # if you ticked anything in TODO.md: does its `· <sha>` resolve on main?
```

### Adding a migration

```bash
bun run db:revision -- "describe_change"
# edit alembic/versions/<n>_describe_change.py
bun run db:check-destructive   # CI gate: any DROP / retype needs a `destructive-ok:` marker
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
