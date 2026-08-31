---
title: Deployment Guide
type: guide
status: active
date: 2026-08-31
updated: 2026-08-31
tags:
  [
    guide,
    deployment,
    production,
    native-runtime,
    postgresql,
    docker,
    electron,
    phase-1,
    security,
    admin-auth,
    port-binding,
    container-hardening,
    packaging,
    bun,
    troubleshooting,
  ]
description: Native macOS, optional Docker Compose, and custom production deployment with secure port binding and admin endpoints
aliases:
  [deployment-guide, production-deploy, docker-deploy, electron-packaging]
related_code: [[docker-compose.yml]]
---

# Deployment Guide

This guide covers deploying Vision in production environments.

## Deployment Options

Vision supports multiple deployment methods:

| Method          | Use Case                                       | Complexity |
| --------------- | ---------------------------------------------- | ---------- |
| Native Electron | Normal macOS desktop use with PostgreSQL 18    | Low        |
| Docker Compose  | Optional single-server or container deployment | Medium     |
| Manual          | Custom infrastructure                          | High       |

Browser deployments expose a minimal Web App Manifest, so a supporting browser can install the
site with Vision branding and standalone window metadata. This does not add a service worker or an
offline cache; the backend remains required for application data and operations.

## Docker Compose (Optional)

Native macOS installation and Docker-to-native migration are documented in
[[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]. This Compose section remains the
supported container deployment path and does not duplicate application business logic.

### Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- Valid SSL certificates (for HTTPS)

### 1. Prepare Environment

```bash
# Clone and navigate to project
git clone <repository-url>
cd Vision

# Create production environment file
cp .env.example .env
```

### 2. Configure Production Variables

Edit `.env` with production settings:

```bash
# Required: Generate a secure database password
POSTGRES_PASSWORD=your-secure-password-here

# Server configuration
PORT=3002
LOG_LEVEL=info
CORS_ORIGINS=https://your-domain.com

# Database
DATABASE_URL=postgresql://ftm_user:password@db:5432/financial_transactions
```

### 3. Build and Start

```bash
# Build and start all services
docker compose up -d --build

# View logs
docker compose logs -f app
```

### 4. Verify Deployment

```bash
# Check service status
docker compose ps

# Test API health
curl http://localhost:3002/health
```

### 5. Setup Nginx (Reverse Proxy)

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /api {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 6. Admin Endpoints Security

The backend's admin API (`/api/admin/*`) is protected by:

1. **Port binding to localhost only**: `docker-compose.yml` binds the host port to `127.0.0.1`, ensuring only the host machine can reach the container directly:

   ```yaml
   ports:
     - "127.0.0.1:${PORT:-3002}:3002" # Loopback bind (recommended)
   ```

2. **CSRF guard**: state-changing admin requests must pass the existing origin checks. This blocks
   cross-site browser requests but is not an identity check.

3. **Bearer token**: Set `ADMIN_AUTH_TOKEN` for explicit token-based protection. It is required if:
   - You change the port binding to `0.0.0.0`
   - You expose the backend to untrusted networks
   - You want defense-in-depth beyond network isolation

There is no private-network IP allowlist fallback. If the backend binds beyond loopback without a
token or an explicit acknowledged outer boundary, startup fails closed. See
[[docs/adr/063-admin-auth-csrf-guard|ADR-063]].

**Critical synchronization:** Any named volumes added to `docker-compose.yml` **must also be added**
to `packaging/electron/resources/docker-compose.yml`, which is retained for the optional Electron
Docker provider. Omitting a volume from that copy can lose optional-provider data on
updates. Native startup does not use this Compose file. See
[[docs/guides/cicd-pipelines#3-verify-compose-sync--docker-compose-sync-check|CI/CD Pipelines:
Verify Compose Sync]] and [[docs/adr/051-docker-compose-sync-named-volumes|ADR-051]].

### 7. Container Hardening

Vision's `docker-compose.yml` includes defense-in-depth hardening:

| Control              | Status  | Details                                                                    |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| Non-root user        | Enabled | `USER bun` (UID 1000) in Dockerfile; `user: "1000:1000"` in compose        |
| Dropped capabilities | Enabled | `cap_drop: [ALL]` prevents privilege escalation                            |
| No-new-privileges    | Enabled | `security_opt: [no-new-privileges:true]`                                   |
| Read-only filesystem | Enabled | `read_only: true` with selective writable surfaces (`/tmp`, named volumes) |
| Resource limits      | Enabled | `mem_limit: 4g`, `cpus: 4.0`                                               |
| Healthcheck          | Enabled | Automatic health probe on `HEALTHCHECK` interval                           |

For complete details, rationale, and path-to-production hardening checklist, see [[docs/adr/039-docker-container-hardening|ADR-039]] and [[docs/security/container-hardening|Container Hardening Policy]].

## Database Migrations in Production

Startup logic runs automatically when the container starts. `docker-entrypoint.sh` starts the Bun
backend, and the backend then:

1. Waits for the PostgreSQL database to be ready
2. Runs Vision's guarded migration runner to bootstrap or migrate the schema
   - On a fresh DB: baseline migration `0001_initial_database_schema` creates all 27 tables, enums, indexes, and triggers
   - On an existing DB: pending migrations are applied in sequence
3. Starts the backend application

**Note:** As of Phase 1 (2026-04-21), Alembic is the single source of schema DDL ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]). The legacy `schemaInit.js` has been removed.

