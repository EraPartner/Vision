---
title: Application Updates
type: feature
status: active
date: 2026-04-28
updated: 2026-08-26
tags: [feature, updates, electron, deployment, docker, shell-update, backup, rollback, checksums, supply-chain-security, devops, phase-9]
description: Application update system supporting three deployment modes (dev, source, docker) with backup-before-update pattern, shell script rollback, and cryptographic verification
aliases: [auto-update, update flow, deployment modes, shell installer, docker pull, backup, update lifecycle]
related_code:
  - packaging/electron/main.js
  - packaging/electron/preload.js
  - apps/frontend/src/lib/api/electron.ts
  - apps/frontend/src/components/notifications/UpdateNotification.tsx
  - apps/frontend/src/features/settings/sections/AboutSection.tsx
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
---

# Application Updates

## Overview

Vision supports three **deployment modes**, each with a corresponding update path:

| Mode | Environment | Update Method | Trigger |
|------|-------------|---------------|---------|
| **dev** | Local development (`app.isPackaged === false`, `useRepoMode === false`) | None — code changes via Git/file watcher | File system rebuild |
| **source** | Packaged app in repository mode (`useRepoMode === true`) | Shell script installer from GitHub releases | IPC handler `update:install-shell` |
| **docker** | Packaged or containerized app (default production) | `docker-compose pull` → `docker-compose up -d` | IPC handler via Docker API |

The update system prioritizes **data safety** through a **backup-before-update** pattern: all updates begin with a full snapshot of the user's data directory, enabling rollback if the update fails.

---

## Architecture

### Deployment Modes

#### 1. Dev Mode (`'dev'`)

- **Condition:** `app.isPackaged === false && !useRepoMode`
- **Trigger:** File watcher on `apps/`, `alembic/`, `apps/frontend/src/`
- **Flow:** 
  1. Source files change
  2. File watcher detects change, kills in-flight build with SIGTERM
  3. Queues new Docker rebuild
  4. Docker image rebuilt from current source
  5. Container restarts with new code
- **No manual update UI needed.** Changes applied transparently.

#### 2. Source Mode (`'source'`)

- **Condition:** `app.isPackaged === true && useRepoMode === true`
- **Use case:** Developers using packaged Electron app but wanting shell-script-based updates
- **Trigger:** User clicks "Check for Updates" → `GET /api/admin/release/latest`
- **Update artifacts:** 
  - Installer shell script (bash) with rsync, xattr strip, checksum verification
  - Sibling `.sha256` checksum file on GitHub releases
- **Flow:**
  1. Check for new release on GitHub
  2. If available, prompt user to update
  3. User clicks "Update & Restart"
  4. **Backup phase:** Call `preUpdateBackup()` → snapshot `userData/` to `userData/pre-update-backups/`
  5. **Download phase:** Fetch release ZIP + `.sha256` checksum
  6. **Verify phase:** Compute SHA256, compare against `.sha256` asset; abort if mismatch (hardened behavior)
  7. **Extract & Install phase:** Extract installer script, execute with `--dest-root <install-path> --backup-dir <temp-backup>`
  8. **Restart:** App restarts with new version
- **Rollback on failure:** If extract or install fails, `--backup-dir` points to pre-installation snapshot; user prompted to manually restore from `userData/pre-update-backups/`

#### 3. Docker Mode (`'docker'`)

- **Condition:** `app.isPackaged === true || embedded docker-compose (default)`
- **Use case:** Production Electron or Docker container deployment
- **Trigger:** User clicks "Check for Updates" → `GET /api/admin/release/latest`
- **Update artifacts:** 
  - Docker image published to `ghcr.io/erapartner/vision:<tag>` (GitHub Container Registry)
  - Image pre-pulled during Electron startup if missing (Phase 0, 2026-04-27)
- **Flow:**
  1. Check for new release via `GET /api/admin/release/latest`
  2. If available, prompt user to update
  3. User clicks "Update & Restart"
  4. **Backup phase:** Call `preUpdateBackup()` → snapshot `userData/` to `userData/pre-update-backups/`
  5. **Pull phase:** Docker `compose pull` to fetch latest image
  6. **Restart phase:** Docker `compose up -d` with new image
  7. Health poll waits for backend to boot, then reload frontend
- **Rollback on failure:** If backend fails to boot, previous image still exists in Docker; manual `docker-compose up -d` with explicit image tag reverts

---

## IPC Handlers (Electron Main Process)

All updates use IPC to communicate between Renderer (React) and Main process:

