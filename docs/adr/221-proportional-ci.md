---
title: "ADR-221: Proportional CI for a single-user macOS app"
type: adr
status: accepted
date: 2026-10-19
tags:
  [
    adr,
    ci-cd,
    github-actions,
    testing,
    coverage,
    release,
    supply-chain,
    dependabot,
    trivy,
    codeql,
    adr-050,
  ]
description: "Accepted on 2026-10-19 by Tor. ci.yml shrinks from about 22 jobs to seven (Detect Changes, Repo Checks, Lint, Type Check, Test (Frontend), Test (Backend), CI Complete); the Quality Gate job goes. Pull requests run the frontend suite in two shards without coverage; pushes to main keep the coverage ratchet. Native Runtime Verify and the live API contracts fold into Test (Backend). Trivy leaves CI and release. Dependabot groups updates per ecosystem. Release verification requires a passing CI Complete on the tagged commit instead of re-running the suites. Supersedes the Trivy part of ADR-050."
aliases: [adr-221, proportional ci, seven-job ci, ci layout 2026-10]
related_code:
  [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/dependabot.yml",
    "scripts/ci-classify.py",
    "scripts/ci-cancellation-policy.ts",
    "scripts/audit-js.sh",
  ]
---

# ADR-221: Proportional CI for a single-user macOS app

## Status

Accepted on 2026-10-19. Tor approved the change.

It supersedes only the Trivy scanning decision of
[[docs/adr/050-ci-supply-chain-security-tooling|ADR-050]]. ADR-050's gitleaks, `bun audit`,
pip-audit, CodeQL and Electron `--ignore-scripts` decisions stay in force.

## Date

2026-10-19

## Context

Vision is a single-user, self-hosted app shipped only as an Apple Silicon macOS package. Its CI
had grown to about 22 jobs in `.github/workflows/ci.yml`, many of them small static checks that
each paid for a runner, a checkout and a toolchain setup. On recent pull request runs the median
time to `CI Complete` was 13 minutes.

- The frontend coverage job was the slowest step: about 9.3 minutes median, and 12.4 minutes on
  run 39260704223.
- `Native Runtime Verify` and `Test (Live API Contracts)` each installed PostgreSQL 18, built
  the production frontend and started the native stack again, separately from `Test (Backend)`.
- A `Quality Gate` job aggregated the pre-runtime jobs, and `CI Complete` aggregated again.
- Trivy scanned the repository filesystem in CI and again in release. Its dependency findings
  overlapped Dependency Review, `bun audit` and pip-audit, and no product image is built since
  [[docs/adr/133-native-only-runtime-and-delivery|ADR-133]].
- Dependabot opened one pull request per dependency. Ten single-bump pull requests landing
  together each ran the full CI and queued behind each other.
- The release `verify` job re-ran lint, type checks, generated-artifact checks, the native
  checks and every test suite on a commit that had already passed CI on `main`.

## Decision

### Seven CI jobs

`ci.yml` has seven jobs:

