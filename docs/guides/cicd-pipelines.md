---
title: CI/CD Pipelines
type: guide
status: active
date: 2026-04-28
updated: 2026-07-27
tags: [guide, cicd, github-actions, testing, linting, docker, release, packaging, automation, april-2026, may-2026, security, secrets-scan, deps-audit, trivy-scan, quality-gate, verify-compose-sync, verify-destructive-migrations, ci-complete, live-api-contracts, branch-protection]
description: GitHub Actions CI/CD pipelines including continuous integration checks, supply chain security scanning (secrets, dependencies, container images), quality gates, Docker Compose sync verification, destructive-migration marker enforcement, and release automation with checksums
aliases: [github-actions, ci-cd, pipelines, release-workflow, testing-automation, security-scanning, quality-gates, branch-protection]
related_code: [".github/workflows/ci.yml", ".github/workflows/release.yml", "config/gitleaks.toml", ".githooks/pre-commit", "packaging/electron/main.js", "packaging/electron/assets/error.html", "packaging/electron/resources/docker-compose.yml", "docker-compose.yml"]
---

# CI/CD Pipelines

Vision uses **GitHub Actions** for continuous integration and release automation. Two main workflows handle different phases:

- **ci.yml** — Runs on every commit to validate code quality and functionality
- **release.yml** — Runs on version tags to publish Docker images and packaged artifacts

---

## Continuous Integration (ci.yml)

The CI workflow runs on every push to `main` and PR. It validates code quality, types, tests, and deployment readiness. Security tooling (secrets scan, dependency audit, container scanning) runs first and blocks merge on critical findings.

### Workflow Definition

**Trigger:**
```yaml
on:
  push:
    branches: [main]
    paths-ignore:
      - "docs/**"
      - "*.md"
  pull_request:
    branches: [main]
    paths-ignore:
      - "docs/**"
      - "*.md"
```

**Permissions:** Minimal per-job basis; most jobs run with `contents: read` only.

### Jobs

#### 0. **secrets-scan** — Prevent Credential Leaks

Scans git history for hardcoded secrets, API keys, passphrases before they reach CI.

```yaml
secrets-scan:
  runs-on: ubuntu-latest
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0  # Full history scan on PR
    - uses: gitleaks/gitleaks-action@v2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**What it detects:**
- AWS credentials, GitHub tokens, private keys
- API keys (Stripe, AWS, custom services)
- Database connection strings
- Slack webhooks, Discord tokens
- Any pattern matching known secret formats

**Config:** `config/gitleaks.toml` allowlists documentation placeholders and Obsidian plugin artifacts

**Policy:** Blocks merge if secrets found; must rewrite history or rotate exposed credentials immediately

**Related:** [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050 CI Security Tooling]]

---

#### 1. **deps-audit** — Dependency Vulnerability Check

Audits npm/bun packages for HIGH and CRITICAL severity vulnerabilities.

```yaml
deps-audit:
  runs-on: ubuntu-latest
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@v4
    - name: Setup Bun
      uses: oven-sh/setup-bun@v2
    - run: bun install --frozen-lockfile
    - run: bun audit --audit-level=high
```

**What it checks:**
- npm packages in `package.json` and `bun.lock`
- Backend packages in Bun lockfile
- Frontend packages via npm
- Only HIGH and CRITICAL severity (MEDIUM/LOW ignored)

**Policy:** Blocks merge if vulnerability found

**Dependency Overrides:**
- `basic-ftp: 5.3.1` — HIGH CVE (race condition)
- `ip-address: ^10.1.1` — CRITICAL CVE
- `postcss: >=8.5.10` — HIGH parsing vulnerability

**Mitigation Strategy:** When audit finds a vulnerability:
1. Check if override exists in root `package.json`
2. If not, upgrade or find alternative package
3. Add override to `package.json` `overrides` and `resolutions` fields
4. Run `bun install` to regenerate lockfiles

**Related:** [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050 CI Security Tooling]]

---

#### 2. **pip-audit** — Python Dependency Vulnerability Check

Audits the Python dependencies used by the Alembic migration tooling
(`config/requirements.txt`) for known CVEs. (Container-image scanning is a
separate Docker-tier job — see **trivy-scan** below.)

```yaml
pip-audit:
  name: Deps Audit (Python)
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v5
      with:
        python-version: '3.12'
    - run: pip install pip-audit && pip-audit -r config/requirements.txt