| Handler | Signature | Purpose | Modes |
|---------|-----------|---------|-------|
| `update:get-mode` | `() → Promise<'dev' \| 'source' \| 'docker'>` | Return deployment mode | All |
| `update:pre-update-backup` | `() → Promise<{ path: string, timestamp: string }>` | Create snapshot before update | source, docker |
| `update:install-shell` | `(opts) → Promise<{ success: bool, version: string }>` | Download, verify, extract, install shell update | source only |
| `update:check-release` | `() → Promise<{ available: bool, version: string, update_mode: UpdateMode }>` | Check for new release on GitHub | source, docker |

### `getUpdateMode()`

```typescript
function getUpdateMode(): 'dev' | 'source' | 'docker' {
  if (!app.isPackaged) return 'dev';
  if (useRepoMode) return 'source';
  return 'docker'; // default
}
```

Returns the active deployment mode based on `app.isPackaged` and `useRepoMode` environment variable.

### `preUpdateBackup()`

```typescript
async function preUpdateBackup() {
  const backupDir = path.join(app.getPath('userData'), 'pre-update-backups');
  const timestamp = new Date().toISOString();
  const snapshotPath = path.join(backupDir, `backup-${timestamp}`);
  
  // Create directory structure
  await fs.promises.mkdir(snapshotPath, { recursive: true });
  
  // Copy entire userData except node_modules and cache
  await runBundleBackup(app.getPath('userData'), snapshotPath, {
    excludePatterns: ['node_modules', '.cache', 'pre-update-backups']
  });
  
  return { path: snapshotPath, timestamp };
}
```

Creates a timestamped snapshot of `userData/` (excluding caches and previous backups). Returns path and timestamp for UI feedback.

---

## Release Process (CI/CD)

### GitHub Actions Workflow: `release.yml`