| Job               | Runs on    | Contents                                                                                                                                                                                                             |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Detect Changes`  | every diff | `scripts/ci-classify.py`; fails safe to a code diff                                                                                                                                                                  |
| `Repo Checks`     | every diff | PR dependency review, gitleaks, agent-instruction and CI-classification checks, package boundaries, workflow supply-chain policy, commitlint, branch-protection verifier                                             |
| `Lint`            | code diffs | `bun audit`, frontend and backend ESLint, locale and OpenAPI-type drift, endpoint matrix, repository script tests, destructive-migration gate, pip-audit, `mypy --strict`, Alembic audit callback test               |
| `Type Check`      | code diffs | every strict TypeScript program (frontend, shared packages, backend, backend tests, scripts, Electron shell), shared package tests, production frontend build and bundle-size check                                  |
| `Test (Frontend)` | code diffs | pull requests: two shards (`1/2`, `2/2`) without coverage; push to `main`: one unsharded `test:coverage` run with the v8 ratchet                                                                                     |
| `Test (Backend)`  | code diffs | Electron and native-runtime contract tests, backend tests with coverage on native PostgreSQL 18, database lifecycle tasks, one production frontend build, native health and migration round trip, live API contracts |
| `CI Complete`     | every diff | the only required status check                                                                                                                                                                                       |

The `Quality Gate` job is removed. `CI Complete` requires `Detect Changes` and `Repo Checks` to
succeed on every diff and every code job to succeed on a code diff. A skipped code job on a code
diff is fatal. A cancelled job passes only when `scripts/ci-cancellation-policy.ts` confirms the
pull request head has moved on.

The workflow drops the `ready_for_review` trigger. Every job, including the live API contracts,
also runs on draft pull requests, so marking a pull request ready does not start a second run.

### Frontend coverage on `main` only

Pull requests run the frontend suite without coverage, split over two runners, and no longer post
a frontend coverage comment. Every push to `main` runs the whole suite once with the coverage
ratchet in `apps/frontend/vite.config.ts`. Backend coverage still runs, and is reported, on pull
requests.

Locally, one half of the frontend suite without coverage took 341 seconds on 4 cores. On the
first CI run of this change (run 39265443115, PR #302) the two frontend shards took 4.0 and
5.0 minutes and the whole run took 5.6 minutes to `CI Complete`. That run is a single sample, and
its backend job stopped early on an unrelated test failure, so the backend part of the figure is
not yet a full measurement.

### Trivy removed

Trivy no longer runs in CI or release, and `.trivyignore` is deleted. Supply-chain coverage is
Dependency Review on pull requests, `bun audit` through `scripts/audit-js.sh`, pip-audit, gitleaks
and CodeQL (`.github/workflows/codeql.yml`, gated by the ruleset's `code_scanning` rule).

### Dependabot groups

`.github/dependabot.yml` keeps the weekly schedule and the seven-day cooldown for the Bun
workspace, the Electron npm lockfile, `config/` pip requirements and GitHub Actions. Each
ecosystem has one group matching every dependency, so routine version updates arrive as at most
one pull request per ecosystem per week.

### Release reuses the CI result

The release `verify` job keeps the tag format check, the `main` ancestry check, the tag and
manifest version check, the full-tree gitleaks scan, `scripts/audit-js.sh` and pip-audit. It no
longer runs lint, type checks, generated-artifact checks, native checks or test suites. It
requires a `CI Complete` check run with conclusion `success` from the `github-actions` app on the
tagged commit, read through the check-runs API with `checks: read`. Pushes to `main` are never
cancelled, so every release candidate has a push run. For a code push that run includes the
frontend coverage ratchet; a documentation-only push passes `CI Complete` without the code jobs, so
its code evidence is the run of the earlier code push. macOS packaging and publication are
unchanged.

## Consequences

- Fewer runners per pull request and no repeated PostgreSQL install, frontend build or
  native-stack start for the runtime and contract checks. The first PR run reached `CI Complete`
  in 5.6 minutes against a 13-minute median before (one sample; see above).
- A frontend coverage drop is no longer caught on the pull request. It fails the push run on
  `main` after merge and blocks a release from that commit until fixed. Contributors should run
  `bun run test:coverage` locally when a change may lower coverage.
- Live API contracts now run on draft pull requests, which costs runner time on drafts that
  previously skipped them.
- A failure inside the merged `Lint`, `Type Check` or `Test (Backend)` jobs stops later steps in
  that job, so one run can report fewer independent failures than before.
- Without Trivy, filesystem secret and misconfiguration findings rely on gitleaks and CodeQL, and
  dependency findings rely on Dependency Review, `bun audit` and pip-audit. GitHub does not list
  `bun.lock` as a supported dependency graph format, so Dependency Review does not review
  transitive Bun lockfile changes; `bun audit` covers those advisories.
- A release cannot start until CI on the tagged commit has finished successfully. Re-running a
  failed or missing CI run is the fix; the release workflow does not fall back to running the
  suites itself.
- The release check trusts any `CI Complete` check run from GitHub Actions on that commit. No
  other workflow may define a job named `CI Complete`.
- Grouped Dependabot pull requests bundle several updates, so one bad bump fails the whole group
  and must be split out by hand.

## Related

- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/testing/testing|Testing Documentation]]
- [[docs/testing/frontend-component-integration|Frontend Component-Integration Tests]]
- [[docs/security/index|Security Documentation]]
- [[docs/features/application-updates|Application Updates]]
- [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050: CI supply chain security tooling]]
- [[docs/adr/116-gated-release-candidate-promotion|ADR-116: Gated release candidate promotion]]
- [[docs/adr/133-native-only-runtime-and-delivery|ADR-133: Native-only runtime and delivery]]
- [[docs/adr/168-github-release-trust-boundary|ADR-168: GitHub release trust boundary]]
- [[docs/adr/index|All ADRs]]
