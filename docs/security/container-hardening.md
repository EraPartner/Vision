---
title: Container Hardening
type: security
status: active
date: 2026-04-25
updated: 2026-05-29
tags: [security, docker, containers, hardening, defense-in-depth, trivy-scan, supply-chain, electron, npm-scripts]
description: Docker container hardening posture — non-root, dropped capabilities, read-only filesystem, resource ceilings, healthcheck, CI image scanning. Also covers Electron release build supply-chain hardening (npm ci --ignore-scripts).
aliases: [container security, docker hardening, container posture, electron supply chain]
---

# Container Hardening

Defense-in-depth at the container layer for the `app` service. Each control is independently bypassable; together they make a hypothetical RCE much harder to turn into host compromise.

> See [[docs/adr/039-docker-container-hardening|ADR-039]] for the decision record and rationale.

## Trust Boundary

Host loopback (`127.0.0.1:3002`) → docker-proxy → hardened container. The container is the isolation boundary; no LAN exposure.

## Controls (`app` service)

| Control | Setting | Verify |
|---|---|---|
| Non-root user | `USER bun` (UID 1000) in `Dockerfile`, `user: "1000:1000"` in compose | `docker exec vision-app-1 id` → `uid=1000(bun)` |
| Dropped capabilities | `cap_drop: [ALL]` | `docker exec vision-app-1 sh -c 'grep CapEff /proc/self/status'` → `0000000000000000` |
| No new privileges | `security_opt: [no-new-privileges:true]` | Setuid binaries cannot elevate during `exec` |
| Read-only rootfs | `read_only: true` | `docker exec vision-app-1 touch /app/x` → `Read-only file system` |
| Writable tmpfs | `tmpfs: /tmp:size=512m,mode=1777` | Multer uploads + Puppeteer scratch |
| Persistent volume | `attachments_data:/app/data/attachments` | Survives `docker compose down` and image rebuilds |
| Memory ceiling | `mem_limit: 4g` | `docker stats` |
| CPU ceiling | `cpus: 4.0` | `docker stats` |
| Healthcheck | `HEALTHCHECK` → `wget /health` every 30s | `docker inspect --format '{{.State.Health.Status}}'` |

## Puppeteer Note

`cap_drop: ALL` removes `SYS_ADMIN`, which Chromium's user-namespace sandbox needs. The renderer launches with `--no-sandbox` (see `apps/node-backend/src/services/reports/puppeteerRenderer.js`). Justification: the container itself is the isolation boundary, and the combined posture (non-root + dropped caps + no-new-privileges + read-only fs) is stronger than Chromium's own sandbox alone.

## CI Image Scanning

Trivy runs on every push to `main` and on every PR (`.github/workflows/ci.yml:206`). As of 2026-04-29, Trivy now **blocks the CI build** on CRITICAL or HIGH severity vulnerabilities:

```yaml
aquasecurity/trivy-action@0.28.0
severity: CRITICAL,HIGH
exit-code: '1'
ignore-unfixed: true
vuln-type: os,library
```

**Configuration:**
- `exit-code: '1'` — Blocks CI/CD pipeline if CRITICAL or HIGH CVEs are detected
- `ignore-unfixed: true` — Allows passing if CVEs have no upstream patch yet (tracked separately for later resolution)
- `aquasecurity/trivy-action@0.28.0` — Pinned version (not floating `@master`) to prevent supply-chain risk

This ensures no images with known critical/high vulnerabilities reach production.

## Electron Release Build — Supply-Chain Hardening (2026-05-29)

The `.github/workflows/release.yml` Electron packaging step now installs dependencies with:

```bash
npm ci --ignore-scripts
```

`npm ci` provides a clean, lock-file-reproducible install (no version drift). `--ignore-scripts` blocks all `preinstall`, `install`, `postinstall`, and similar lifecycle hooks in the dependency tree from running during the packaging phase. This prevents a compromised transitive dependency from executing arbitrary code on the CI runner that builds and signs the distributed `.dmg`.

**Scope:** Applies to the `packaging/electron` workspace in the release job only. The intermediate "install electron workspace dependencies for backend tests" step that runs earlier in the workflow also passes `--ignore-scripts` (line 125 in `release.yml`).

**`@electron/get`:** The Electron binary itself is downloaded by `electron-builder` via `@electron/get` independently of the npm install lifecycle, so `--ignore-scripts` does not affect binary fetching.

> [!info] Related
> The `ci.yml` workflow already runs Trivy image scanning (blocking on CRITICAL/HIGH) and `bun audit` for dependency vulnerability checks. The `--ignore-scripts` change closes a complementary gap: transitive npm lifecycle scripts that run _before_ scanning.

## Out of Scope (Today)

- `db` (postgres) service — official image already runs as `postgres` user; aggressive hardening risks data-tier integrity.
- Distroless / scratch base image migration.
- Rootless Docker daemon on the host.
- Production / internet-facing deployment hardening (TLS, reverse proxy, secrets manager, public auth on non-admin routes) — see ADR-039 "Path to production."

## Related

- [[docs/adr/039-docker-container-hardening|ADR-039]] — Decision record
- [[docs/adr/037-admin-auth-localhost-fallback|ADR-037]] — Prior network-exposure fix (host loopback bind, RFC 1918 trust)
- [[docs/adr/038-dependency-slim-down-supply-chain-risk|ADR-038]] — Parallel supply-chain hardening
- [[docs/security/index|Security index]]
