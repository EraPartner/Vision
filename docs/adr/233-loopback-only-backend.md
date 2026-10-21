---
title: "ADR-233: Loopback-only backend"
type: adr
status: accepted
date: 2026-10-20
tags: [adr, security, loopback, csrf, host-guard, dns-rebinding, cors, admin-auth, rate-limiting, cleanup, adr-063]
description: "Accepted on 2026-10-20. The backend only ever serves the same machine: startup refuses a non-loopback bind, the Host allowlist is fixed to localhost, 127.0.0.1 and ::1 with the backend port, and the CSRF guard's Origin fallback accepts only the backend's own loopback origins. The Docker/LAN/browser-deployment leftovers are removed: the ADMIN_AUTH_TOKEN bearer check and its admin UI, CORS and CORS_ORIGINS, SERVER_ALLOWED_HOSTS, TRUSTED_PROXIES with its CIDR matcher, the gzip middleware, the HSTS header, the HOSTNAME bind fallback, VISION_VITE_BIND_HOST and the role-bootstrap connect retry. Supersedes the admin token of ADR-063."
aliases: [adr-233, loopback-only backend, remove admin token, remove cors]
related_code:
  [
    "apps/node-backend/src/main.ts",
    "apps/node-backend/src/middleware/hostGuard.ts",
    "apps/node-backend/src/middleware/csrfGuard.ts",
    "apps/node-backend/src/middleware/rateLimiter.ts",
    "apps/node-backend/src/config/env.ts",
    "apps/node-backend/src/database/roleBootstrap.ts",
    "apps/frontend/src/lib/api/client.ts",
    "apps/frontend/vite.config.ts",
    "packaging/electron/runtime/native.ts",
    "packaging/electron/scripts/native-development.ts",
  ]
---

# ADR-233: Loopback-only backend

## Status

Accepted on 2026-10-20. Supersedes the `ADMIN_AUTH_TOKEN` bearer check of
[[docs/adr/063-admin-auth-csrf-guard|ADR-063]]; its CSRF guard stays in force. The older
[[docs/adr/037-admin-auth-localhost-fallback|ADR-037]] was already superseded by ADR-063.
[[docs/adr/077-devcontainer-apple-container-runtime|ADR-077]] still read "Accepted" although
[[docs/adr/176-built-in-agent-sandboxes|ADR-176]] had retired the agent container; its status is
corrected to superseded by ADR-176. The `ADMIN_AUTH_TOKEN` passthrough recorded in
[[docs/adr/113-native-macos-runtime|ADR-113]] no longer exists.

## Date

2026-10-20

## Context

Vision is a single-user, macOS-only desktop app. The packaged backend binds `127.0.0.1`
(`packaging/electron/runtime/native.ts`), the renderer loads the backend's own origin, and
development serves the frontend through the Vite proxy. Docker, compose, reverse-proxy, LAN and
browser deployments are gone ([[docs/adr/133-native-only-runtime-and-delivery|ADR-133]]). Several
mechanisms only made sense for those deployments and were still in the code:

- an optional `ADMIN_AUTH_TOKEN` bearer check on `/api/admin/*`, a startup gate with an
  `ADMIN_ALLOW_TOKENLESS_NONLOOPBACK` override, a session-token card on the admin overview and an
  `Authorization` header in the frontend API client;
- a CORS middleware with `CORS_ORIGINS`, which the CSRF guard also used as its Origin allowlist;
- `SERVER_ALLOWED_HOSTS` and duplicate-Host detection for proxies in the Host guard;
- `TRUSTED_PROXIES` with an IPv4 CIDR matcher for `X-Forwarded-For` rate-limit keying;
- a hand-rolled gzip middleware for a client on the same machine;
- an HSTS header on a plain-HTTP loopback listener;
- a `HOSTNAME` fallback for the bind host, a variable that container runtimes export;
- `VISION_VITE_BIND_HOST`, which let containers bind the Vite dev server to a wildcard;
- a 40-attempt connect retry in the role bootstrap that waited for a cold-starting compose
  database.

The development launcher also pointed the browser's API calls straight at the backend
(`VITE_API_URL=http://127.0.0.1:<port>` from a page on `127.0.0.1:8080`), a cross-origin pattern
that depended on CORS and that the CSRF guard rejects for state-changing requests as `same-site`.

Each removal below was checked for remaining use with repository-wide searches across `apps/`,
`packages/`, `packaging/`, `scripts/`, `.github/workflows` and the `package.json` scripts.

## Decision

The backend serves only the machine it runs on.

