---
title: Deployment Guide
type: guide
status: active
date: 2026-04-21
updated: 2026-04-27
tags: [guide, deployment, production, docker, electron, phase-1, security, admin-auth, port-binding, container-hardening, packaging, troubleshooting]
description: Production deployment instructions including port binding and admin endpoints security
aliases: [deployment-guide, production-deploy, docker-deploy, electron-packaging]
related_code: [[docker-compose.yml]]
---

# Deployment Guide

This guide covers deploying Vision in production environments.

## Deployment Options

Vision supports multiple deployment methods:

| Method | Use Case | Complexity |
|--------|----------|------------|
| Docker Compose | Single server production | Medium |
| Electron Desktop | Local desktop app | Low |
| Manual | Custom infrastructure | High |

## Docker Compose (Recommended)

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

# Required: Generate a secure secret key
SECRET_KEY=your-application-secret-key

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
curl http://localhost:3002/api/info/health
```

### 5. Setup Nginx (Reverse Proxy)

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:5173;
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
     - "127.0.0.1:${PORT:-3002}:3002"  # Loopback bind (recommended)
   ```

2. **Private network allowlist fallback**: When `ADMIN_AUTH_TOKEN` is unset, admin endpoints allow requests from:
   - Loopback (127.0.0.1, ::1, ::ffff:127.0.0.1)
   - Private networks (RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
   - IPv6 ULA (fc00::/7)

3. **Bearer token (optional)**: Set `ADMIN_AUTH_TOKEN` for explicit token-based protection. This is recommended if:
   - You change the port binding to `0.0.0.0`
   - You expose the backend to untrusted networks
   - You want defense-in-depth beyond network isolation

**Important:** If you modify `docker-compose.yml` to change the port binding from `127.0.0.1` to `0.0.0.0`, you **must** set `ADMIN_AUTH_TOKEN` to prevent LAN access to dangerous admin operations. See [[docs/adr/037-admin-auth-localhost-fallback|ADR-037]] for details.

**Critical synchronization:** Any named volumes added to `docker-compose.yml` **must also be added** to `packaging/electron/resources/docker-compose.yml` (the embedded Electron app compose file). Omitting a volume from the embedded file causes data loss on updates — see [[docs/guides/cicd-pipelines#3-verify-compose-sync--docker-compose-sync-check|CI/CD Pipelines: Verify Compose Sync]] and [[docs/adr/051-docker-compose-sync-named-volumes|ADR-046]] for details.

### 7. Container Hardening

Vision's `docker-compose.yml` includes defense-in-depth hardening:

| Control | Status | Details |
|---------|--------|---------|
| Non-root user | Enabled | `USER bun` (UID 1000) in Dockerfile; `user: "1000:1000"` in compose |
| Dropped capabilities | Enabled | `cap_drop: [ALL]` prevents privilege escalation |
| No-new-privileges | Enabled | `security_opt: [no-new-privileges:true]` |
| Read-only filesystem | Enabled | `read_only: true` with selective writable surfaces (`/tmp`, named volumes) |
| Resource limits | Enabled | `mem_limit: 4g`, `cpus: 4.0` |
| Healthcheck | Enabled | Automatic health probe on `HEALTHCHECK` interval |

For complete details, rationale, and path-to-production hardening checklist, see [[docs/adr/039-docker-container-hardening|ADR-039]] and [[docs/security/container-hardening|Container Hardening Policy]].

## Database Migrations in Production

Startup logic runs automatically when the container starts via the `docker-entrypoint.sh` script. The entrypoint script:
1. Waits for the PostgreSQL database to be ready
2. Runs `alembic upgrade head` to bootstrap or migrate the schema
   - On a fresh DB: baseline migration `0001_initial_database_schema` creates all 27 tables, enums, indexes, and triggers
   - On an existing DB: pending migrations are applied in sequence
3. Starts the backend application

**Note:** As of Phase 1 (2026-04-21), Alembic is the single source of schema DDL ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]). The legacy `schemaInit.js` has been removed.

If you need to run migrations manually (e.g., for troubleshooting):

```bash
# Run migrations in the app container using the venv Python
docker compose exec app /app/venv/bin/python3 -m alembic -c /app/config/alembic.ini upgrade head
```

Note: migration `0002_add_url_to_planned_transactions` is idempotent and safely skips `url` creation when the column already exists.

Migration caveat: `0016_add_fx_rate_to_portfolio_transactions` is now safe on inherited-schema deployments where `portfolio_transactions` is a compatibility view. It only runs `ALTER TABLE` when relation kind is table/partitioned table (`relkind in ('r','p')`) and keeps the view recreation path when relation kind is view (`relkind='v'`). During view recreation, `fx_rate_to_eur` stays at the end of the `SELECT` list to preserve existing column order and avoid PostgreSQL `CREATE OR REPLACE VIEW` column-rename errors ([[alembic/versions/0016_add_fx_rate_to_portfolio_transactions.py]], [[docs/api/investments|API: Investments]]).

Migration caveat: `0021_update_price_provider_enum` updates enum type `price_provider` by swapping provider values (`coingecko`/`kraken` -> `binance`) on `investments_base.price_provider`. For PostgreSQL dependency safety during enum type conversion, it temporarily drops the column default, dynamically captures and drops all dependent `public` views that reference `investments_base` (including `price_provider` dependencies), performs the type swap and value mapping, restores `DEFAULT 'manual'`, then recreates the captured views. If `investments` is among recreated views and function `investments_view_update_instead()` exists, trigger `update_investments_view_instead` is recreated as well ([[alembic/versions/0021_update_price_provider_enum.py]], [[docs/api/investments|API: Investments]]).

Migration caveat: `0022_add_kinesis_price_provider_enum` adds enum value `kinesis` to `price_provider`. Its downgrade remaps `kinesis` to `manual`, then rebuilds the enum without `kinesis` while handling dependent `public` views and `investments` update trigger recreation using the same safety pattern as prior enum migrations ([[alembic/versions/0022_add_kinesis_price_provider_enum.py]], [[docs/api/investments|API: Investments]]).

## Backup and Restore

### Backup Database

```bash
# Create backup
docker compose exec db pg_dump -U ftm_user financial_transactions > backup.sql

# Compressed backup
docker compose exec db pg_dump -U ftm_user -Fc financial_transactions > backup.dump
```

### Restore Database

```bash
# Restore from plain SQL
docker compose exec -T db psql -U ftm_user financial_transactions < backup.sql

# Restore from compressed dump
docker compose exec -T db pg_restore -U ftm_user -d financial_transactions -c backup.dump
```

### Scheduled Backups (recommended)

The commands above are **ad-hoc** — nothing runs them on a schedule. The Electron app-level backup
keeps only the newest 7 bundles, so between manual dumps your recovery point objective (RPO) is
"whenever you last ran a backup." A volume loss in that window is otherwise unrecoverable. For any
Docker/server deployment holding real data, schedule a periodic `pg_dump` with retention.

Example nightly cron entry (compressed dump + 14-day retention):

```bash
# /etc/cron.d/vision-db-backup  — runs at 02:30 daily
30 2 * * *  cd /path/to/vision && \
  docker compose exec -T db pg_dump -U ftm_user -Fc financial_transactions \
    > "backups/financial_transactions-$(date +\%F).dump" && \
  find backups -name 'financial_transactions-*.dump' -mtime +14 -delete
```

Store the backups directory on a **separate volume/host** from `postgres_data` so a disk failure
does not take both. Periodically test a restore into a throwaway database — an untested backup is
not a backup.

## Docker Commands Reference

| Command | Description |
|---------|-------------|
| `docker compose up -d` | Start services in background |
| `docker compose down` | Stop services |
| `docker compose restart` | Restart all services |
| `docker compose logs -f` | Follow logs |
| `docker compose exec app sh` | Shell into app container |
| `docker compose exec db psql` | Database shell |

## Electron Desktop App

### Build Desktop Application

```bash
# Production build
bun run build

# Run Electron (production)
bun run electron:prod

# Clean build
bun run electron:clean
```

### Packaging for macOS

Vision can be packaged into a clickable macOS .app bundle with `.dmg` and `.zip` distributions.

#### Prerequisites

- **Node.js (npm)** — `packaging/electron/` uses npm (not bun) for package management. See [[#package-manager-note|Package Manager Note]] below.
- Docker Desktop running (required at runtime)
- macOS 11.0 or later
- arm64 architecture (Apple Silicon)

#### Build Steps

```bash
# Navigate to electron packaging directory
cd packaging/electron

# Install dependencies (npm, not bun)
npm install

# Run build and package
npm run dist
```

This produces three artifacts in `packaging/electron/dist/`:
- `Vision.app/` — Standalone macOS application bundle
- `Vision-1.0.0-arm64.dmg` — Disk image for distribution/installation
- `Vision-1.0.0-arm64-mac.zip` — Compressed bundle for archival

#### Package Manager Note

`packaging/electron/` uses **npm** (not bun) for dependency management:

- **Root project**: Uses bun (via `bun.lock`)
- **Electron sub-package**: Uses npm (via `package-lock.json`)

**Rationale:** Bun's nested-hoisting behavior confused electron-builder's asar tree-walker, leaving transitive dependencies as nested-only copies that Node.js resolution couldn't find at runtime. Switching to npm forces top-level flattening in `node_modules`, ensuring electron-builder bundles all dependencies at the correct depth inside `app.asar`.

**Transitive dependencies caveat:** Archiver transitives are declared explicitly in `packaging/electron/package.json` to force electron-builder inclusion:

```json
{
  "dependencies": {
    "archiver": "^7.1.2",
    "archiver-utils": "^5.0.2",
    "compress-commons": "^6.0.2",
    "readable-stream": "^4.5.2",
    "zip-stream": "^6.0.1"
  }
}
```

Without explicit declarations, bundling-time hoisting fails and archiver-based backup cannot serialize the bundle at runtime.

#### Bundled Resources Configuration

Electron-builder's `files` and `extraResources` arrays control what gets packed inside `app.asar` vs. kept outside at `Contents/Resources/`.

**Files inside asar** (`files` array in `package.json`):
- `main.js` — Electron main process
- `preload.js` — Security preload bridge
- `backup/**/*` — Backup/restore bundle utilities
- `assets/**/*` — Frontend build output

**Files outside asar** (`extraResources` array):
- `i18n/` → `Contents/Resources/i18n` — Runtime i18n locale files
- `resources/` → `Contents/Resources/resources` — Additional static resources (e.g., docker-compose.yml)

**Rationale:** `main.js` references i18n and resources via `process.resourcesPath` (lines 22, 204, 234). Packing them inside `app.asar` causes runtime path lookups to fail (`Cannot find module './i18n/...'`). Placing them at `Contents/Resources/` ensures they're accessible via the `process.resourcesPath` reference at runtime.

**Configuration example:**
```json
{
  "build": {
    "files": ["main.js", "preload.js", "backup/**/*", "assets/**/*"],
    "extraResources": [
      { "from": "i18n", "to": "i18n" },
      { "from": "resources", "to": "resources" }
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

The Vision desktop app spawns the Node.js backend as a child process. **Docker Desktop must be running** before launching the app.

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

| Property | Value |
|----------|-------|
| App ID | `com.vaultvoyager.vision` |
| Product Name | `Vision` |
| Category | Finance |
| Icon | `packaging/electron/build/icon.icns` (stylized "V eye" logo, 1024px) |

The icon is located at `packaging/electron/build/icon.svg` (source vector) and compiled to `.icns` format for macOS.

#### Troubleshooting

**"Vision" cannot be opened because the developer cannot be verified:**
- Expected on unsigned builds
- Right-click the app, select "Open"
- Or use `xattr -dr com.apple.quarantine /Applications/Vision.app`

**Backend service unavailable:**
- Ensure Docker Desktop is running
- Check app logs: Settings → App → Developer → Open Logs
- Verify Docker image is built: `cd apps/node-backend && docker build -t vision-app .`
- Check that local Docker image is tagged: `docker tag vision-app:latest ghcr.io/erapartner/vision:latest` (see [[#docker-composeyml-pull-policy|Docker Compose Pull Policy]] below)

**Icon not showing in Finder:**
- Ensure `build/icon.icns` exists
- Rebuild: `npm run dist`
- Clear Finder cache: `rm -rf ~/Library/Caches/com.apple.finder`

**"Cannot find module './backup/bundle'" at startup:**
- Cause: `backup/` directory not included in electron-builder `files` array
- Fix: Add `backup/**/*` to `files` in `package.json` build config
- Verify: `ls -la packaging/electron/dist/mac-arm64/Vision.app/Contents/Resources/app.asar` should contain `backup/bundle.js`

**"Cannot find module 'archiver-utils'" or other missing transitives:**
- Cause: Bun's nested-hoisting left archiver dependencies incomplete; npm flatten resolves them
- Fix: Ensure `packaging/electron/package-lock.json` exists (use npm, not bun)
- Add explicit transitives to `package.json`: `archiver-utils`, `compress-commons`, `readable-stream`, `zip-stream`
- Rebuild: `npm install && npm run dist`

**"ENOENT docker-compose.yml" in Contents/Resources/resources/:**
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

**Workflow for packaged app:**
1. In development or CI, build the image: `docker compose build` (creates `vision-app:latest`)
2. Retag for embedded config: `docker tag vision-app:latest ghcr.io/erapartner/vision:latest`
3. Package the app: `cd packaging/electron && npm run dist` (embeds `docker-compose.yml` with `pull_policy: missing`)
4. User installs and launches the app — compose finds local `ghcr.io/erapartner/vision:latest` image without registry access

If you need users to pull from GHCR (e.g., published release), either:
- Ensure the image is public, or
- Document Docker login steps for users

## Environment Variables Reference

### Required Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | Database password |
| `SECRET_KEY` | Application secret key |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3002 | Server port |
| `LOG_LEVEL` | info | Logging level (debug, info, warn, error) |
| `CORS_ORIGINS` | http://localhost:5173 | Allowed origins |

## Security Checklist

- [ ] Change default database password
- [ ] Set secure `SECRET_KEY`
- [ ] Configure `CORS_ORIGINS` properly
- [ ] Enable SSL/TLS
- [ ] Setup regular database backups
- [ ] Configure firewall rules
- [ ] Enable logging and monitoring

## Monitoring

### Health Check

```bash
curl http://localhost:3002/api/info/health
```

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
- [[docs/guides/migrations|Migration Guide]] - Database schema management with Alembic
- [[docs/guides/contributing|Contributing Guide]] - Development contributions
- [[docs/performance/index|Performance Documentation]]
- [[docs/security/index|Security Documentation]]