If you need to run migrations manually (e.g., for troubleshooting):

```bash
# Run migrations through the same guarded runner used at application startup
docker compose exec app bun run apps/node-backend/scripts/db-migrate.js upgrade
```

Never use a bare Alembic write against Vision. The runner preflights
`alembic_version.version_num` as `VARCHAR(64)` before Alembic writes.

Note: migration `0002_add_url_to_planned_transactions` is idempotent and safely skips `url` creation when the column already exists.

Migration caveat: `0016_add_fx_rate_to_portfolio_transactions` is now safe on inherited-schema deployments where `portfolio_transactions` is a compatibility view. It only runs `ALTER TABLE` when relation kind is table/partitioned table (`relkind in ('r','p')`) and keeps the view recreation path when relation kind is view (`relkind='v'`). During view recreation, `fx_rate_to_eur` stays at the end of the `SELECT` list to preserve existing column order and avoid PostgreSQL `CREATE OR REPLACE VIEW` column-rename errors ([[alembic/versions/0016_add_fx_rate_to_portfolio_transactions.py]], [[docs/api/investments|API: Investments]]).

Migration caveat: `0021_update_price_provider_enum` updates enum type `price_provider` by swapping provider values (`coingecko`/`kraken` -> `binance`) on `investments_base.price_provider`. For PostgreSQL dependency safety during enum type conversion, it temporarily drops the column default, dynamically captures and drops all dependent `public` views that reference `investments_base` (including `price_provider` dependencies), performs the type swap and value mapping, restores `DEFAULT 'manual'`, then recreates the captured views. If `investments` is among recreated views and function `investments_view_update_instead()` exists, trigger `update_investments_view_instead` is recreated as well ([[alembic/versions/0021_update_price_provider_enum.py]], [[docs/api/investments|API: Investments]]).

Migration caveat: `0022_add_kinesis_price_provider_enum` adds enum value `kinesis` to `price_provider`. Its downgrade remaps `kinesis` to `manual`, then rebuilds the enum without `kinesis` while handling dependent `public` views and `investments` update trigger recreation using the same safety pattern as prior enum migrations ([[alembic/versions/0022_add_kinesis_price_provider_enum.py]], [[docs/api/investments|API: Investments]]).

## Backup and Restore

### Complete application backup

Use Vision's backup UI when possible. A `.visionbak` contains the PostgreSQL dump, attachments,
supported frontend/localStorage state, schema metadata, and optional AES-256-GCM encryption. A
database dump alone is not a complete Vision backup.

For an operator-managed final logical dump while PostgreSQL remains available:

```bash
docker compose exec -T db pg_dump -U ftm_user \
  --format=custom --no-owner --no-acl financial_transactions > backup.dump
```

