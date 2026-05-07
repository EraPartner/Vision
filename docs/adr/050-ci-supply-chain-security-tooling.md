---
title: "CI Supply Chain Security Tooling (2026-05-07)"
type: adr
status: Accepted
date: 2026-05-07
tags: [security, ci-cd, gitleaks, secrets-scanning, supply-chain, dependency-audit, trivy, container-scanning, electron-csp, permission-handler]
description: Comprehensive supply chain security hardening via CI jobs (secrets-scan, deps-audit, trivy-scan), pre-commit gitleaks protection, dependency version overrides, and Electron CSP enforcement
aliases: [ci security tooling may 2026, supply chain security, gitleaks pre-commit]
related_code: [".github/workflows/ci.yml", ".gitleaks.toml", ".githooks/pre-commit", "packaging/electron/main.js", "packaging/electron/assets/error.html", "packaging/electron/assets/error.css", "packaging/electron/assets/error.js", "package.json"]
---

# ADR-050: CI Supply Chain Security Tooling (2026-05-07)

## Status

Accepted

## Date

2026-05-07

## Context

Vision ships as a desktop Electron application with embedded Docker stack, requiring defense-in-depth across four vectors:

1. **Secrets in version control** — credentials, API keys, passphrases must never reach git history
2. **Dependency vulnerabilities** — npm/bun packages may harbor HIGH/CRITICAL CVEs
3. **Container image vulnerabilities** — upstream packages in Dockerfile may contain OS-level CVEs
4. **Renderer process hardening** — Electron permission requests and inline styles bypass CSP isolation

Previous mitigations (ADR-042, ADR-039) addressed code-level security. This decision adds _preventive automation_ to catch issues before merge.

## Decision

Implement four-layer supply chain security in CI and pre-commit phases:

### 1. Secrets Scanning (CI Job: `secrets-scan`)

**Tool:** gitleaks/gitleaks-action v2 (GitHub Actions)

**Trigger:** Every push to `main`, every PR

**Scope:** Full git history (fetch-depth: 0)

**Implementation:**
```yaml
secrets-scan:
  runs-on: ubuntu-latest
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - uses: gitleaks/gitleaks-action@v2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Config:** `.gitleaks.toml` allowlists:
- Obsidian local plugin artifacts (`.obsidian/`)
- Documentation placeholder tokens (`YOUR_TOKEN`, `replace-with-`)
- Auto-generated config (`opencode.json`)

**Policy:**
- Detects hardcoded API keys, AWS credentials, GitHub tokens, private keys
- Scans entire history on PR; detects old secrets accidentally committed
- CI blocks merge if secrets found (exit code 1)

**Rationale:** Secret detection is cheapest at commit time; blocks leaks before reaching CI infrastructure.

### 2. Dependency Vulnerability Audit (CI Job: `deps-audit`)

**Tool:** `bun audit --audit-level=high`

**Trigger:** Every push to `main`, every PR

**Implementation:**
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

**Policy:**
- Fails if any package has HIGH or CRITICAL severity vulnerability
- Blocks merge; forces dependency bump before inclusion
- Scopes audit to production dependencies (dev deps permitted to have lower-severity vulns)

**Dependency Overrides (root `package.json`):**
- `basic-ftp: 5.3.1` (HIGH CVE in 5.3.0 — race condition)
- `ip-address: ^10.1.1` (CRITICAL CVE in <10.1.1)
- `postcss: >=8.5.10` (HIGH parsing vulnerability in <8.5.10)

**Rationale:** Transitive dependencies are invisible unless explicitly audited; `bun audit` prevents dependency-injection attacks and supply-chain compromises.

### 3. Container Image Scanning (CI Job: `trivy-scan`)

**Tool:** aquasecurity/trivy-action (GitHub Actions)

**Trigger:** Every push to `main`, every PR

**Implementation:**
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

**Policy:**
- Builds Docker image as part of CI (same build as production release)
- Scans all OS packages, system libraries, and layered binaries
- Reports only HIGH/CRITICAL severity (medium and below ignored)
- Blocks merge on any finding; forces base-image upgrade or package patch
- `exit-code: '1'` causes workflow failure (blocks merge)

**Rationale:** Docker images contain upstream OS packages (Ubuntu base) that may have unpatched CVEs. Scanning catches issues before shipment to users.

### 4. Pre-Commit Secrets Hook (Local + CI)

**Tool:** gitleaks CLI (local machine + CI fallback)

**Config:** `.githooks/pre-commit`

**Implementation:**
```bash
#!/usr/bin/env sh
# Scan staged changes for secrets before committing.
if ! command -v gitleaks > /dev/null 2>&1; then
  echo "[gitleaks] not found — skipping pre-commit scan."
  echo "[gitleaks] Install: brew install gitleaks"
  exit 0
fi

