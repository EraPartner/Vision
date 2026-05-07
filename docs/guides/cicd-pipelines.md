---
title: CI/CD Pipelines
type: guide
status: active
date: 2026-04-28
updated: 2026-05-07
tags: [guide, cicd, github-actions, testing, linting, docker, release, packaging, automation, april-2026, may-2026, security, secrets-scan, deps-audit, trivy-scan, quality-gate, verify-compose-sync, ci-complete, live-api-contracts, branch-protection]
description: GitHub Actions CI/CD pipelines including continuous integration checks, supply chain security scanning (secrets, dependencies, container images), quality gates, Docker Compose sync verification, and release automation with checksums
aliases: [github-actions, ci-cd, pipelines, release-workflow, testing-automation, security-scanning, quality-gates, branch-protection]
related_code: [".github/workflows/ci.yml", ".github/workflows/release.yml", ".gitleaks.toml", ".githooks/pre-commit", "packaging/electron/main.js", "packaging/electron/assets/error.html", "packaging/electron/resources/docker-compose.yml", "docker-compose.yml"]
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

**Config:** `.gitleaks.toml` allowlists documentation placeholders and Obsidian plugin artifacts

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

#### 2. **trivy-scan** — Container Image CVE Scan

Scans the Docker image for operating system and system library vulnerabilities.

```yaml
trivy-scan:
  runs-on: ubuntu-latest
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@v4
    - uses: docker/setup-buildx-action@v3
    - uses: docker/build-push-action@v6
      with:
        context: .
        load: true
        tags: vision:ci
        cache-from: type=gha
        cache-to: type=gha,mode=max
    - uses: aquasecurity/trivy-action@master
      with:
        image-ref: vision:ci
        format: table
        severity: HIGH,CRITICAL
        exit-code: '1'
```

**What it scans:**
- Base image OS packages (Ubuntu)
- System libraries (glibc, curl, ssl)
- Layered packages from Dockerfile
- Reports HIGH and CRITICAL severity only

**Policy:**
- Scans actual release image (same as pushed to GHCR)
- Blocks merge if vulnerabilities found
- Requires base-image upgrade or package patch before shipping

**Example failure reason:**
```
HIGH: CVE-2024-XXXXX (openssl)
  Fix available: Install openssl 3.2.1+
```

**Mitigation:** Update `FROM ubuntu:X.Y` in Dockerfile or add package update step

**Related:** [[docs/adr/039-docker-container-hardening|ADR-039 Container Hardening]], [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050 CI Security Tooling]]

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

**Related:** [[docs/adr/046-named-volumes-attachment-wipe-bug|ADR-046]] (v1.0.2 attachments bug analysis + fix)

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

#### 2. **typecheck** — TypeScript Validation

Checks TypeScript types without emitting code.

```yaml
typecheck:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: TypeScript check
      run: bun run typecheck
```

**What it checks:**
- Type mismatches in frontend (React, Electron, API client)
- Type mismatches in backend (Express routes, services)
- Missing or incorrect type annotations

**Failure:** Blocks further checks; must be resolved before merging.

#### 3. **test-frontend** — Frontend Unit Tests

Runs Vitest on frontend components, hooks, and utilities.

```yaml
test-frontend:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Vitest
      run: bun run test:frontend
```

**What it tests:**
- React component rendering
- Custom hooks logic
- Utility functions
- API client behavior

**Coverage target:** 80% minimum (see [[docs/guides/testing|Testing Guide]] for strategies)

**Failure:** Must achieve 80%+ coverage; may merge with lower coverage if justified in PR description.

#### 4. **test-backend** — Backend Unit & Integration Tests

Runs Bun test on backend services, repositories, and routes.

```yaml
test-backend:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Bun test
      run: bun run test:backend
```

**What it tests:**
- Service layer logic (transactions, categories, portfolio)
- Repository data access
- Express route handlers
- Middleware and error handling

**Coverage target:** 80% minimum

**Failure:** Must achieve 80%+ coverage or justify in PR.

#### 5. **docker-verify** — Container Health Check

Builds the Docker image and verifies the backend starts successfully.

```yaml
docker-verify:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Build image
      run: docker build -t vision:test .
    - name: Start compose
      run: |
        docker-compose -f docker-compose.yml up -d
        sleep 5
    - name: Poll health
      run: |
        for i in {1..30}; do
          if curl -f http://localhost:3002/health; then
            echo "✓ Backend health check passed"
            exit 0
          fi
          sleep 2
        done
        echo "✗ Backend health check failed"
        exit 1
```