```

**Policy:** Blocks the quality gate if a vulnerable Python dependency is found.

**Related:** [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050 CI Security Tooling]]

---

#### 3. **verify-compose-sync** — Docker Compose Sync Check

Verifies that named volumes in `docker-compose.yml` match those in `packaging/electron/resources/docker-compose.yml` (the embedded Electron compose file).

```yaml
verify-compose-sync:
  name: Verify Compose Volume Sync
  runs-on: ubuntu-24.04
  timeout-minutes: 5
  steps:
    - uses: actions/checkout@v4
    - name: Check named volumes match between compose files
      run: |
        ROOT_VOLS=$(awk '/^volumes:/{found=1; next} found && /^  [a-zA-Z]/{gsub(/:$/, "", $1); print $1}' docker-compose.yml | sort)
        ELECTRON_VOLS=$(awk '/^volumes:/{found=1; next} found && /^  [a-zA-Z]/{gsub(/:$/, "", $1); print $1}' packaging/electron/resources/docker-compose.yml | sort)
        if [ "$ROOT_VOLS" != "$ELECTRON_VOLS" ]; then
          echo "ERROR: Named volumes out of sync"
          exit 1
        fi
```

**Why it's critical:**

Named volumes in Docker Compose define persistent data storage. If a volume is added to the root `docker-compose.yml` but omitted from the embedded Electron compose, the packaged app will not share that volume — data stored in the root deployment won't be accessible in the desktop app, or vice versa. This caused the **v1.0.2 bug** where attachments were wiped on update.

**Policy:** Blocks quality gate if volumes diverge; must add all new named volumes to both compose files before merging.

**Related:** [[docs/adr/051-docker-compose-sync-named-volumes|ADR-046]] (v1.0.2 attachments bug analysis + fix)

---

#### 3b. **verify-destructive-migrations** — Unmarked Destructive DDL Check

Scans every file in `alembic/versions/` for destructive DDL in `upgrade()` that carries no explicit `# destructive-ok: <reason>` marker.

```yaml
verify-destructive-migrations:
  name: Verify Destructive Migrations
  runs-on: ubuntu-24.04
  timeout-minutes: 5
  steps:
    - uses: actions/checkout@v4
    - name: Self-test the checker
      run: python3 scripts/check-destructive-migrations.py --self-test
    - name: Check migrations for unmarked destructive DDL
      run: python3 scripts/check-destructive-migrations.py
```

**Why it's critical:**

`docker-entrypoint.sh` runs `alembic upgrade head` unconditionally on every boot, so a migration in the chain reaches every self-hosted database on the next container start — with or without the application code that depends on it. `0055_drop_bank_account_string` dropped columns, a trigger and a materialized view ahead of its coupled code and **crashed startup**; `0055` is now a no-op and `0056` is its recovery. Until this job existed, the only thing preventing a repeat was a docstring and developer memory of that one incident.

Flags `DROP TABLE` / `DROP COLUMN` (always), unreplaced `DROP` of a view/matview/trigger/function/type, and every `ALTER COLUMN ... TYPE`. Ignores `DROP INDEX`/`DROP CONSTRAINT`, `downgrade()` bodies, and the non-auto-applied `alembic/legacy_versions/` and `alembic/manual/` trees.

**Policy:** Blocks quality gate. Either mark the statement with a reason (citing an ADR/runbook), or — if running code still reads what is being dropped — move the change out of the chain into `alembic/manual/<name>/`. The checker is stdlib-only Python, so the job needs no `setup-python` step.

