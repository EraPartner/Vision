---
title: Admin Auth Token-or-Open + CSRF Guard
type: adr
status: accepted
date: 2026-05-29
updated: 2026-05-29
tags: [adr, security, admin-auth, csrf, sec-fetch-site, cors, bearer-token, loopback, docker, 2026-05-29]
description: Replace RFC1918 IP-allowlist admin fallback with token-or-open + CSRF guard. When ADMIN_AUTH_TOKEN is set, enforce timing-safe Bearer; when unset, rely on the loopback port binding and a new Sec-Fetch-Site/Origin CSRF guard mounted on /api/admin.
aliases: [admin csrf guard, csrf guard, admin auth 2026, token-or-open]
---

# ADR-063: Admin Auth Token-or-Open + CSRF Guard

## Status

**Accepted** — 2026-05-29  
**Supersedes** [[docs/adr/037-admin-auth-localhost-fallback|ADR-037]] (RFC1918 IP-allowlist fallback)

## Context

ADR-037 introduced a fallback for `ADMIN_AUTH_TOKEN`-absent deployments: allow admin requests from loopback AND all RFC1918 / IPv6 ULA addresses. The audit (codebase-audit-2026-05 finding `security.2`) identified this as over-broad: the entire private address space is trusted, not just loopback. A bare-metal or compose-override deployment where the port is exposed on `0.0.0.0` would give every LAN device unauthenticated admin access. Additionally, an RFC1918 IP check provides no defence against browser-initiated cross-site requests that originate from the loopback address itself — a malicious web page can `fetch('http://localhost:3002/api/admin/database/reset', { method: 'POST' })` and CORS only hides the response; the request executes.

## Decision

Two coordinated changes replace ADR-037's fallback:

### 1. `adminAuth.js` — Token-or-Open

`createAdminAuthMiddleware` no longer performs any IP check:

- When `ADMIN_AUTH_TOKEN` is set: require a timing-safe `Authorization: Bearer <token>` header; reject with 401 on mismatch or absence.
- When `ADMIN_AUTH_TOKEN` is unset: call `next()` immediately. Protection is then fully delegated to (a) the loopback-only docker-compose port binding and (b) the CSRF guard below.

A startup warning is emitted in `main.js` when the token is absent, instructing operators to set `ADMIN_AUTH_TOKEN` if the port is published on `0.0.0.0`.

### 2. `csrfGuard.js` — `createCsrfGuard`

New middleware, mounted on `/api/admin` in `main.js` before `adminAuthMiddleware`:

```
mountRouter(app, '/api/admin', adminRateLimiter, adminCsrfGuard, adminAuthMiddleware, adminRouter);
```

Strategy (zero-config, no tokens/cookies):

- Safe methods (`GET`, `HEAD`, `OPTIONS`) are always allowed.
- `Sec-Fetch-Site` (sent by all current browsers) is authoritative:
  - `same-origin` or `none` (user-typed URL, curl, Electron IPC): allow.
  - `same-site` or `cross-site`: block with 403 `ForbiddenError`.
- Fallback when `Sec-Fetch-Site` is absent (older browsers, non-browser clients):
  - If `Origin` header is present: it must be in the CORS allowlist (`settings.api.corsOrigins`); absent-from-allowlist origin → 403.
  - If `Origin` header is absent: allow (non-browser client such as curl or server-to-server).

The guard rejects cross-site state-changing requests that `CORS` alone would not stop.

## Consequences

### Positive

- **Eliminates the RFC1918 blind spot** — No longer trusts the entire private address space; protection relies on the well-defined loopback binding, not IP range heuristics.
- **Stops browser CSRF** — A malicious web page cannot trigger `POST /api/admin/database/reset` from a user's browser; `Sec-Fetch-Site: cross-site` is blocked before the request body executes.
- **No tokens/cookies needed** — The guard is stateless and works with the existing cookie-free architecture.
- **Non-browser clients unaffected** — `curl`, server-to-server calls, and the Electron main process (which sends no `Sec-Fetch-Site`) continue to work.

### Negative

- **No IP-range fallback** — Deployments that previously relied on RFC1918 trust without a token must either set `ADMIN_AUTH_TOKEN` or accept that admin routes are fully open within the loopback boundary. The startup warning makes this explicit.
- **Browser compatibility caveat** — `Sec-Fetch-Site` is supported in all current browsers (Chrome 76+, Firefox 90+, Safari 16.4+). Very old browser/WebKit versions fall through to the `Origin` allowlist path, which is still robust.
- **Port-binding dependency unchanged** — Security without a token still depends on docker-compose binding to `127.0.0.1:PORT`. If changed to `0.0.0.0`, `ADMIN_AUTH_TOKEN` must be set.

## Migration from ADR-037

Deployments that relied on ADR-037's RFC1918 fallback (no token, private LAN access) will see that LAN access revoked. The admin endpoints are now open only from within the loopback boundary unless a token is configured. Operators who need LAN admin access must set `ADMIN_AUTH_TOKEN`.

## Related

- [[docs/adr/037-admin-auth-localhost-fallback|ADR-037]] — Superseded: RFC1918 + loopback IP-allowlist fallback
- [[docs/api/admin|Admin API]] — Endpoint docs (update auth model section)
- [[docs/security/data-protection|Data Protection]] — Admin bearer token timing-safe comparison
- [[docs/security/index|Security index]]
- [[docs/reference/environment-variables|Environment Variables]] — `ADMIN_AUTH_TOKEN` description
- [[apps/node-backend/src/middleware/adminAuth.js]] — Implementation
- [[apps/node-backend/src/middleware/csrfGuard.js]] — CSRF guard implementation
- [[apps/node-backend/src/main.js]] — Mount order: `adminCsrfGuard` before `adminAuthMiddleware`
- [[docs/reference/codebase-audit-2026-05|Codebase Audit May 2026]] — Finding `security.2` (over-broad RFC1918 trust)