Export the attachment volume separately and verify its file count and hashes. Keep both artifacts
together with a non-secret manifest.

### Restore validation

Do not restore over the live database. Create a fresh database from `template0`, restore with
error-on-first-failure in one transaction, then validate schema, counts, attachments, readiness,
and representative workflows before any cutover:

```bash
docker compose exec -T db createdb -U ftm_user --template=template0 vision_restore_check
docker compose exec -T db pg_restore -U ftm_user \
  --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname=vision_restore_check < backup.dump
```

The native `.visionbak` restore path automates staging, validation, atomic attachment replacement,
and rollback through the active runtime provider.

### Scheduled Backups (recommended)

The command above is **ad-hoc** — nothing schedules it. The Electron app-level backup keeps only
the newest 7 bundles, so between manual dumps your recovery point objective (RPO) is "whenever you
last ran a backup." A volume loss in that window is otherwise unrecoverable. For any Docker/server
deployment holding real data, schedule both the custom database dump and attachment export with
retention.

Example nightly user-crontab entry (database portion, 14-day retention). Install it with
`crontab -e` for an account allowed to run Docker, and replace `/mnt/vision-backups` with an
absolute path on separate storage. Add the matching attachment export and manifest to the same
schedule before treating it as a complete backup:

```bash
# User crontab — runs at 02:30 daily
30 2 * * *  mkdir -p /mnt/vision-backups && cd /path/to/vision && \
  docker compose exec -T db pg_dump -U ftm_user -Fc --no-owner --no-acl financial_transactions \
    > "/mnt/vision-backups/financial_transactions-$(date +\%F).dump" && \
  find /mnt/vision-backups -name 'financial_transactions-*.dump' -mtime +14 -delete
```

Store the backups directory on a **separate volume/host** from `postgres_data` so a disk failure
does not take both. Periodically test a restore into a throwaway database — an untested backup is
not a backup.

## Docker Commands Reference

| Command                       | Description                  |
| ----------------------------- | ---------------------------- |
| `docker compose up -d`        | Start services in background |
| `docker compose down`         | Stop services                |
| `docker compose restart`      | Restart all services         |
| `docker compose logs -f`      | Follow logs                  |
| `docker compose exec app sh`  | Shell into app container     |
| `docker compose exec db psql` | Database shell               |

## Electron Desktop App

### Build Desktop Application

```bash
# Production build
bun run build

# Run Electron (production)
bun run electron:prod

# Explicit optional Docker development runtime
bun run electron:docker
```

### Packaging for macOS

Vision can be packaged into a clickable macOS .app bundle with `.dmg` and `.zip` distributions.

#### Prerequisites