- **Bind gate.** `start()` in `main.ts` exits before listening when `SERVER_HOST` is not loopback
  (`127.0.0.0/8`, `::1`, `localhost`; `isLoopbackHost()` now lives in `middleware/hostGuard.ts`).
  There is no override. `SERVER_HOST` defaults to `localhost`; `HOSTNAME` is no longer read.
- **Host guard.** The allowlist is fixed: `localhost`, `127.0.0.1` and `::1`, plus the loopback
  bind address when spelled differently. The `Host` header must also name the backend port. IP
  spellings are canonicalized before matching. A foreign Host, including a DNS-rebinding name,
  still receives 403 before any parsing or route. `SERVER_ALLOWED_HOSTS` and the duplicate-Host
  wire check are removed.
- **CSRF guard.** Unchanged strategy, including that safe methods (GET, HEAD, OPTIONS) pass. When
  `Sec-Fetch-Site` is absent, a present `Origin` must be one of `http://localhost:PORT`,
  `http://127.0.0.1:PORT` or `http://[::1]:PORT`; outside production the Vite dev server's
  loopback origins on port 8080 are accepted too (`loopbackOrigins()`). The wildcard branch is
  gone.
- **No CORS.** `middleware/cors.ts` and `CORS_ORIGINS` are removed. The backend sends no
  `Access-Control-*` headers and no longer answers every `OPTIONS` with 204.
- **No admin token.** `middleware/adminAuth.ts`, `ADMIN_AUTH_TOKEN`,
  `ADMIN_ALLOW_TOKENLESS_NONLOOPBACK`, the startup info line about the token, the frontend
  `lib/adminToken.ts`, the `Authorization` header, the admin-token card, the token prompt in
  `AdminErrorState` and their eleven `admin.token.*`/`admin.authError.*` strings are removed. The
  Electron runtime no longer forwards `ADMIN_AUTH_TOKEN`. The admin routes are unchanged.
- **Rate limiting.** Buckets are keyed by `req.socket.remoteAddress`; `X-Forwarded-For`,
  `TRUSTED_PROXIES` and the CIDR matcher are removed. Limits per bucket are unchanged.
- **Transport.** The gzip middleware and the HSTS header are removed; CSP and the frame,
  content-type, referrer and permissions headers stay.
- **Development is same-origin.** The browser always calls the page origin (`API_BASE_URL` falls
  back to `http://localhost:3002` only under Vitest). `bun run dev` sets `VISION_DEV_API_TARGET`
  for the Vite proxy instead of `VITE_API_URL`, and the dev server always binds `127.0.0.1`.
- **Role bootstrap.** The privileged connect is a single attempt. The native runtime runs
  `pg_isready` before it spawns the backend (`ensurePostgresReady()` inside `bootstrapDatabase()`),
  and CI starts PostgreSQL with `pg_ctl -w` before the backend. A failure is logged and the
  bootstrap is skipped, as before; role and grant semantics are unchanged.

## Consequences

- A source backend started with a non-loopback `SERVER_HOST` (for example `0.0.0.0`) now exits.
  There is no supported way to reach the API from another machine.
- A request whose `Host` names another port, or no port, is rejected. Clients on the same machine
  must use the backend's own port, as the packaged app, the Vite proxy (`changeOrigin: true`) and
  CI health checks already do.
- Old browsers without `Sec-Fetch-Site` can no longer POST from an Origin that was only allowed by
  the old default CORS list (`http://localhost:5174` anywhere, `http://localhost:8080` in
  production). A Vite dev server that moved off port 8080
  is accepted only through `Sec-Fetch-Site`, which every supported browser sends.
- Cross-site GET requests still execute (the response cannot be read without CORS). Whether the
  CSRF guard should also cover safe methods is a separate, open decision.
- An `ADMIN_AUTH_TOKEN` left in an existing `.env` or native runtime file is ignored. No admin
  response is `401` any more.
- API responses are no longer gzip-compressed. Over loopback this costs nothing measurable.
- If PostgreSQL is not accepting connections when a three-role source backend starts, the role
  bootstrap no longer waits for it; start PostgreSQL first.
- The SSE `X-Accel-Buffering: no` header (an nginx hint) and the web manifest and `robots.txt` in
  `apps/frontend/public/` remain. They are harmless and outside this decision.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/063-admin-auth-csrf-guard|ADR-063]]
- [[docs/adr/133-native-only-runtime-and-delivery|ADR-133]]
- [[docs/security/data-protection|Data Protection]]
- [[docs/security/rate-limiting|Rate Limiting]]
- [[docs/guides/deployment|Deployment Guide]]
- [[docs/reference/environment-variables|Environment Variables]]
- [[docs/api/admin|Admin API]]