**What it verifies:**
- Docker image builds without errors
- PostgreSQL database starts
- Backend service boots and responds to health check
- All services are reachable on expected ports

**Failure:** Indicates a runtime issue; must be resolved before merging.

#### 6. **test-live-api-contracts** — Live API Contract Tests

Validates that MSW (Mock Service Worker) fixture schemas match actual backend responses. Catches divergence between frontend test stubs and production API contracts.

```yaml
test-live-api-contracts:
  name: Test (Live API Contracts)
  needs: [build-image]
  if: ${{ !github.event.pull_request.draft }}
  steps:
    - uses: actions/checkout@v4
    - name: Download image artifact
      uses: actions/download-artifact@v4
    - name: Load Docker image
      run: docker load < /tmp/vision-ci.tar
    - name: Start services with Docker Compose
      run: docker compose -f docker-compose.yml up -d
    - name: Run live API contract tests
      run: cd apps/frontend && bun run vitest run src/test/live-contracts/live-contracts.test.ts
```

**What it tests:**
- Frontend MSW fixtures against real backend responses
- All API endpoint contracts (GET, POST, PUT, DELETE)
- Response shape, status codes, and error handling
- Identifies when backend contracts change without updating test stubs

**Policy:** Blocks merge if fixtures diverge from reality. Runs only on non-draft PRs to avoid CI spam.

**Failure:** Indicates API contract mismatch; either update backend or update frontend fixtures accordingly.

#### 7. **test-e2e-visual** — Visual Regression (Main Pushes Only)

Captures and compares full-page screenshots of critical pages. Runs **only on push to main**, never on PRs.

```yaml
test-e2e-visual:
  name: Test (Visual)
  runs-on: ubuntu-latest
  if: github.event_name == 'push'
  steps:
    - uses: actions/checkout@v4
    - name: Build Docker image
      # ... (same Docker Compose setup as test-e2e) ...
    - name: Capture visual baselines
      run: cd apps/frontend && bun run test:e2e:visual
      continue-on-error: true  # Visual failures don't block merge
      env:
        CI: true
        PLAYWRIGHT_BASE_URL: http://localhost:3002
    - name: Upload visual snapshots
      uses: actions/upload-artifact@v4
      if: always()
      with:
        name: visual-snapshots
        path: apps/frontend/e2e/__screenshots__/
        retention-days: 30
```

**Rationale for `continue-on-error`:**
- Visual regression tests check for unintended style changes but are inherently environment-dependent (OS rendering, font rasterization, timing)
- Failures often stem from transient factors (browser timing, network latency affecting paint) rather than true bugs
- Tagged with `continue-on-error: true` to allow the merge while still capturing visual artifacts for human review
- Snapshots are automatically updated on main pushes, establishing the visual baseline for subsequent PR comparisons

#### 8. **security-scan** — Vulnerability Scanning

Uses Trivy to scan the codebase and dependencies for known vulnerabilities.

```yaml
security-scan:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Trivy scan
      uses: aquasecurity/trivy-action@master
      with:
        scan-type: 'fs'
        scan-ref: '.'
        format: 'sarif'
        output: 'trivy-results.sarif'
    - name: Upload to GitHub Security
      uses: github/codeql-action/upload-sarif@v2
      with:
        sarif_file: 'trivy-results.sarif'
```

**What it scans:**
- Frontend dependencies (npm packages in `package.json`)
- Backend dependencies (Bun packages)
- System packages in Dockerfile
- Known CVEs in third-party libraries

**Results:** Uploaded to GitHub Security tab for visibility. High-severity vulns should be patched immediately.

---

#### 9. **quality-gate** — Pre-Docker Quality Checkpoint

Aggregates all pre-Docker quality checks to prevent wasting expensive Docker build cycles on broken commits.

```yaml
quality-gate:
  needs:
    - secrets-scan
    - deps-audit
    - pip-audit
    - lint
    - typecheck
    - build-frontend
    - test-frontend
    - test-backend
    - verify-compose-sync
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
- All nine prerequisite jobs must pass
- Runs regardless of individual failures (`if: always()`) but fails if any needed job failed
- Blocks expensive Docker image build until quality gates are green

**Failure:** Indicates an error in earlier stage; must be fixed in that stage before Docker build runs.

**Design:** Gating expensive Docker build after cheap linting/testing prevents CI resource waste on broken code.

#### 10. **ci-complete** — Docker-Tier Aggregation

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
