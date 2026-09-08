---
title: CI/CD Pipelines
type: guide
status: active
date: 2026-09-08
tags:
  [
    guide,
    ci-cd,
    github-actions,
    testing,
    security,
    release,
    native-runtime,
    postgresql,
  ]
description: Current GitHub Actions quality gates, native PostgreSQL verification, and macOS release flow.
aliases: [CI, CD, GitHub Actions, release pipeline]
related_code:
  [
    ".github/workflows/ci.yml",
    ".github/workflows/e2e.yml",
    ".github/workflows/release.yml",
  ]
---

# CI/CD Pipelines

Vision CI uses native processes and disposable PostgreSQL 18 clusters. It does not build, verify,
scan, or publish a product container image. The required aggregate check remains **CI Complete**.

## Pull-request and push CI

`.github/workflows/ci.yml` classifies changed paths and runs the relevant independent jobs:

| Area              | Jobs and evidence                                                              |
| ----------------- | ------------------------------------------------------------------------------ |
| Repository policy | cloud tooling, agent-instruction checks, commitlint, secrets scan              |
| Dependencies      | Bun audit and pip-audit                                                        |
| Static checks     | frontend/backend lint, frontend/backend type checks, generated-artifact checks |
| Builds and tests  | frontend build, frontend tests, Electron/runtime tests, backend tests          |
| Database safety   | destructive-migration check against repository source                          |
| Security          | Trivy filesystem scan with table and SARIF output                              |
| Runtime           | native production-health and migration-reversibility smoke                     |
| Contracts         | live API contract tests against a native backend and disposable PostgreSQL 18  |

`quality-gate` aggregates the portable pre-runtime checks. `CI Complete` aggregates every required
stage and keeps a stable branch-protection name. A skipped path-filtered job is handled explicitly;
an absent or failed required result is not treated as green.

### Native database jobs

Database-backed jobs install PostgreSQL 18 packages on the runner and use
`scripts/with-test-db.sh` or the native runtime smoke harness. Each cluster is private, loopback
only, migrated to the current Alembic head, and removed after the job. The test harness also
enables the extensions required by production behavior. This is a real PostgreSQL check, not a
mock and not a dependency on a pre-existing runner service.

### Security scan

Trivy scans the checked-out filesystem for vulnerable dependencies and known secrets. Results are
uploaded to GitHub code scanning as SARIF when permitted. JavaScript and Python dependency audits
remain separate gates so package-manager findings are visible even when the filesystem scan is
unchanged.

## Scheduled end-to-end testing

`.github/workflows/e2e.yml` runs the Playwright end-to-end and accessibility suites on schedule or
manual dispatch. It builds the production frontend and launches a native backend against a
disposable PostgreSQL 18 cluster. The Playwright report is uploaded on failure, and the nightly
workflow maintains its tracking issue.

Visual snapshots remain manual because macOS and Linux render different baselines.

## Release workflow

`.github/workflows/release.yml` runs for version tags and manual releases:

1. **Verify Release** checks the tag and manifest versions, scans secrets and the release
   filesystem, audits dependencies, regenerates checked artifacts, runs lint/type checks, builds
   the frontend, exercises native health and migration reversibility, and runs the test suites.
2. **Build mac .app + DMG** builds the signed/notarized native macOS artifacts and source-launcher
   update bundle with pinned runtime inputs.
3. **Create GitHub Release** downloads the staged artifacts, attests them, and publishes the GitHub
   release.

Release artifacts include checksums. The workflow does not publish an application image or image
metadata. See [[docs/features/application-updates|Application Updates]] and
[[docs/adr/133-native-only-runtime-and-delivery|ADR-133]].

## Local verification

Use the narrowest relevant commands during development, then run the repository gates required by
the change:

```bash
bun run lint
bun run lint:backend
bun run typecheck
bun run validate-locales
bun run test:scripts
bun run test
bun run test:frontend
bun run test:electron
bun run native:isolated-smoke
```

`bun run check` aggregates the portable repository checks. Database, packaging, signing, and live
process claims still require their focused jobs.

## Pull-request completion and merge

Do not infer remote success from local checks. Read the exact GitHub Actions results for the pull
request and confirm `CI Complete`, required reviews, and code-scanning state. Native auto-merge may
be enabled only when the user explicitly requests it and the repository rules allow it; no admin
bypass is permitted.

## Related

- [[docs/testing/testing|Testing Guide]]
- [[docs/testing/frontend/e2e|Frontend E2E Tests]]
- [[docs/guides/deployment|Deployment Guide]]
- [[docs/security/index|Security Documentation]]
- [[docs/reference/scripts|Scripts Reference]]
