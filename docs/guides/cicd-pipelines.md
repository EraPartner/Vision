---
title: CI/CD Pipelines
type: guide
status: active
date: 2026-09-25
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
related_code: [".github/workflows/ci.yml", ".github/workflows/release.yml"]
---

# CI/CD Pipelines

Vision CI uses native processes and disposable PostgreSQL 18 clusters. It does not build, verify,
scan, or publish a product container image. The required aggregate check remains **CI Complete**.

## Pull-request and push CI

`.github/workflows/ci.yml` classifies changed paths and runs the relevant independent jobs:

| Area              | Jobs and evidence                                                              |
| ----------------- | ------------------------------------------------------------------------------ |
| Repository policy | cloud tooling, package/workflow supply-chain checks, commitlint, secrets scan  |
| Dependencies      | PR dependency review, Bun audit and pip-audit                                  |
| Static checks     | frontend/backend lint, frontend/backend type checks, generated-artifact checks |
| Builds and tests  | frontend build, frontend tests, Electron/runtime tests, backend tests          |
| Database safety   | destructive-migration check against repository source                          |
| Security          | Trivy filesystem scan with table and SARIF output                              |
| Runtime           | native production-health and migration-reversibility smoke                     |
| Contracts         | live API contract tests against a native backend and disposable PostgreSQL 18  |

`quality-gate` aggregates the portable pre-runtime checks. `CI Complete` aggregates every required
stage and keeps a stable branch-protection name. A skipped path-filtered job is handled explicitly;
an absent or failed required result is not treated as green.

The frontend build is followed by `size:check`. Its measured gzip limits are 468 KB for the
initial preload graph and 1100 KB for all route assets. The limits include about five percent
headroom over the 2026-09-24 production build; the checker reads the generated `index.html`
and assets to catch new eager imports and total bundle growth.

The backend runs the base JSDoc type check and a `noImplicitAny` check over every `src/` file.
The latter compares diagnostics with `scripts/checkjs-ratchet-baseline.json`, which records the
1,254 existing diagnostics measured on 2026-09-24 by file, code, message, and source line. A
new diagnostic fails CI, including one in a newly added file. A corrected diagnostic also
requires removal of its baseline entry, so the same error cannot silently return later.

### Dependency and workflow admission

The shared Bun setup runs a frozen install with lifecycle scripts disabled and does not restore a
general Bun dependency cache. The Electron install in CI and release jobs is also frozen and
script-disabled. Trusted jobs call the checked-in TypeScript binary instead of
using `bunx` fallback downloads.

`scripts/check-package-boundaries.js` requires every tracked application/package manifest to be
reviewed and `private: true`. It rejects an internal `@vision/*` dependency that does not use a
reviewed workspace and an internal name in either Bun lockfile that resolves from a registry.
It also checks manifest and lockfile dependency agreement, requires integrity digests for registry
packages, rejects direct external package sources, and admits only the two reviewed project install
hooks. The pull-request-only GitHub dependency review job rejects new high or critical severity
vulnerabilities in ecosystems GitHub supports, and `quality-gate` requires that job to succeed on
every pull request. GitHub does not currently list `bun.lock` as a supported dependency graph
format, so this check must not be treated as review of transitive Bun lockfile changes. The shared
`scripts/audit-js.sh` audits both the root and Electron Bun lockfiles for known high or critical
advisories. The package boundary check verifies their sources and integrity fields.
`scripts/check-workflow-supply-chain.py` requires full commit SHA pins for external Actions,
full commit SHA refs for external repository checkouts, `persist-credentials: false` on every
checkout, and the frozen script-disabled shared install. The LockBox drift check executes its
reviewed pinned revision; updating that revision requires an explicit workflow diff.
Both checks run in CI and release verification; their adversarial tests run in CI.

Dependabot delays routine version updates by seven days across the configured ecosystems. Security
updates are not delayed by this setting. Updates are opened separately. Automatic dependency
merging is disabled; every update requires human review. The sole maintainer reports that the
live branch rules require `CI Complete`; this was not independently read back.

The sole maintainer reports that the GitHub settings are enabled. The first hosted release still
needs to pass the release checks below before its artifacts are treated as verified.

### Native database jobs

Database-backed jobs install PostgreSQL 18 packages on the runner and use
`scripts/with-test-db.sh` or the native runtime smoke harness. Each cluster is private, loopback
only, migrated to the current Alembic head, and removed after the job. The test harness uses a
generated password and SCRAM authentication so role-bootstrap password rejection is tested. It also
enables the extensions required by production behavior. This is a real PostgreSQL check, not a
mock and not a dependency on a pre-existing runner service.
Direct `bun run test:db` runs also create a disposable cluster even if database URLs are exported;
using a caller-managed test database requires `VISION_TEST_DB_USE_CALLER=1`.

The backend CI job enables the audit and transaction performance probes, then runs migration
fidelity, legacy retirement, ADR-088, ADR-090, and statement-scalar contract lifecycles in separate
disposable clusters. Contract suites intentionally skip in the ordinary head-schema run because
their fixtures require the guarded manual schema drop.

### Security scan

Trivy scans the checked-out filesystem for vulnerable dependencies and known secrets. Results are
uploaded to GitHub code scanning as SARIF when permitted. JavaScript and Python dependency audits
remain separate gates so package-manager findings are visible even when the filesystem scan is
unchanged.

## Release workflow

`.github/workflows/release.yml` runs for version tags and manual releases:

1. **Verify Release** checks that the tag's commit is reachable from `main`, checks the tag and
   manifest versions, scans secrets and the release
   filesystem, audits dependencies, regenerates checked artifacts, runs lint/type checks, builds
   the frontend and its bundle limit, exercises native health and migration reversibility, and runs
   script, Electron, frontend coverage, backend coverage against a disposable PostgreSQL cluster,
   and live API contract tests.
2. **Build mac .app + DMG** builds the ad-hoc signed native macOS artifacts and source-launcher
   update bundle from the exact verified commit with pinned runtime inputs. It scans the packaged
   app and source tree into separate CycloneDX software bills of materials (SBOMs), checks that
   each contains components, and attests the artifacts and SBOMs through GitHub. The app does not
   have Apple Developer ID signing or notarization.
3. **Create GitHub Release** downloads the staged artifacts, verifies build provenance, and adds
   every asset to a release-environment-gated draft. It checks exact asset names, sizes, digests
   and checksum contents, rechecks the tag's commit, then publishes the draft. The release
   environment reviewer must confirm that immutable releases are enabled before approving this
   job. The workflow reads back the published release's immutable state; if it is mutable, it
   immediately attempts to return it to draft and fails the run. This cannot erase downloads made
   during that short public window. GitHub immutable releases must be read back live before
   claiming published asset and tag immutability.

Release artifacts include checksums and the two SBOM files. To inspect one, download
`Vision-app.cdx.json` or `Vision-source.cdx.json` from the release and view its `components` array.
To verify a downloaded artifact against GitHub's build attestation, run
`gh attestation verify FILE --repo EraPartner/Vision --signer-workflow EraPartner/Vision/.github/workflows/release.yml`.
The SBOM attestations use the same artifact subject and include the corresponding CycloneDX file.
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

- [[docs/testing/testing|Testing Guide]]
- [[docs/guides/deployment|Deployment Guide]]
- [[docs/security/index|Security Documentation]]
- [[docs/reference/scripts|Scripts Reference]]
