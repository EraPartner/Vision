---
title: Container Hardening
type: security
status: active
date: 2026-04-25
tags: [security, docker, containers, hardening, defense-in-depth]
description: Docker container hardening posture — non-root, dropped capabilities, read-only filesystem, resource ceilings, healthcheck, CI image scanning.
aliases: [container security, docker hardening, container posture]
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

Trivy runs on every push to `main` and on every PR (`.github/workflows/docker-scan.yml`):

```yaml
severity: CRITICAL,HIGH
exit-code: '1'
ignore-unfixed: true
vuln-type: os,library
```

`ignore-unfixed: true` keeps CI green for CVEs that have no upstream patch yet — those are tracked manually instead of blocking unrelated work.

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
