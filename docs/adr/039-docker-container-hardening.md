---
title: Docker Container Hardening
type: adr
status: Accepted
date: 2026-04-25
tags: [adr, security, docker, containers, hardening]
description: Defense-in-depth at the container layer — non-root, dropped capabilities, read-only filesystem, resource ceilings, healthcheck, CI image scanning.
aliases: [adr-039, docker hardening]
---

# ADR-039: Docker Container Hardening

## Status
Accepted

## Date
2026-04-25

## Context

Vision runs locally via `docker-compose`. Prior fix bound the host port to `127.0.0.1` so the API is not exposed on the LAN, and extended admin middleware to trust RFC 1918 / IPv6 ULA / IPv4-mapped private IPs. That closes the network exposure but leaves the container itself running as root with full Linux capabilities, a writable rootfs, and no resource ceilings — so a hypothetical RCE inside the app process (e.g. via a parser bug, dependency CVE, or Puppeteer escape) would have unlimited blast radius on the host.

The threat model is local-only today, but:
1. The `app` service runs untrusted-shaped workloads (Puppeteer/Chromium, CSV parsing, third-party dependencies).
2. The same image is the foundation for a future internet-facing deployment (see [[docs/adr/038-dependency-slim-down-supply-chain-risk|ADR-038]] for the parallel supply-chain effort).
3. Container hardening is essentially free — it is config, not code — and surfaces real bugs early (e.g. accidental writes to `/app`).

## Decision

Apply defense-in-depth at the container layer for the `app` service:

| Control | Mechanism | Rationale |
|---|---|---|
| Non-root runtime | `USER bun` (UID 1000) in `Dockerfile`, `user: "1000:1000"` in compose | Already the default user in `oven/bun:1-alpine` — no `useradd` needed. Migrations, Bun, Python venv all run as UID 1000 after `chown -R bun:bun /app /venv`. |
| Drop Linux capabilities | `cap_drop: [ALL]` | Bun + Node + Alembic + Chromium need zero Linux capabilities at runtime — no raw sockets, no privileged ports, no kernel features. Verified by `CapEff: 0000000000000000`. |
| Block privilege escalation | `security_opt: [no-new-privileges:true]` | Prevents setuid binaries from elevating during exec — defence-in-depth even with caps already dropped. |
| Read-only root filesystem | `read_only: true` + tmpfs/volumes for the writable carve-outs | Forces all runtime state through explicit, named writable surfaces. Surfaces accidental writes immediately. |
| Writable surfaces | `tmpfs: /tmp:size=512m,mode=1777` and named volume `attachments_data:/app/data/attachments` | `/tmp` covers multer uploads + Puppeteer scratch space. Attachments persist across rebuilds. |
| Resource ceilings | `mem_limit: 4g`, `cpus: 4.0` | Generous local-dev ceilings that contain runaway processes (memory leaks, fork bombs from a compromise) without throttling normal use. |
| Healthcheck | `HEALTHCHECK` against `/health` via `wget` | Deterministic readiness signal for orchestration and humans. |
| CI image scan | `aquasecurity/trivy-action` on push/PR with `severity: CRITICAL,HIGH`, `exit-code: 1`, `ignore-unfixed: true` | Catches base-image and dependency CVEs before they ship. |

Trust boundary: host loopback only (`127.0.0.1:3002`) → docker-proxy → hardened container.

## Consequences

### Positive
- Container compromise no longer implies host root or arbitrary capabilities.
- Read-only fs surfaces accidental writes (caught one during implementation: `/app/data/attachments` not pre-created → fixed in `Dockerfile` by `mkdir -p` before `chown`).
- Attachments now survive `docker compose down` and image rebuilds (named volume `attachments_data`); previously they lived only inside the container's writable layer.
- CI now blocks releases on CRITICAL/HIGH OS or library CVEs.
- Most prod-only work for an internet-facing deployment is already done — see "Path to production" in the implementation plan.

### Negative
- Anything that needs to write to the rootfs at runtime now fails loudly. Future code that assumes a writable `/app/...` must either route through `/tmp` or get its own named volume.
- Chromium runs without its user-namespace sandbox (it would need `SYS_ADMIN`). Mitigated by `--no-sandbox` flag (already set in `apps/node-backend/src/services/reports/puppeteerRenderer.js`); container itself is the isolation boundary, and the combination of `no-new-privileges` + `cap_drop: ALL` + read-only fs + non-root user is a stronger trust posture than Chromium's own sandbox alone.
- CI runs Trivy on every push/PR — adds ~1–2 min per workflow.

### Neutral
- `db` (postgres) service is intentionally **not** hardened in this ADR. The official `postgres:18-alpine` image already runs as the `postgres` user, and aggressive hardening of the data-tier service risks data integrity issues with on-disk migrations. Revisit when moving to managed Postgres for prod.
- The dev compose override (`docker-compose.dev.yml`) only swaps the postgres data volume for `vision_postgres_data_dev`; all hardening on the `app` service inherits unchanged.

## Verification

Verified during implementation (all green):
- `docker exec vision-app-1 id` → `uid=1000(bun)`
- `grep CapEff /proc/self/status` → `0000000000000000`
- `touch /app/x` → `Read-only file system`
- `touch /tmp/x` → ok
- `touch /app/data/attachments/x` → ok (after pre-create + chown fix)
- `wget -qO- http://127.0.0.1:3002/health` → 200 from inside container and host
- `docker inspect --format '{{.State.Health.Status}}'` → `healthy` within ~30s
- Backend tests still green (no functional change).

## Related
- [[docs/adr/037-admin-auth-localhost-fallback|ADR-037 — admin auth localhost fallback]] (the prior network-exposure fix)
- [[docs/adr/038-dependency-slim-down-supply-chain-risk|ADR-038 — dependency slim-down]] (parallel supply-chain hardening)
- [[docs/security/index|Security policy index]]
- [[docs/adr/index|All ADRs]]
