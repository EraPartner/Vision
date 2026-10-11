---
title: "ADR-195: Repository scripts are strict TypeScript run on Bun"
type: adr
status: accepted
date: 2026-10-11
tags: [adr, type-safety, typescript, scripts, bun, ci, adr-185]
description: "Phase 5a of the type-safety plan. Every JavaScript script under scripts/ and apps/node-backend/scripts/, and the script tests, becomes strict ESM TypeScript that Bun runs directly. Two tsconfig projects type-check them in CI, script tests run with bun test, and every workflow job that runs a script installs a pinned Bun first. Amends ADR-185's note on running scripts with plain node."
aliases: [adr-195, scripts typescript, type-safety phase 5a]
---

# ADR-195: Repository scripts are strict TypeScript run on Bun

## Status

Accepted. Phase 5a of the type-safety plan. Amends one consequence of
[[docs/adr/185-shared-packages-typescript|ADR-185]]: repository scripts no longer run with plain
`node`. The Electron shell (phase 5b) is decided separately.

## Date

2026-10-11

## Context

After phases 1 to 4 the application code was strict TypeScript, but about 40 repository scripts
were still unchecked JavaScript (`.js` and `.mjs`): the CI policy checks (package boundaries,
endpoint matrix, legacy inventory, test-only exports, cancellation policy), the locale tooling,
the migration runner, the baseline and legacy-retirement maintenance scripts, the AI evaluation
scripts, and their tests. Several of them guard CI or touch the database during maintenance, so a
type error there either weakens a gate or surfaces during an operation.

Python scripts and Alembic stay Python and are covered by `mypy --strict`
([[docs/adr/184-strict-python-type-checking|ADR-184]]).

## Decision

- Every script under `scripts/` and `apps/node-backend/scripts/`, and every test under
  `scripts/tests/`, is ESM TypeScript (`.ts`). Relative imports name the `.ts` file. Scripts use
  `import.meta.dirname` instead of `fileURLToPath(import.meta.url)`.
- Bun 1.4.2 runs them directly (`bun scripts/<name>.ts`); there is no build step. Every
  `package.json` script, shell wrapper, Git hook and workflow step that ran one of these files with
  `node` now runs it with `bun`.
- Scripts that run on import guard their entry point with `isEntrypoint(import.meta)`
  (`scripts/lib/isEntrypoint.ts`). It uses `import.meta.main` and falls back to comparing
  `process.argv[1]` with the module path, so a check script started by an older Node that strips
  types never exits 0 without running its checks.
- Two tsconfig projects check the scripts with the backend's strict options (`strict`,
  `noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `verbatimModuleSyntax`):
  `scripts/tsconfig.json` (`bun run typecheck:scripts`) and
  `apps/node-backend/tsconfig.scripts.json` (part of the backend `typecheck`). The
  "Type Check (Backend)" CI job runs both.
- Script tests keep the `node:test` API and run with `bun test scripts/tests`
  (`bun run test:scripts`).
- The Agent Tooling, Quality Gate and CI Complete jobs in `ci.yml`, and the release
  verification job in `release.yml`, install Bun with the pinned `oven-sh/setup-bun` action before
  they run a script. These scripts import only Node built-ins, so those jobs skip the dependency
  install.
- Scripts that talk to PostgreSQL load `pg` from the backend workspace and use its published types.
  Rows and parsed JSON are read as `unknown` and narrowed before use.
- The `prepare` install hook now starts with `bun scripts/setup-git-hooks.ts`; its reviewed hash in
  `scripts/check-package-boundaries.ts` changed with it.

## Consequences

- Script type errors fail CI like application type errors.
- Malformed input that used to crash a script with a `TypeError` now fails with a named error.
  `convert-legacy-baseline` checks the audit-chain head before its first destructive step instead
  of after the conversion.
- Running a script needs Bun; `node scripts/<name>.ts` is not supported. JSON syntax-error text in
  script output now comes from Bun.
- `apps/frontend/scripts/check-bundle-size.mjs` and the Electron shell remain JavaScript for now.

## Related

- [[docs/reference/scripts|Scripts Reference]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/adr/185-shared-packages-typescript|ADR-185]]
- [[docs/adr/194-runtime-contracts-completion|ADR-194]]
- [[docs/adr/index|All ADRs]]