gitleaks protect --staged --config .gitleaks.toml -v
```

**Setup (developer responsibility):**
```bash
git config core.hooksPath .githooks
```

**Policy:**
- Runs before every `git commit`
- Scans only staged changes (quick, no full-history scan)
- Uses same `.gitleaks.toml` config as CI
- Graceful degradation: if gitleaks not installed, skips with warning
- Developer can install: `brew install gitleaks`

**Rationale:** Local hooks prevent secrets reaching remote CI; fails fast at keyboard time with immediate feedback.

---

### 5. Electron Permission Hardening (Renderer Isolation)

**File:** `packaging/electron/main.js`

**Change:** Added permission request handler in `registerSecurityHeaders()`
```javascript
session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
  callback(false);
});
```

**Scope:** Denies ALL permission requests from renderer process:
- `camera` — blocked
- `microphone` — blocked
- `geolocation` — blocked
- `notifications` — blocked
- `clipboard-read` / `clipboard-write` — blocked
- Custom permissions via IPC — blocked

**Policy:**
- Renderer JavaScript cannot escalate to system resources
- If feature requires permission (e.g., notifications), use explicit IPC with user confirmation in main process
- Whitelist on a per-feature basis (e.g., `ipcMain.on('request-notification', ...)`)

**Rationale:** Defense-in-depth; even if renderer is compromised (XSS), attacker cannot access camera, location, or clipboard.

---

### 6. Electron CSP Enforcement (error.html Cleanup)

**File:** `packaging/electron/assets/error.html`

**Change:** Removed `style-src 'unsafe-inline'` from CSP meta tag

**Before:**
```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" />
<style>/* inline styles */</style>
<script>/* inline code */</script>
```

**After:**
```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; style-src 'self'; script-src 'self'" />
<link rel="stylesheet" href="error.css" />
<script src="error.js"></script>
```

**Files Created/Modified:**
- `packaging/electron/assets/error.css` — extracted inline styles
- `packaging/electron/assets/error.js` — extracted inline scripts

**Policy:**
- No inline styles; all styles in `error.css`
- No inline scripts; all logic in `error.js`
- CSP enforced in renderer context

**Rationale:** Inline styles and scripts are vectors for style injection (CSS exfiltration of secrets via background-image URLs) and script injection. Externalized assets are cacheable, auditable, and enable strict CSP.

---

## Consequences

### Positive

- **Secrets never reach CI:** Local pre-commit hook + CI secrets-scan create defense-in-depth; developer gets immediate feedback before pushing
- **Dependency vulns caught early:** `bun audit` prevents transitive CVEs from shipping; forced to patch or override responsibly
- **Container image CVEs blocked:** Trivy scan ensures OS packages are patched; no unpatched base images shipped to users
- **Renderer cannot escalate:** Permission handler denies all browser-like capabilities; XSS in renderer cannot access camera/location/clipboard
- **Strict CSP in error recovery:** error.html cannot be exploited for style/script injection; hard-coded HTML path is safe from traversal
- **CI workflow provides auditability:** Security tooling is visible, repeatable, and logged in Actions; incidents are traceable

### Negative

- **Local setup friction:** Developers must install gitleaks (`brew install gitleaks`) and run `git config core.hooksPath .githooks` after cloning
- **CI latency:** Trivy scan and deps-audit add ~2-3 minutes to CI runtime per workflow run
- **False positives:** gitleaks may flag legitimate patterns (mitigated via `.gitleaks.toml` allowlist); requires maintenance as codebase grows
- **Permission denial impact:** If future feature needs permission (e.g., notifications), developer must implement IPC bridge instead of relying on Electron's built-in permission flow
- **Dependency override maintenance:** `basic-ftp`, `ip-address`, `postcss` versions pinned; must monitor upstream for newer patches that close the same CVE

### Neutral

- Release workflow (`release.yml`) unchanged; existing CI still runs before release verification
- Docker build now cached in GHA (via `cache-from`/`cache-to`); subsequent Trivy scans faster
- ADR-042 (CodeQL + Dependabot) and ADR-039 (Container Hardening) remain; this ADR extends with _automated enforcement_

---

## Implementation Notes

### Pre-Commit Hook Degradation

If a developer doesn't have gitleaks installed:
```
[gitleaks] not found — skipping pre-commit scan.
[gitleaks] Install: brew install gitleaks
```

Commit proceeds; CI `secrets-scan` job will catch any leaks. This graceful degradation prioritizes developer velocity over strict local enforcement.

### CI Job Failure Recovery

If CI job fails (e.g., Trivy finds CVE):
1. Developer must fix root cause (bump dependency, update base image, etc.)
2. Commit and push again
3. CI re-runs automatically on new commit

No special re-run required; GitHub Actions automatically re-triggers on new pushes.

### Electron Features Requiring Permissions

Future features that legitimately need system access should:
1. Implement permission request via IPC in main process (not renderer)
2. Show user confirmation dialog in main process (native, not web)
3. Example: `ipcMain.on('request-notification', (event, msg) => { mainWindow.webContents.send('notification', msg); })`

See [[docs/security/data-protection|Data Protection & CSP]] for updated patterns.

---

## Related

- [[docs/guides/cicd-pipelines|CI/CD Pipelines Guide]] — Workflow documentation, job descriptions, troubleshooting
- [[docs/adr/042-codeql-dependabot-remediation-2026-04|ADR-042: CodeQL + Dependabot Remediation]] — Code-level security fixes (rate limiting, input validation, CORS)
- [[docs/adr/039-docker-container-hardening|ADR-039: Docker Container Hardening]] — Container runtime hardening (non-root user, capabilities, read-only fs)
- [[docs/security/data-protection|Data Protection & CSP]] — Content Security Policy, CORS, path traversal prevention
- [[docs/security/index|Security Documentation Index]]