- **Bun and Node.js** — Bun resolves the Electron dependencies; Node.js remains available for Electron tooling. See [[#package-manager-note|Package Manager Note]] below.
- PostgreSQL 18.6 build source: the checksum-pinned Postgres.app release artifact, an explicit
  `VISION_POSTGRES_SOURCE_BIN`, or a matching Homebrew installation. Its service does not need to
  be started.
- Python with the repository's hash-pinned Alembic dependencies and PyInstaller 6.22.2 for the
  standalone migration executable.
- The Puppeteer-pinned Chrome Headless Shell artifact for native HTML-to-PDF reports.
- macOS 11.0 or later
- arm64 architecture (Apple Silicon)

These are package-build inputs, not end-user runtime prerequisites. A built Vision application
contains the database server and client tools, migration executable, Bun backend, production
frontend, and report browser.

#### Build Steps

```bash
# Navigate to electron packaging directory
cd packaging/electron

# Install the dependency tree pinned by packaging/electron/bun.lock
# The package postinstall materializes the pinned local Electron binary.
bun install --frozen-lockfile

# Run build and package
npm run dist
```

This produces three artifacts in `packaging/electron/dist/`:

- `Vision.app/` — Standalone macOS application bundle
- `Vision-1.0.0-arm64.dmg` — Disk image for distribution/installation
- `Vision-1.0.0-arm64-mac.zip` — Compressed bundle for archival

#### Package Manager Note

`packaging/electron/` uses **Bun** for dependency management:

- **Root project**: Uses bun (via `bun.lock`)
- **Electron sub-package**: Uses Bun via its separate `packaging/electron/bun.lock`

The Electron directory is not a root workspace, so it needs its own explicit frozen install. A normal local install runs the package's narrow `postinstall` command, `install-electron`, which verifies and materializes the pinned Electron binary required by `electron:dev`, `electron:prod`, and local packaging. CI backend verification, release verification, and the macOS package build all resolve the same lockfile with `--ignore-scripts`; electron-builder obtains the build runtime independently during packaging. `npm run dist` below invokes a package script but does not resolve dependencies with npm.

The package declares the runtime modules loaded by the backup bundle directly:

```json
{
  "dependencies": {
    "archiver": "^8.0.0",
    "yauzl": "^3.3.0"
  }
}
```

Their transitive graph is pinned in `packaging/electron/bun.lock`; do not add a second lockfile for this package.

#### Bundled Resources Configuration

Electron-builder's `files` and `extraResources` arrays control what gets packed inside `app.asar` vs. kept outside at `Contents/Resources/`.

**Files inside asar** (`files` in `electron-builder-base.json`):

- `main.js` — Electron main process
- `preload.js` — Security preload bridge
- `runtime/**/*` — Native and Docker runtime providers
- `backup/**/*` — Backup/restore bundle utilities
- `assets/**/*` — Frontend build output

**Files outside asar** (`extraResources` array):

- `i18n/` → `Contents/Resources/i18n` — Runtime i18n locale files
- `resources/` → `Contents/Resources/resources` — Optional Docker Compose provider resources
- `native-runtime/` → `Contents/Resources/native-runtime` — PostgreSQL 18.6, Chrome Headless Shell,
  standalone migration executable, compiled backend, production frontend, migrations,
  configuration, licence notices, and checksum manifest

**Rationale:** Native runtime executables and migration files must remain outside `app.asar` and
must pass the packaged payload manifest check before use. Docker Compose resources remain in the
repository and optional Docker packaging path; they are not required by native startup.

**Configuration example:**

```json
{
  "build": {
    "files": [
      "main.js",
      "preload.js",
      "runtime/**/*",
      "backup/**/*",
      "assets/**/*"
    ],
    "extraResources": [
      { "from": "i18n", "to": "i18n" },
      { "from": "resources", "to": "resources" },
      { "from": "native-runtime", "to": "native-runtime" }
    ]
  }
}
```

#### Installation & Launch

**From DMG:**

1. Open `Vision-1.0.0-arm64.dmg`
2. Drag `Vision.app` to `/Applications` folder
3. Open Applications, right-click `Vision.app`, select "Open" (first launch only — macOS Gatekeeper check)

**From .app bundle directly:**

```bash
# If you have the Vision.app bundle, either:
# 1. Drag to /Applications and launch from Launchpad
# 2. Or launch from terminal (bypasses Gatekeeper on M-series Macs):
cd /path/to/Vision.app
./Contents/MacOS/Vision

# To bypass Gatekeeper quarantine attribute on first run:
xattr -dr com.apple.quarantine /Applications/Vision.app
```

#### Runtime Requirements

The Vision desktop app verifies its checksummed native payload, starts a private PostgreSQL 18.6 cluster
on loopback, runs the normal migration runner through the bundled executable, and starts the
packaged Bun backend as a child process. Docker Desktop, Homebrew, Postgres.app, Python, and an
installed Chrome are not required at runtime. The provider rejects a missing or mismatched payload,
a PostgreSQL port collision, a non-loopback listener, a cluster with the wrong data directory, or a
foreign backend/database process identifier.

Durable database files, attachments, logs, credentials, and the runtime marker live below
`~/Library/Application Support/Vision/native/vision`. Replacing the application bundle during an
update does not replace this data directory.

```bash
# Check backend status in app:
# Settings → App → Developer → Admin Mode (toggle) → Admin → Endpoints
# Verify GET /health returns success
```

#### Code Signing & Notarization

The app bundle is currently **unsigned** (no Developer ID certificate). This is suitable for personal/local use. For production distribution:

- Acquire a Developer ID Application certificate from Apple Developer
- Configure signing in `packaging/electron/package.json` (`mac.signing` + `mac.signingIdentity`)
- Enable notarization via `mac.notarize` (submits binary to Apple for malware check)
- Update CI/CD pipeline to provide signing secrets

For now, the Gatekeeper prompt on first launch is expected.

#### Application Metadata

| Property     | Value                                                                |
| ------------ | -------------------------------------------------------------------- |
| App ID       | `com.vaultvoyager.vision`                                            |
| Product Name | `Vision`                                                             |
| Category     | Finance                                                              |
| Icon         | `packaging/electron/build/icon.icns` (stylized "V eye" logo, 1024px) |

The icon is located at `packaging/electron/build/icon.svg` (source vector) and compiled to `.icns` format for macOS.

#### Troubleshooting

**"Vision" cannot be opened because the developer cannot be verified:**

- Expected on unsigned builds
- Right-click the app, select "Open"
- Or use `xattr -dr com.apple.quarantine /Applications/Vision.app`

**Backend service unavailable:**

- Check app logs: Settings → App → Developer → Open Logs
- Native mode: inspect `logs/postgres.log` and `logs/backend.log` below the Vision native
  application-data directory. Check whether port `54329` is occupied by an unrelated service.
- Native mode: reinstall the same Vision release if startup reports a missing, corrupt, wrong-arch,
  or wrong-version native payload. Do not point Vision at an unknown PostgreSQL server to bypass
  that failure.
- Native mode: run `bun run native:db-smoke` from the source checkout for a synthetic database check
- Docker mode only: ensure Docker Desktop is running and inspect the Compose app/database health

**Icon not showing in Finder:**

- Ensure `build/icon.icns` exists
- Rebuild: `npm run dist`
- Clear Finder cache: `rm -rf ~/Library/Caches/com.apple.finder`

**"Cannot find module './backup/bundle'" at startup:**

- Cause: `backup/` directory not included in electron-builder `files` array
- Fix: Add `backup/**/*` to `files` in `package.json` build config
- Verify: `ls -la packaging/electron/dist/mac-arm64/Vision.app/Contents/Resources/app.asar` should contain `backup/bundle.js`

**"Cannot find module 'archiver-utils'" or other missing transitives:**

- Cause: The frozen Electron dependency tree was not installed or the packaged asar is incomplete
- Fix: Confirm `packaging/electron/bun.lock`, then run `bun install --frozen-lockfile --cwd packaging/electron` from the repository root
- Rebuild with `npm run dist` from `packaging/electron/` and inspect the asar before changing dependency declarations

**Docker provider: "ENOENT docker-compose.yml" in Contents/Resources/resources/:**

- Cause: `resources/docker-compose.yml` not copied to `extraResources`
- Fix: Ensure `extraResources` config includes `{ "from": "resources", "to": "resources" }`
- Verify: `ls -la /path/to/Vision.app/Contents/Resources/resources/` shows `docker-compose.yml`

**"registry unauthorized" on first launch (GHCR private image):**

- Cause: Packaged app attempts to pull from private GHCR registry without auth
- Fix:
  1. Build locally: `docker compose build` in project root
  2. Retag image: `docker tag vision-app:latest ghcr.io/erapartner/vision:latest`
  3. Verify `packaging/electron/resources/docker-compose.yml` has `pull_policy: missing` (uses local image instead of attempting registry pull)
- The embedded compose file defaults to `pull_policy: missing`, so freshly-built local images are used without registry auth

#### Docker Compose Pull Policy

The embedded `packaging/electron/resources/docker-compose.yml` includes:

```yaml
services:
  app:
    image: ghcr.io/erapartner/vision:latest
    pull_policy: missing
```

**Pull policy: missing** — Docker uses a local image if it exists; only pulls from registry if not found locally. This avoids GHCR auth failures on first install.

**Workflow for the optional packaged Docker provider:**

1. In development or CI, build the image: `docker compose build` (creates `vision-app:latest`)
2. Retag for embedded config: `docker tag vision-app:latest ghcr.io/erapartner/vision:latest`
3. Package the app: `cd packaging/electron && npm run dist` (embeds `docker-compose.yml` with `pull_policy: missing`)
4. An operator explicitly selects Docker mode — Compose finds the local
   `ghcr.io/erapartner/vision:latest` image without registry access.

Normal packaged launch selects native mode and never checks this image.

If you need users to pull from GHCR (e.g., published release), either:

- Ensure the image is public, or
- Document Docker login steps for users

## Environment Variables Reference

### Docker/custom deployment variables

Packaged native Vision generates its own restricted runtime configuration. The following values
are required only for Docker Compose or a custom backend deployment:

| Variable            | Description                  |
| ------------------- | ---------------------------- |
| `DATABASE_URL`      | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | Database password            |

### Optional Variables

| Variable       | Default                                     | Description                              |
| -------------- | ------------------------------------------- | ---------------------------------------- |
| `PORT`         | 3002                                        | Server port                              |
| `LOG_LEVEL`    | info                                        | Logging level (debug, info, warn, error) |
| `CORS_ORIGINS` | http://localhost:5174,http://localhost:8080 | Allowed origins                          |

## Security Checklist

- [ ] Change default database password
- [ ] Set a strong `ADMIN_AUTH_TOKEN` (the admin-route gate) if the backend port is reachable beyond loopback
- [ ] Configure `CORS_ORIGINS` properly
- [ ] Enable SSL/TLS
- [ ] Setup regular database backups
- [ ] Configure firewall rules
- [ ] Enable logging and monitoring

## Monitoring

### Health Check

```bash
curl http://localhost:3002/health
```

### Health and Restart Semantics

The app image has a Docker `HEALTHCHECK`, but plain Docker Compose treats that status as
observational. `restart: unless-stopped` restarts a container only after its process exits; it does
not restart a process that remains alive while the health check reports `unhealthy`. This is the
accepted policy: operators can alert or restart from their monitoring system without giving the
application an automatic container-restart control loop.

The Electron shell also does not restart a merely unhealthy container. It polls the backend HTTP
health endpoint and exposes sustained loss/restoration IPC callbacks, although the current React
renderer does not subscribe to them. On startup timeout, the shell starts recording
`docker compose ps --all` plus the last 200 app and database log lines while it loads the
recoverable error page, whose Retry/Open Logs actions handle startup recovery.

A failed database migration exits the backend, so Compose may retry it under the restart policy.
This loop is not silent: the backend emits the distinct `alembic command failed` event with exit,
stdout, and stderr metadata, followed by `Failed to start application`. Electron captures those
lines in its startup diagnostics. For a server-only deployment, inspect them with:

```bash
docker compose ps --all
docker compose logs --tail=200 app db
```

Repeated migration failure needs human repair; do not keep restarting or modify
`alembic_version` until the exact failing revision and database state are understood.

### Log Analysis

```bash
# View recent logs
docker compose logs --tail=100 app

# Search logs
docker compose logs app | grep ERROR
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs app

# Verify environment variables
docker compose config
```

### Database Connection Failed

```bash
# Check database container
docker compose ps db
docker compose logs db

# Verify connection
docker compose exec app nc -z db 5432
```

### Out of Memory

```bash
# Check memory usage
docker stats

# Increase memory limit in docker-compose.yml
```

## Related

- [[docs/adr/039-docker-container-hardening|ADR-039: Docker Container Hardening]] - Container security decisions
- [[docs/security/container-hardening|Container Hardening Policy]] - Defense-in-depth controls and verification
- [[docs/guides/setup|Setup Guide]] - Local development setup
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]] - Bundled PostgreSQL lifecycle, cutover, and rollback
- [[docs/adr/113-native-macos-runtime|ADR-113: Native macOS Runtime]] - Runtime-provider decision
- [[docs/guides/migrations|Migration Guide]] - Database schema management with Alembic
- [[docs/guides/contributing|Contributing Guide]] - Development contributions
- [[docs/performance/index|Performance Documentation]]
- [[docs/security/index|Security Documentation]]