**Related:** [[docs/guides/migrations#destructive-ddl-and-the-destructive-ok-marker|Migration Guide: Destructive DDL]] · [[docs/adr/088-account-entity|ADR-088]]

---

#### 4. **lint** — Code Quality

Runs ESLint on frontend and backend source code.

```yaml
lint:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: ESLint (frontend + backend)
      run: bun run lint
```

**What it checks:**
- Unused variables and imports
- Code style consistency
- Common anti-patterns
- Security issues (via eslint-plugin-security)

**Failure:** Blocks further checks; must be fixed before merging.

#### 5. **typecheck** — Frontend TypeScript Validation

Checks frontend TypeScript types without emitting code (`bun run typecheck`,
which runs `tsc` over `tsconfig.app.json` + `tsconfig.node.json`).

```yaml
typecheck:
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/checkout@v4
    - run: bun run typecheck
```

**Failure:** Blocks the quality gate; must be resolved before merging.

#### 6. **typecheck-backend** — Backend Type Validation

Type-checks the backend (`apps/node-backend`), which is JS-with-JSDoc checked by
`tsc` in `checkJs` mode. Separate job so a backend type regression is reported
independently from the frontend.

**Failure:** Blocks the quality gate.

#### 7. **verify-generated** — Generated-Artifact Drift Guard

Guards the two classes of generated files that can silently drift from their
source of truth:

```yaml
verify-generated:
  name: Verify Generated Artifacts
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/checkout@v4
    # Locale TS is generated from i18n/source — en/nl key parity must hold.
    - run: bun run validate-locales
    # OpenAPI → TS types: regenerate and fail if the committed file differs.
    - run: |
        bun run generate:types
        git diff --exit-code -- apps/frontend/src/types/generated.ts
```

**Why it matters:** `apps/frontend/src/types/generated.ts` is derived from
`openapi.yaml`. If a route changes the contract but the committed types aren't
regenerated, the frontend compiles against a stale shape. This job makes that a
hard failure rather than a latent bug. (See also the endpoint-matrix drift note
in [[docs/reference/api-endpoint-matrix]].)

**Failure:** Blocks the quality gate — run `bun run generate:types` and
`bun run validate-locales` locally and commit the result.

#### 8. **build-frontend** — Production Bundle Compile

Verifies the frontend production bundle actually compiles (`CI=1 bun run build`)
— a green typecheck does not guarantee Vite/Rollup will bundle cleanly.

**Failure:** Blocks the quality gate.

#### 9. **test-frontend** — Frontend Unit Tests

Runs Vitest (with coverage) on frontend components, hooks, and utilities, then
posts a coverage report comment on the PR.

```yaml
test-frontend:
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/checkout@v4
    - run: bun run generate-locales
    - run: bun run test:coverage   # enforces the ratchet gate
```

**Coverage gate (NOT a flat 80%):** the frontend uses a **ratchet** configured
in `apps/frontend/vite.config.ts` — thresholds track the *current measured*
coverage with a small buffer (as of 2026-05-29: `statements 50 / branches 41 /
functions 42 / lines 52`, against ~52/44/44/55 actual) and are only ever
raised. The job fails if coverage drops below the ratchet, catching regressions
even though absolute coverage is below 80%. See [[docs/guides/testing|Testing Guide]].

**Failure:** Coverage fell below the ratchet, or a test failed — fix before merging.

#### 10. **test-backend** — Backend Unit & Integration Tests

Runs Vitest on backend services, repositories, and routes against a Postgres
service container.

```yaml
test-backend:
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/checkout@v4
    - run: bun run test          # vitest, backend workspace
```

**What it tests:** service-layer logic, repository data access, Express route
handlers, middleware, and error handling.

**Coverage gate:** backend thresholds are fixed in
`apps/node-backend/vitest.config.js` (`statements 85 / branches 75 /
functions 85 / lines 88`) over the files tests actually reach.

**Failure:** A test failed or backend coverage dropped below threshold.

---

### Docker-Tier Jobs

These run only after `quality-gate` is green. `build-image` pays for the image
build **once**; the rest re-materialise that build from the GitHub Actions build
cache rather than downloading it.

##### The image hand-off is a cache, not an artifact

`build-image` used to `docker save` the image to `/tmp/vision-ci.tar` and upload
it with `actions/upload-artifact`, and each downstream job downloaded and
`docker load`ed it. That ~1 GB upload per run is what exhausted the Actions
artifact-storage quota, and a failed upload failed `build-image` — which
skipped the entire Docker tier.

Today no image artifact exists. `build-image` builds with
`cache-to: type=gha,mode=max` and exports **no image at all**; each consumer
re-runs the identical build with `load: true`, which is a full cache hit and
leaves `vision:ci` in that runner's image store.

The build itself lives in one place — `.github/actions/build-ci-image` — used
by the producer and all three consumers. This is deliberate: BuildKit keys
`type=gha` cache entries on the build inputs, so a consumer whose context,
Dockerfile, build-args or platforms differ from the producer's would silently
miss the cache and pay a full cold rebuild. **Change the image build in that
action, never in an individual job.**

Worst case, GHA's 10 GB cache eviction drops the entries mid-run and a consumer
does a real rebuild — correct, just slow (the Docker-tier job timeouts carry
headroom for exactly this), and no worse than the uncached rebuild
`docker-verify` used to do on every run anyway.

#### 11. **build-image** — Warm the Image Build Cache (once)

```yaml
build-image:
  name: Build Docker Image
  needs: [changes, quality-gate]
  steps:
    - uses: actions/checkout@v4
    # → docker/setup-buildx-action@v3 + docker/build-push-action@v7 with
    #   context: ., tags: vision:ci, cache-from: type=gha, load: false
    - uses: ./.github/actions/build-ci-image
      with:
        cache-to: type=gha,mode=max
```

`cache-to` is set **only** here: the consumers read the cache and must not
write back over the entries they just read.

#### 12. **trivy-scan** — Container Image CVE Scan

Restores `vision:ci` from the build cache and scans it for OS/system-library
vulnerabilities (HIGH/CRITICAL), uploading SARIF to the GitHub Security tab.

```yaml
trivy-scan:
  needs: [build-image]
  permissions:
    contents: read
    security-events: write
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/build-ci-image
      with: { load: "true" }
    - uses: aquasecurity/trivy-action@v0.36.0
      with: { image-ref: vision:ci, severity: HIGH,CRITICAL, exit-code: '1' }
```

**Policy:** scans the same image that ships to GHCR; blocks if HIGH/CRITICAL
found. **Mitigation:** upgrade the `FROM` base image or patch the package.

**Related:** [[docs/adr/039-docker-container-hardening|ADR-039 Container Hardening]], [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050 CI Security Tooling]]

#### 13. **docker-verify** — Container Health Check

Restores `vision:ci` from the build cache, brings the compose stack up on it,
and verifies the backend starts and migrates cleanly.

```yaml
docker-verify:
  runs-on: ubuntu-24.04
  needs: [build-image]
  env:
    COMPOSE_PROJECT_NAME: vision_ci   # never touch the real `vision` volumes
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/build-ci-image
      with: { load: "true" }
    - uses: ./.github/actions/compose-up       # stub .env, up -d, poll /health
      with: { vision-image: "vision:ci" }
    - name: Verify migration reversibility (downgrade -1, upgrade head)
      run: |
        COMPOSE="docker compose -f docker-compose.yml -f docker-compose.ci.yml"
        $COMPOSE exec -T app /venv/bin/alembic -c /app/config/alembic.ini downgrade -1
        $COMPOSE exec -T app /venv/bin/alembic -c /app/config/alembic.ini upgrade head
    - name: Tear down
      if: always()
      run: docker compose -f docker-compose.yml -f docker-compose.ci.yml down -v
```

**`docker-compose.ci.yml` is why the hand-off works.** `docker-compose.yml`'s
`app` service is `build: .` with no `image:` key, so compose names the image it
builds after the project and ignores anything CI prepared — before this overlay
existed, both compose jobs quietly rebuilt the app from source and the
`VISION_IMAGE` export did nothing. The CI-only overlay adds
`image: ${VISION_IMAGE:-vision:ci}` so compose runs the image the job just
restored — the same bits `trivy-scan` scanned. It is passed by
`.github/actions/compose-up` whenever `vision-image` is set, and **every later
`docker compose` call in the job must name both `-f` files.**

The overlay is CI-only: do not add it to the `docker:dev` / `docker:clean`
scripts, to `packaging/electron/resources/`, or to `install-demo.sh`. It is not
covered by the `verify-compose-sync` mirror check either — that check compares
the base file's named volumes and project name, and the overlay declares
neither.

**What it verifies:**
- The built image boots: PostgreSQL starts, the backend responds on `/health`
- Migrations are reversible (`downgrade -1` → `upgrade head` round-trip)
- All services are reachable on expected ports

**Failure:** Indicates a runtime issue; must be resolved before merging.

#### 14. **test-live-api-contracts** — Live API Contract Tests

Validates that MSW (Mock Service Worker) fixture schemas match actual backend responses. Catches divergence between frontend test stubs and production API contracts.

```yaml
test-live-api-contracts:
  name: Test (Live API Contracts)
  needs: [build-image]
  if: ${{ !github.event.pull_request.draft }}
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/build-ci-image
      with: { load: "true" }
    - uses: ./.github/actions/compose-up
      with: { vision-image: "vision:ci" }   # → adds docker-compose.ci.yml
    - name: Run live API contract tests
      run: cd apps/frontend && bun run vitest run src/test/live-contracts/live-contracts.test.ts
    - name: Tear down
      if: always()
      run: docker compose -f docker-compose.yml -f docker-compose.ci.yml down -v
```

**What it tests:**
- Frontend MSW fixtures against real backend responses
- All API endpoint contracts (GET, POST, PUT, DELETE)
- Response shape, status codes, and error handling
- Identifies when backend contracts change without updating test stubs

**Policy:** Blocks merge if fixtures diverge from reality. Runs only on non-draft PRs to avoid CI spam.

**Failure:** Indicates API contract mismatch; either update backend or update frontend fixtures accordingly.

> [!warning] Not run in CI
> Playwright **end-to-end** (`bun run test:e2e`), **visual regression**
> (`bun run test:e2e:visual`), and **mutation testing** (`bun run test:mutation` /
> Stryker) are **not** part of `ci.yml`. There is no `test-e2e` or
> `test-e2e-visual` job (an earlier pair was removed). These suites are run
> locally and/or via the scheduled `e2e.yml` workflow — do not assume a PR's
> green check exercised the browser flows.

---

#### 15. **quality-gate** — Pre-Docker Quality Checkpoint

Aggregates all pre-Docker quality checks to prevent wasting expensive Docker build cycles on broken commits.

```yaml
quality-gate:
  needs:
    - secrets-scan
    - deps-audit
    - pip-audit
    - lint
    - typecheck
    - typecheck-backend
    - verify-generated
    - build-frontend
    - test-frontend
    - test-backend
    - verify-compose-sync
    - verify-destructive-migrations
  if: always()
  steps:
    - name: Check all gates passed
      run: |
        results='${{ toJson(needs.*.result) }}'
        if echo "$results" | grep -qE '"(failure|cancelled)"'; then
          echo "Quality gate failed"
          exit 1
        fi
```

**Checks:**
- All twelve prerequisite jobs must pass: `secrets-scan`, `deps-audit`, `pip-audit`, `lint`, `typecheck`, `typecheck-backend`, `verify-generated`, `build-frontend`, `test-frontend`, `test-backend`, `verify-compose-sync`, `verify-destructive-migrations`
- Runs regardless of individual failures (`if: always()`) but fails if any needed job failed
- Blocks expensive Docker image build until quality gates are green

**Failure:** Indicates an error in earlier stage; must be fixed in that stage before Docker build runs.

**Design:** Gating expensive Docker build after cheap linting/testing prevents CI resource waste on broken code.

#### 16. **ci-complete** — Docker-Tier Aggregation

Final aggregation gate that combines all Docker-intensive CI stages (image scanning, container health, live API contracts). This job should be set as the **single required status check** in GitHub branch protection settings.

```yaml
ci-complete:
  name: CI Complete
  needs: [trivy-scan, docker-verify, test-live-api-contracts]
  if: always()
  steps:
    - name: Check Docker-tier stages passed
      run: |
        results='${{ toJson(needs.*.result) }}'
        if echo "$results" | grep -qE '"(failure|cancelled)"'; then
          echo "CI failed in Docker tier"
          exit 1
        fi
```

**Why separate from quality-gate?**
- Quality-gate runs early, gates expensive Docker build, saves CI time
- ci-complete runs after Docker build, aggregates all Docker results
- Branch protection should require only ci-complete, not individual job names
- If ci-complete passes, entire CI pipeline succeeded

**What it aggregates:**
1. **trivy-scan** — Container image CVE report
2. **docker-verify** — Image builds + backend health check
3. **test-live-api-contracts** — API contracts validated against live backend

**Setting as required check:**
1. Go to GitHub repository → Settings → Branches
2. Under "Branch protection rules", edit rule for "main"
3. Set "ci-complete" as the single required status check
4. Remove individual job names if previously set (ci-complete is the sufficient check)

**Failure:** Indicates failure in Docker-tier scanning or container health; must be fixed before merging.

---

## Release Workflow (release.yml)

The release workflow publishes new versions of Vision to Docker Container Registry (GHCR) and GitHub Releases (Electron packages).

### Workflow Definition

**Trigger:**
```yaml
on:
  push:
    tags:
      - 'v*'
```

Runs when a Git tag matching `v*` (e.g., `v1.2.3`) is pushed.

### Jobs

#### 1. **verify** — Pre-Release Validation (Blocks All Others)

Before publishing, verify the release is safe and complete. This job must pass; all other jobs have `needs: [verify]`.

```yaml
verify:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Check named volumes match between compose files
      run: |
        ROOT_VOLS=$(awk '/^volumes:/{found=1; next} found && /^  [a-zA-Z]/{gsub(/:$/, "", $1); print $1}' docker-compose.yml | sort)
        ELECTRON_VOLS=$(awk '/^volumes:/{found=1; next} found && /^  [a-zA-Z]/{gsub(/:$/, "", $1); print $1}' packaging/electron/resources/docker-compose.yml | sort)
        if [ "$ROOT_VOLS" != "$ELECTRON_VOLS" ]; then
          echo "ERROR: Named volumes out of sync"
          exit 1
        fi
    - name: Check version tag matches package.json
      run: |
        TAG="${{ github.event.inputs.tag || github.ref_name }}"
        TAG_VERSION="${TAG#v}"
        ROOT_VERSION=$(node -p "require('./package.json').version")
        PKG_VERSION=$(node -p "require('./packaging/electron/package.json').version")
        if [ "$TAG_VERSION" != "$ROOT_VERSION" ] || [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
          echo "ERROR: Version mismatch"
          exit 1
        fi
    - name: Audit JS dependencies
      run: bun audit --audit-level=high
```

**Checks:**
1. **Compose volumes sync:** Named volumes in `docker-compose.yml` must match `packaging/electron/resources/docker-compose.yml`
2. **Version alignment:** Tag (e.g., `v1.2.3`) must match both `package.json` and `packaging/electron/package.json`
3. **Dependency audit:** No HIGH or CRITICAL vulnerabilities in release

**Failure:** Release is blocked; must fix code and re-tag.

#### 2. **docker** — Build and Push Docker Image

Builds the Docker image and pushes it to GitHub Container Registry (GHCR) with the version tag.

```yaml
docker:
  needs: [verify]
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Build and push Docker image
      run: |
        docker build -t ghcr.io/erapartner/vision:${{ github.ref_name }} .
        docker push ghcr.io/erapartner/vision:${{ github.ref_name }}
```

**Publishes:**
- Image tag: `ghcr.io/erapartner/vision:v1.2.3` (or current version tag)
- Accessible via: `docker pull ghcr.io/erapartner/vision:v1.2.3`
- Used by: Electron Docker mode updates, containerized deployments

**Failure:** Indicates Dockerfile issue; must fix before re-releasing.

#### 3. **package-mac** — Build macOS Installer

Builds the Electron app for macOS and generates SHA256 checksums.

```yaml
package-mac:
  needs: [verify]
  runs-on: macos-latest
  steps:
    - uses: actions/checkout@v4
    - name: Build macOS package
      run: cd packaging/electron && npm run dist
    - name: Generate checksum
      run: |
        cd dist/
        shasum -a 256 Vision-*.zip > Vision-*.zip.sha256
        cat Vision-*.zip.sha256
    - name: Upload artifacts
      uses: softprops/action-gh-release@v1
      with:
        files: |
          dist/Vision-*.zip
          dist/Vision-*.zip.sha256
```

**Steps:**

1. **Build:** `cd packaging/electron && npm run dist`
   - Runs electron-builder in distribution mode
   - Outputs `Vision-x.y.z-arm64.dmg` and `Vision-x.y.z-arm64-mac.zip`

2. **Checksum:** `shasum -a 256 Vision-*.zip > Vision-*.zip.sha256`
   - Computes SHA256 hash of the ZIP file
   - Format: `<hash> *<filename>` (standard sha256sum format)
   - Example: `a1b2c3d4e5f6... *Vision-1.2.3-arm64-mac.zip`

3. **Upload:** Both `.zip` and `.sha256` attached to the GitHub Release
   - Enables checksum verification in update system
   - See [[docs/adr/023-update-installer-checksum-verification|ADR-023]] for verification logic

**Artifacts:**
- `Vision-x.y.z-arm64-mac.zip` — Installer ZIP
- `Vision-x.y.z-arm64-mac.zip.sha256` — SHA256 checksum
- `Vision-x.y.z-arm64.dmg` — Native macOS installer
- `vision-source-launcher-x.y.z-arm64.zip` (+ `.sha256`) — source tree (`unsigned/Vision/`)
  plus `unsigned/launch.command`, consumed by the in-app shell updater in source/repo
  mode. Layout is fixed by `packaging/electron/updater.js`; the build step asserts it.

**Failure:** Indicates macOS build or signing issue; must fix before re-releasing.

#### 4. **release** — Finalize GitHub Release

Creates or updates the GitHub Release page with all published artifacts.

```yaml
release:
  needs: [docker, package-mac]
  runs-on: ubuntu-latest
  steps:
    - name: Create release
      uses: softprops/action-gh-release@v1
      with:
        draft: false
        prerelease: false
```

**Result:**
- Release page published at `https://github.com/erapartner/vision/releases/tag/v1.2.3`
- Contains all artifacts (Docker image reference, `.zip`, `.sha256`)
- Announces availability to users and integrators

---

## Update System Integration

### Shell Installer Updates (Source Mode)

When a user runs Vision in **source mode** with `--useRepoMode`:

1. Check release API → fetches latest from GitHub
2. User clicks "Update & Restart"
3. **Backup** → snapshot to `userData/pre-update-backups/`
4. **Download** → fetch `vision-x.y.z-arm64-mac.zip` + `vision-x.y.z-arm64-mac.zip.sha256`
5. **Verify** → compute SHA256, compare against sibling `.sha256` file
6. **Extract** → run `install.sh` with `--dest-root` and `--backup-dir` flags
7. **Restart** → app restarts with new version

See [[docs/features/application-updates|Application Updates Feature]] for details.

### Docker Image Updates (Docker Mode)

When a user runs Vision in **docker mode**:

1. Check release API → fetches latest from GitHub
2. User clicks "Update & Restart"
3. **Backup** → snapshot to `userData/pre-update-backups/`
4. **Pull** → `docker-compose pull` fetches `ghcr.io/erapartner/vision:v1.2.3` from GHCR
5. **Restart** → `docker-compose up -d` starts container with new image
6. **Health poll** → verify backend is live
7. **Reload** → frontend reconnects to backend

---

## Monitoring & Alerts

### GitHub Actions Dashboard

Monitor workflow runs at: `https://github.com/erapartner/vision/actions`

**Status checks:**
- Green checkmark (✓) — All jobs passed
- Red X (✗) — One or more jobs failed
- Yellow (◐) — Job in progress

### Common Failure Causes

| Failure | Cause | Fix |
|---------|-------|-----|
| Lint fails | Code style violation | Run `bun run lint --fix` locally, commit |
| Typecheck fails | Type mismatch | Fix TypeScript errors, ensure all imports typed |
| Test fails | Logic bug or test issue | Run `bun run test` locally, debug and fix |
| Docker verify fails | Backend startup issue | Check logs, verify Dockerfile, test locally |
| Security scan flagged | Known CVE in dependency | Update vulnerable package, test, re-release |
| Version tag mismatch | Forgot to update `packaging/electron/package.json` | Ensure tag matches package version, re-tag |

### Re-Running Failed Workflows

If a workflow job fails:

1. Fix the underlying issue (code, config, dependency)
2. Commit and push the fix
3. For release workflows: delete the release tag and re-push the tag after fixing

```bash
git tag -d v1.2.3          # Delete local tag
git push origin :refs/tags/v1.2.3  # Delete remote tag
git tag v1.2.3             # Re-create tag
git push origin v1.2.3     # Push again (triggers release workflow)
```

---

## Secrets & Permissions

### Required GitHub Secrets

(Configure in repository settings → Secrets and variables → Actions)

| Secret | Purpose | Example |
|--------|---------|---------|
| (None required) | All credentials use GitHub's built-in token | `${{ secrets.GITHUB_TOKEN }}` |

### GHCR Authentication

Docker push to GHCR uses the repository's built-in `GITHUB_TOKEN`, automatically scoped to the current repository.

### Permissions

Workflow files use minimal required permissions:

```yaml
permissions:
  contents: read
  security-events: write  # For security scan SARIF upload
```

---

## Best Practices

### 1. Always Update Both Version Sources

Before tagging a release, ensure **both** sources are in sync:

```bash
# Check package.json version
jq '.version' packaging/electron/package.json

# Should match your intended tag (without 'v')
# e.g., if tagging v1.2.3, package.json should have "version": "1.2.3"
```

### 2. Test Locally Before Publishing

Run all checks locally before pushing a tag:

```bash
bun run lint       # Code style
bun run typecheck  # Type checking
bun run test       # Unit tests
docker build .     # Docker build
```

### 3. Review Release Notes

After the release job completes, verify the GitHub Release page:
- Check that all artifacts are attached
- Confirm `.sha256` file is present (for shell installer verification)
- Add human-readable release notes (optional but recommended)

### 4. Monitor Docker Image Health

After pushing a Docker image, verify it can start:

```bash
docker pull ghcr.io/erapartner/vision:v1.2.3
docker run -p 3002:3002 ghcr.io/erapartner/vision:v1.2.3
curl http://localhost:3002/health
```

---

## Related Documentation

- [[docs/features/application-updates|Application Updates Feature]] — Update modes and user-facing UI
- [[docs/adr/023-update-installer-checksum-verification|ADR-023: Installer Checksum Verification]] — Checksum strategy
- [[docs/guides/deployment|Deployment Guide]] — Production deployment options
- [[docs/guides/testing|Testing Guide]] — Test structure and coverage requirements
