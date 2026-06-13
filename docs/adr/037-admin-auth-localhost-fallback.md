---
title: Admin Auth Localhost Fallback
type: adr
status: superseded
date: 2026-04-25
updated: 2026-05-29
tags: [adr, security, admin-auth, localhost, private-network, docker, backward-compatibility, phase-sweep-12-fixes, superseded]
description: SUPERSEDED by ADR-063. When ADMIN_AUTH_TOKEN is unset, restrict admin routes to loopback and private network addresses (RFC 1918 + IPv6 ULA) in combination with docker-compose port binding to 127.0.0.1. Replaced by token-or-open + CSRF guard (ADR-063) which removes the over-broad RFC1918 trust.
aliases: [admin localhost bind, admin auth fallback, localhost restriction, private-ip trust]
---

# ADR-037: Admin Auth Localhost Fallback

## Status

**Superseded** — 2026-05-29 by [[docs/adr/063-admin-auth-csrf-guard|ADR-063: Admin Auth Token-or-Open + CSRF Guard]]

> [!warning] This ADR is superseded
> The RFC1918 IP-allowlist fallback described here has been replaced. `adminAuth.js` no longer performs any IP check; it is now token-or-open. Cross-site browser requests are blocked by the new `csrfGuard.js` middleware (`Sec-Fetch-Site` + `Origin` allowlist). See [[docs/adr/063-admin-auth-csrf-guard|ADR-063]] for the current behaviour.

**Originally Accepted** — 2026-04-25

## Date
2026-04-25

## Context

The Vision admin API (`/api/admin/*`) originally required either:
1. An `ADMIN_AUTH_TOKEN` environment variable (Bearer token enforcement), OR
2. No protection at all (legacy open mode)

In self-hosted deployments where network isolation is assumed, administrators often do not set `ADMIN_AUTH_TOKEN`, leaving the admin API completely open. This exposes dangerous operations (database reset, provider probes, VACUUM) to any HTTP client.

Even in trusted networks, unprotected access to admin endpoints violates defense-in-depth principles. The solution is a **localhost-only fallback** that requires network-level isolation without explicit token configuration.

## Decision

When `ADMIN_AUTH_TOKEN` is empty or unset:
- **Allow** requests from loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) AND RFC 1918 private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) AND IPv6 ULA (fc00::/7)
- **Reject** all other requests with HTTP `401 Unauthorized`
- No changes to behavior when `ADMIN_AUTH_TOKEN` is configured (Bearer token check remains unchanged)

The expansion to private IP ranges is safe because Docker Compose binds the host port to `127.0.0.1` only (`"127.0.0.1:${PORT:-3002}:3002"`), ensuring no LAN device can reach the container directly. Docker bridge traffic arrives with a private source IP (e.g., 172.x.x.x), so trusting private ranges allows local Docker-to-container communication while still blocking external access.

This requires:
1. Express trust-proxy configuration (`app.set('trust proxy', 1)`) to correctly read `X-Forwarded-For` headers in containerized deployments
2. Documenting the requirement in both code comments and environment variable docs
3. Clear error messaging (generic "Unauthorized" to avoid leaking network topology)
4. WARNING: If the host port mapping is changed back to `0.0.0.0`, LAN devices would also pass the private-IP check. Set `ADMIN_AUTH_TOKEN` in that case.

## Consequences

### Positive

- **Prevents accidental exposure** — Unprotected admin endpoints are now inaccessible from the network
- **Backward compatible** — Existing deployments with `ADMIN_AUTH_TOKEN` set are unaffected
- **Zero configuration** — Self-hosted users who trust their network don't need to generate/manage tokens
- **Defense in depth** — Network isolation is still enforced even if one layer is misconfigured

### Negative

- **Trust proxy requirement** — Administrators must ensure `trust proxy` is set correctly in containerized/reverse-proxy deployments (e.g., Nginx, Caddy). Misconfiguration bypasses this guard.
- **Port binding dependency** — Security relies on docker-compose binding to `127.0.0.1:${PORT}:3002` (loopback-only on host). If this binding is changed to `0.0.0.0:${PORT}:3002`, the private-IP check becomes insufficient and `ADMIN_AUTH_TOKEN` must be set.
- **IPv6 edge case** — IPv6-mapped IPv4 addresses (`::ffff:127.0.0.1`) must be explicitly allowed; some edge cases with IPv6 link-local addresses are not covered
- **Documentation burden** — Admins must understand that removing `ADMIN_AUTH_TOKEN` does not make endpoints "open" but "private-network-restricted" when bound to 127.0.0.1

### Notes on Trust Proxy & Port Binding

Two configuration elements are critical to security:

#### 1. Express Trust Proxy
```js
app.set('trust proxy', 1);  // Required for correct X-Forwarded-For reading
```

If not set, `req.ip` will always be the direct TCP peer (the reverse proxy's IP, not the client's), and the private-IP check will always fail. This is not a security vulnerability per se (requests are still blocked), but it prevents legitimate local admin access through a reverse proxy.

#### 2. Docker Compose Port Binding
```yaml
# In docker-compose.yml
ports:
  - "127.0.0.1:${PORT:-3002}:3002"  # CORRECT: Loopback bind
```

The loopback bind (`127.0.0.1`) ensures that only the host machine can reach the container's port. Docker's bridge network (172.x.x.x) can still reach the backend because it's internal to the host's Docker daemon. If changed to `"${PORT:-3002}:3002"` or `"0.0.0.0:${PORT:-3002}:3002"`, any machine on the LAN would be able to reach the port, and the private-IP fallback check becomes insufficient. In such cases, `ADMIN_AUTH_TOKEN` must be set.

**Testing requirement:** Deployments using reverse proxies (Docker, Kubernetes, Nginx) must verify that admin endpoints are still accessible from localhost via the proxy AND that the port binding is correctly restricted to 127.0.0.1.

## Related

- [[docker-compose.yml]] — Port binding to `127.0.0.1` is critical to security posture
- [[docs/api/admin|Admin API Documentation]] — Updated to document private-IP-range trust and `trust proxy` requirement
- [[docs/reference/environment-variables|Environment Variables]] — Updated `ADMIN_AUTH_TOKEN` description with trust-proxy and port-binding warnings
- [[apps/node-backend/src/middleware/adminAuth.js|adminAuth middleware]] — Implementation (isLocalNetworkRequest: loopback + RFC 1918 + IPv6 ULA)
- [[apps/node-backend/src/main.js|main.js]] — Express app setup with `trust proxy`

## Versioning Impact

- **No API contract change** — Existing `ADMIN_AUTH_TOKEN` behavior unchanged
- **Security posture improvement** — Deployments without explicit token config now protected by default
- **Migration path** — No action required; deployments with tokens are unaffected