The release workflow now generates and attaches checksums alongside release artifacts:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  verify:
    # First job: block all subsequent jobs if checks fail
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Verify version tag
        run: |
          VERSION_TAG=${GITHUB_REF#refs/tags/v}
          PKG_VERSION=$(jq -r '.version' packaging/electron/package.json)
          if [[ "$VERSION_TAG" != "$PKG_VERSION" ]]; then
            echo "Tag mismatch: $VERSION_TAG vs $PKG_VERSION"
            exit 1
          fi
      - name: Lint
        run: bun run lint
      - name: Type check
        run: bun run typecheck
      - name: Test
        run: bun run test

  docker:
    needs: [verify]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build and push Docker image
        run: |
          docker build -t ghcr.io/erapartner/vision:${{ github.ref_name }} .
          docker push ghcr.io/erapartner/vision:${{ github.ref_name }}

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

**Key points:**
1. `verify` job runs first; all other jobs have `needs: [verify]` to block if checks fail
2. `package-mac` job generates `.sha256` checksum after building the ZIP
3. Both `*.zip` and `*.zip.sha256` uploaded as release assets
4. `docker` job builds and pushes image with release tag

### GitHub Actions Workflow: `ci.yml`

Continuous integration on every commit:

```yaml
name: CI

on:
  push:
    branches: [main, develop]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: ESLint (frontend + backend)
        run: bun run lint

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: TypeScript check
        run: bun run typecheck

  test-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Vitest
        run: bun run test:frontend

  test-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Bun test
        run: bun run test:backend

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

---

## Frontend Update UI

### UpdateNotification Component

Located at `apps/frontend/src/components/notifications/UpdateNotification.tsx`.

**Phase transitions:**
1. **idle** — No update available, or update dismissed
2. **backing-up** — Snapshot in progress (shows "Backing up your data…")
3. **downloading** — Fetching installer or pulling Docker image (shows "Downloading…")
4. **pulling** (Docker only) — `docker-compose pull` in progress (shows "Pulling Docker image…")
5. **restarting** — App restart initiated (shows "Restarting…")
6. **done** — Update complete, app restarted

**Flow:**
```typescript
async function installUpdate() {
  try {
    setPhase('backing-up');
    await window.electronUpdater?.preUpdateBackup?.();
    
    setPhase('downloading'); // or 'pulling' based on status.update_mode
    
    if (status.update_mode === 'docker') {
      await dockerPull(status.version);
      setPhase('pulling');
      await dockerUp();
    } else if (status.update_mode === 'source') {
      await window.electronUpdater?.installShell?.(status.version);
    }
    
    setPhase('restarting');
    await app.relaunch();
  } catch (err) {
    showError(t('update.failed'), err.message);
    setPhase('idle');
  }
}
```

### AppTab Component

Settings → App tab shows update mode and manual update trigger:

```typescript
export function AppTab() {
  const [mode, setMode] = useState<UpdateMode>('dev');
  
  useEffect(() => {
    window.electronUpdater?.getMode?.().then(setMode);
  }, []);
  
  return (
    <div>
      <h3>Update Mode: {mode}</h3>
      <button onClick={checkForUpdates}>Check for Updates</button>
    </div>
  );
}
```

---

## Checkpoint: Backup & Restore

### Pre-Update Backup Directory

Location: `userData/pre-update-backups/backup-{timestamp}/`

Structure:
```
pre-update-backups/
├── backup-2026-04-28T12:34:56Z/
│   ├── db/
│   │   ├── vision.sqlite
│   │   └── (or PostgreSQL data if embedded)
│   ├── settings.json
│   ├── locales/
│   └── (all other userData content)
└── backup-2026-04-28T13:45:00Z/
    └── (earlier snapshot)
```

### Manual Rollback

If an update fails:

1. **Locate backup:** Find most recent backup in `userData/pre-update-backups/`
2. **Stop app:** Close Vision
3. **Restore:** `cp -r userData/pre-update-backups/backup-{timestamp}/* userData/`
4. **Restart:** Reopen Vision

For automated rollback in shell-update mode, the installer script is passed `--backup-dir {tmpdir}` and will restore from that location if extraction fails.

---

## Security Considerations

### Checksum Verification (ADR-023)

When downloading shell installers from GitHub releases, the update system verifies SHA256 checksums:

1. **Fetch sibling `.sha256` file** from GitHub release
2. **Compute SHA256** of downloaded ZIP
3. **Compare:** If mismatch, delete file and abort update
4. **Hard-abort on parse error:** If `.sha256` exists but is malformed, abort (no fallback)

**Behavior:**
- `.sha256` present and matches → proceed
- `.sha256` present and mismatches → abort (security event)
- `.sha256` parse error (empty, corrupted) → abort (security event)
- `.sha256` absent → log warning, best-effort proceed (backward compatibility for older releases)

See [[docs/adr/023-update-installer-checksum-verification|ADR-023]] for full context.

### Backup Encryption (Phase 1+2)

Pre-update backups are encrypted via the bundle backup system. See [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040]] for encryption algorithm and key derivation.

### Docker Image Integrity

Docker images are verified by Docker daemon (signature verification on pull from GHCR). No additional checksum layer needed.

---

## Deployment Mode Selection

### Configuration

Update mode is determined at **runtime** by:

```typescript
function getUpdateMode(): 'dev' | 'source' | 'docker' {
  if (!app.isPackaged) return 'dev';
  if (process.env.USE_REPO_MODE === 'true') return 'source';
  return 'docker';
}
```

| Scenario | `app.isPackaged` | `USE_REPO_MODE` | Result |
|----------|-----------------|-----------------|--------|
| Development via `bun run electron:dev` | false | (ignored) | `'dev'` |
| Packaged app, with `--useRepoMode` flag | true | `'true'` | `'source'` |
| Packaged app, standard | true | (undefined) | `'docker'` |
| Docker container (backend only) | (N/A) | (N/A) | `'docker'` (via Docker Compose restart) |

---

## Logging & Observability

All update operations log to `app.getPath('logs')`:

```
[2026-04-28T12:34:56] [Update] Checking for new release...
[2026-04-28T12:34:57] [Update] Available: v1.2.3
[2026-04-28T12:35:00] [Backup] Snapshot starting: userData/ → pre-update-backups/backup-2026-04-28T12:34:56Z
[2026-04-28T12:35:10] [Backup] Snapshot complete: 245 MB
[2026-04-28T12:35:20] [Installer] Downloading: https://github.com/.../releases/download/v1.2.3/Vision-1.2.3.zip
[2026-04-28T12:35:45] [Installer] Fetching checksum: .sha256
[2026-04-28T12:35:46] [Installer] SHA256 verified: a1b2c3d4e5f6...
[2026-04-28T12:35:50] [Installer] Extract & run: /path/to/install.sh
[2026-04-28T12:36:00] [Update] Installation complete, restarting...
```

---

## Related Documentation

- [[docs/adr/023-update-installer-checksum-verification|ADR-023: Installer Checksum Verification]] — Checksum strategy
- [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040: Backup Format v2 (AEAD Encryption)]] — Backup encryption
- [[docs/architecture/electron|Electron Desktop Architecture]] — Process model and startup sequence
- [[docs/features/settings|Settings Feature]] — App settings including update preferences
