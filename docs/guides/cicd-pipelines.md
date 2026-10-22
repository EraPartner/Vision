---
title: CI/CD Pipelines
type: guide
status: active
date: 2026-10-22
updated: 2026-10-20
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
description: The seven-job GitHub Actions CI layout, native PostgreSQL verification, Dependabot grouping, and the macOS release flow that reuses the CI Complete result.
aliases: [CI, CD, GitHub Actions, release pipeline]
related_code: [".github/workflows/ci.yml", ".github/workflows/release.yml"]
---

# CI/CD Pipelines

Vision CI uses native processes and disposable PostgreSQL 18 clusters. It does not build, verify,
scan, or publish a product container image. The required aggregate check remains **CI Complete**.

## Pull-request and push CI

`.github/workflows/ci.yml` runs seven jobs
([[docs/adr/221-proportional-ci|ADR-221]]). `Detect Changes` classifies the diff with
`scripts/ci-classify.ts`; `Repo Checks` and `CI Complete` run on every diff, and the four code
jobs run only when the diff is classified as code:

| Job                                     | Runs on             | Evidence                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Detect Changes`                        | every diff          | path classification (`code` output; fails safe to `true`)                                                                                                                                                                                |
| `Repo Checks`                           | every diff          | PR dependency review, gitleaks, agent-instruction and CI-classification checks, package boundaries, workflow supply-chain policy (each with its tests), commit-message check (`scripts/commitlint.ts`), branch-protection verifier                                           |
| `Lint`                                  | code diffs          | `bun audit` (`scripts/audit-js.sh`), frontend and backend ESLint (with type-aware rules), import boundaries (`lint:deps`) and dead code (`lint:dead`) through `bun run lint`, locale and OpenAPI-type drift, endpoint matrix, `test:scripts`, squawk migration lint (`db:lint`)                                                                     |
| `Type Check`                            | code diffs          | strict TypeScript for frontend, shared packages, backend, backend tests, backend and repository scripts, and the Electron shell; shared package tests; production frontend build and `size:check`                                        |
| `Test (Frontend 1/2)`, `(Frontend 2/2)` | code PRs            | Vitest split over two runners with `--shard`, without coverage                                                                                                                                                                           |
| `Test (Frontend 1/1)`                   | code push to `main` | one unsharded `test:coverage` run that enforces the v8 coverage ratchet in `apps/frontend/vite.config.ts`                                                                                                                                |
| `Test (Backend)`                        | code diffs          | Electron and native-runtime contract tests, backend tests with coverage on native PostgreSQL 18 and the Kysely type drift check, one production frontend build, native production-health and migration-reversibility smoke, live API contracts |
| `CI Complete`                           | every diff          | aggregate result; the only required status check                                                                                                                                                                                         |

`CI Complete` keeps a stable branch-protection name. On a documentation-only diff it passes once
`Detect Changes` and `Repo Checks` succeed. On a code diff every code job must report `success`;
a skipped or failed job is fatal. A cancelled job is tolerated only when
`scripts/ci-cancellation-policy.ts` confirms the pull request head has moved on. There is no
separate Quality Gate job.

The workflow triggers on pushes to `main` and on `opened`, `synchronize` and `reopened` pull
request events. Every job, including the live API contracts, also runs on draft pull requests, so
marking a pull request ready does not start a second run. Superseded pull request runs are
cancelled; pushes to `main` are never cancelled, so every `main` commit gets a `CI Complete`
verdict. On a documentation-only push that verdict covers only `Detect Changes` and
`Repo Checks`.

Pull requests do not measure frontend coverage and no longer receive a frontend coverage comment.
The coverage ratchet runs on every push to `main`, and a release requires that run to have passed.
A change that lowers coverage below a threshold therefore fails on `main` after merge, not on the
pull request. Run `bun run test:coverage` locally when a change may affect coverage. The backend
job still reports backend coverage on the pull request.

The frontend build is followed by `size:check`. Its reviewed gzip limits are 460 KB for the
initial preload graph and 1374 KB for all route assets
(`apps/frontend/scripts/check-bundle-size.ts`). The last recorded measurement, after the
type-aware lint rules of [[docs/adr/225-static-checks-for-agents|ADR-225]], is 459.52 KB and
1372.93 KB respectively. The preload limit was lowered when the Belgian tax engine and its tax
tables left the browser ([[docs/adr/217-belgian-tax-figures-on-the-server|ADR-217]]); the
remaining household schema and migration helpers stay lazy as required by
[[docs/adr/200-belgian-tax-household-model|ADR-200]].
The checker reads the generated `index.html` and assets to catch new eager imports and total
bundle growth.

The repository has no Python. The pip-audit, `mypy --strict` and destructive-migration steps left
`Lint` with Alembic ([[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]). `Lint` now
runs `bun run db:lint`, which lints `db/migrations/*.sql` with squawk and `config/squawk.toml`;
destructive DDL fails unless a `-- squawk-ignore <rule>` comment marks it as intended.

The backend source (`src/**/*.ts`) is checked by the strict `apps/node-backend/tsconfig.json` in
the `Type Check` job; see
[[docs/adr/186-backend-strict-typescript|ADR-186]] and
[[docs/adr/191-retire-backend-checkjs|ADR-191]]. The earlier checkJs program and its
`noImplicitAny` ratchet were retired once the last JavaScript source file converted. The backend
tests (`tests/**/*.ts`) are checked by the strict `apps/node-backend/tsconfig.tests.json` in a
second step of the same job ([[docs/adr/192-backend-tests-strict-typescript|ADR-192]]).
The same job installs the Electron workspace and runs `bun run typecheck:electron`, which checks
the strict TypeScript Electron shell (`packaging/electron/tsconfig.json`) and its sandboxed preload
(`packaging/electron/tsconfig.preload.json`) without emitting
([[docs/adr/196-electron-shell-typescript|ADR-196]]). `bun run test:electron` compiles the shell
into `packaging/electron/out/` before running its `node:test` suites in `Test (Backend)`, and the
release packaging job compiles
it with `bun build.ts` before `node out/scripts/build-native-package.js` packages the app.

### Dependency and workflow admission

The shared Bun setup runs a frozen install with lifecycle scripts disabled and does not restore a
general Bun dependency cache. The Electron install in CI and release jobs is also frozen and
script-disabled. Trusted jobs call the checked-in TypeScript binary instead of
using `bunx` fallback downloads.

`scripts/check-package-boundaries.ts` requires every tracked application/package manifest to be
reviewed and `private: true`. It rejects an internal `@vision/*` dependency that does not use a
reviewed workspace and an internal name in either Bun lockfile that resolves from a registry.
It also checks manifest and lockfile dependency agreement, requires integrity digests for registry
packages, and rejects direct external package sources except reviewed tarballs pinned by URL and
sha512 integrity (today only SheetJS `xlsx` 0.20.3 from `cdn.sheetjs.com`, which SheetJS no longer
publishes to npm). It admits only the two reviewed project install hooks. The pull-request-only GitHub dependency review step in `Repo Checks` rejects new high or
critical severity vulnerabilities in ecosystems GitHub supports. GitHub does not currently list `bun.lock` as a supported dependency graph
format, so this check must not be treated as review of transitive Bun lockfile changes. The shared
`scripts/audit-js.sh` audits both the root and Electron Bun lockfiles for known high or critical
advisories. The package boundary check verifies their sources and integrity fields.
`scripts/check-workflow-supply-chain.ts` requires full commit SHA pins for external Actions,
full commit SHA refs for external repository checkouts, `persist-credentials: false` on every
checkout, and the frozen script-disabled shared install. Agent tooling checks use only the
checked-in project scripts; no external agent-container repository is fetched.
Both checks and their adversarial tests run in the `Repo Checks` job. Release verification relies
on the `CI Complete` result for the tagged commit instead of running them again.

Dependabot checks the root Bun workspace, the Electron npm lockfile and GitHub Actions weekly, and delays routine version updates by seven days. Each
ecosystem has one group matching every dependency, so routine updates arrive as at most one
grouped pull request per ecosystem per week. Security updates are not delayed by the cooldown.
Automatic dependency merging is disabled; every update requires human review. The sole maintainer reports that the
live branch rules require `CI Complete`; this was not independently read back.

The sole maintainer reports that the GitHub settings are enabled. The first hosted release still
needs to pass the release checks below before its artifacts are treated as verified.

### Native database checks

`Test (Backend)` installs PostgreSQL 18 packages on the runner and uses `scripts/with-test-db.sh`
and the native runtime smoke harness. Each cluster is private, loopback only, migrated with the
Kysely migrator to the latest `db/migrations/` file, and removed after its step. The test harness
uses a generated password and SCRAM authentication so role-bootstrap password rejection is tested.
It also enables the extensions required by production behavior. This is a real PostgreSQL check,
not a mock and not a dependency on a pre-existing runner service.
Direct `bun run test:db` runs also create a disposable cluster even if database URLs are exported;
using a caller-managed test database requires `VISION_TEST_DB_USE_CALLER=1`.

The backend job enables the audit and transaction performance probes and sets
`VISION_TEST_DB_VERIFY_CODEGEN=1`, so the run fails when
`apps/node-backend/src/database/schema.generated.ts` differs from `kysely-codegen` output for the
migrated schema. Migrator behaviour, including the refusal of a database from before the baseline
([[docs/adr/224-remove-alembic-adoption|ADR-224]]), is covered by the ordinary suite
(`tests/migrate.db.test.ts`). The same job then builds the production frontend once and starts the
native production stack twice, in sequence: first migrate, `/health` and, when the latest
migration ships a `.down.sql`, a down/up round trip (`VISION_NATIVE_VERIFY_MIGRATIONS=1`), then the
live API contracts against the real backend.

### Security scanning

Repository security scanning is gitleaks, PR dependency review, `bun audit` in `ci.yml`, plus CodeQL in `.github/workflows/codeql.yml`. CodeQL is gated by the branch ruleset's
`code_scanning` rule rather than by a required status check. Trivy is no longer run in CI or
release, and `.trivyignore` was removed; see [[docs/adr/221-proportional-ci|ADR-221]], which
supersedes the Trivy part of [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050]].

## Release workflow

`.github/workflows/release.yml` runs for version tags and manual releases:

1. **Verify Release** checks the tag format, that the tag's commit is reachable from `main`, and
   that the tag matches the root, frontend and Electron manifest versions. It does not run lint,
   type checks, tests or native checks again. Instead it requires a successful `CI Complete`
   check run from the GitHub Actions app on the tagged commit, which is the push run on `main`
   that includes the frontend coverage ratchet. It then runs the checks whose answer can change
   after CI: a full-tree gitleaks scan, and `scripts/audit-js.sh`. If CI on that commit
   has not finished or failed, wait for it or re-run it before releasing.
2. **Build mac .app + DMG** builds the ad-hoc signed native macOS artifacts from the exact
   verified commit with pinned runtime inputs. It scans the packaged app into a CycloneDX software
   bill of materials (SBOM), checks that it contains components, and attests the artifacts and SBOM
   through GitHub. The former source-launcher bundle and source SBOM were retired by
   [[docs/adr/218-retire-source-launcher-update-channel|ADR-218]]. The app does not
   have Apple Developer ID signing or notarization.
3. **Create GitHub Release** downloads the staged artifacts, verifies build provenance, and adds
   every asset to a release-environment-gated draft. It checks exact asset names, sizes, digests
   and checksum contents, rechecks the tag's commit, then publishes the draft. The release
   environment reviewer must confirm that immutable releases are enabled before approving this
   job. The workflow reads back the published release's immutable state; if it is mutable, it
   immediately attempts to return it to draft and fails the run. This cannot erase downloads made
   during that short public window. GitHub immutable releases must be read back live before
   claiming published asset and tag immutability.

Release artifacts include checksums and the SBOM file. To inspect it, download
`Vision-app.cdx.json` from the release and view its `components` array.
To verify a downloaded artifact against GitHub's build attestation, run
`gh attestation verify FILE --repo EraPartner/Vision --signer-workflow EraPartner/Vision/.github/workflows/release.yml`.
The SBOM attestation uses the same artifact subjects and includes the corresponding CycloneDX file.
GitHub is the trusted publisher; the updater does not verify
an independent signing key or attestation. The workflow does not publish an application image or
image metadata. See [[docs/features/application-updates|Application Updates]],
[[docs/adr/168-github-release-trust-boundary|ADR-168]], and
[[docs/adr/133-native-only-runtime-and-delivery|ADR-133]].

### GitHub settings required before the first protected release

These settings live on GitHub; the workflow file cannot enable them.

1. In **Settings → Rules → Rulesets**, make an active branch ruleset targeting `main`. Require a
   pull request and the `CI Complete` status check, and block force pushes and deletion.
2. Make an active tag ruleset targeting `v*`. Restrict tag updates and deletion. Keep release tag
   creation available to the maintainer.
3. In **Settings → Environments**, create `release`. Add the sole maintainer as a required reviewer
   and leave **Prevent self-review** off, so a release they trigger can be approved. Limit deployment
   branches/tags to version tags if that option is available in the repository settings. Before
   approving each release job, confirm step 4 is still enabled; the workflow token cannot read
   this administration setting.
4. In **Settings → General → Releases**, enable release immutability before publishing a new
   version. It applies to future releases, not releases already published.

Record the sole maintainer's confirmation that these settings are enabled. This confirmation does
not independently prove ruleset enforcement or detect later settings changes. After a release,
verify the published release's immutable state, its tag commit and the release asset list; download
an artifact and run the attestation command above. A failed hosted build or missing setting blocks
release acceptance until the cause is fixed.

## Local verification

Use the narrowest relevant commands during development, then run the repository gates required by
the change:

```bash
bun run lint
bun run lint:backend
bun run typecheck
bun run typecheck:electron
bun run db:lint
bun run validate-locales
bun run test:scripts
bun run test
bun run test:frontend
bun run test:electron
bun run native:isolated-smoke
```

`bun run check` aggregates repository checks, including `test:frontend`, which requires native
PostgreSQL 18 and runs live API contracts against a disposable backend. Packaging and signing
claims still require their focused jobs.

There is no local pre-push gate. Run the relevant lint, typecheck, build, and test commands
explicitly before publication, scaled to the change as described in `AGENTS.md`. GitHub Actions
runs the required checks after a push; a successful local push does not establish that they passed.
Database-backed and live API checks use disposable PostgreSQL 18 clusters. The native stack finds
PostgreSQL 18 on Linux or macOS; `VISION_CI_POSTGRES_BIN` can select another installation.
It refuses an occupied backend port before starting, then tracks the backend process directly so
cleanup cannot leave a server for the next run to mistake as its own.

## Pull-request completion and merge

Do not infer remote success from local checks. Read the exact GitHub Actions results for the pull
request and confirm `CI Complete`, required reviews, and code-scanning state. Native auto-merge may
be enabled only when the user explicitly requests it and the repository rules allow it; no admin
bypass is permitted.

## Related

- [[docs/adr/221-proportional-ci|ADR-221: Proportional CI]]
- [[docs/testing/testing|Testing Guide]]
- [[docs/guides/deployment|Deployment Guide]]
- [[docs/security/index|Security Documentation]]
- [[docs/reference/scripts|Scripts Reference]]
