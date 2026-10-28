---
title: Rate Limiting
type: security
status: active
date: 2026-10-28
updated: 2026-10-28
tags:
  - security
  - rate-limiting
  - ddos
  - socket-keyed
  - dev-mode
description: Rate limiting implementation to protect against abuse and ensure
  fair resource usage. June 2026 adds global baseline limiter on /api,
  socket-keyed buckets (no X-Forwarded-For trust since 2026-10-20), and VISION_DEV fail-safe dev bypass.
aliases:
  - rate limit
  - ddos protection
  - throttling
related_code:
  - apps/node-backend/src/middleware/rateLimiter.ts
  - apps/node-backend/src/routes/info.ts
  - apps/node-backend/src/routes/transactions.ts
  - apps/node-backend/src/routes/reports.ts
  - apps/node-backend/src/routes/marketLookup.ts
  - apps/node-backend/src/routes/investments.ts
  - apps/node-backend/src/routes/aggregations.ts
  - apps/node-backend/src/config/config.ts
  - apps/node-backend/src/config/env.ts
---

# Rate Limiting

Vision implements rate limiting to protect against abuse, DoS attacks, and to ensure fair resource usage across all clients.

## Overview

The rate limiter is implemented as Express middleware with configurable limits per endpoint. It uses an in-memory store for tracking requests.

## Implementation

### Global API Baseline Limiter (June 2026)

A new `globalRateLimiter` is now mounted on `/api` **before all routers** as a safety net against general API abuse:

```javascript
// Env-configurable: default 1000 req/min per IP
export const globalRateLimiter = rateLimiter({
  windowMs: env.RATE_LIMIT_GLOBAL_WINDOW_MS, // default 60_000
  maxRequests: env.RATE_LIMIT_GLOBAL_MAX, // default 1000
  keyPrefix: "global-api",
});

// Mounted in main.ts before all domain routers:
app.use("/api", globalRateLimiter, ...routers);
```

**Per-route limiters stack on top** — a request to `POST /api/import/csv` is counted against both `globalRateLimiter` (1000/min) and `importRateLimiter` (20/min). The per-route limit is always tighter.

The 1000 req/min default gives legitimate users ample headroom (the SPA makes 20–50 parallel requests on page load) while providing a hard ceiling against sustained scripted abuse or runaway loops.

Tune via [[docs/reference/environment-variables|environment variables]] `RATE_LIMIT_GLOBAL_MAX` and `RATE_LIMIT_GLOBAL_WINDOW_MS`.

### Global Rate Limiter (SPA Fallback Only)

Used only for serving `index.html` fallback in production (unchanged):

```javascript
// 600 requests per minute per IP
const spaLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 600,
  keyPrefix: "spa",
});

// Applied only to the SPA fallback route
app.get(/^(?!\/api)/, spaLimiter, (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(resolve(distPath, "index.html"));
});
```

### Per-Route Rate Limiters

#### Admin Rate Limiter

Permissive limits for read-heavy admin observability operations. The admin observability hub loads 5-6 parallel GETs on page load:

```javascript
// 500 requests per minute per IP
export const adminRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 500,
  keyPrefix: "admin",
});
```

Applied to `GET /api/admin/*` endpoints (observability hub reads).

#### Admin Mutate Limiter

Stricter limits for destructive admin operations:

```javascript
// 30 requests per minute per IP
export const adminMutateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "admin-mutate",
});
```

Applied to `POST /api/admin/*` endpoints (database reset, VACUUM, provider probes, Kinesis sanitization).

#### Import Rate Limiter

Restrictive for expensive import operations:

```javascript
// 20 requests per minute per IP
export const importRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  keyPrefix: "import",
});
```

Applied in `main.ts` with `app.use(IMPORT_RATE_LIMITED_PATHS, importRateLimiter)`, before the
`/api/import` and `/api/portfolio/import` routers. `IMPORT_RATE_LIMITED_PATHS`
([[apps/node-backend/src/middleware/rateLimiter.ts]]) covers only uploads and whole-batch commits.
These paths share one `import` bucket per client:

- `/api/import/csv` (including `/csv/custom` and `/csv/stream`), `/api/import/recipients`,
  `/api/import/categories`, and `/api/import/batches/:id/commit`
- `/api/portfolio/import/csv` (`/csv/custom`, `/csv/stream`), `/api/portfolio/import/probe`,
  `/api/portfolio/import/batches/:id/commit`, and `/api/portfolio/import/reconciliation/commit`

Since 2026-10-20, review and management traffic falls under `globalRateLimiter` only. That
covers batch preview reads, row recipient, category, and investment overrides, batch
list/detail/rollback, saved-parser CRUD, and reconciliation preview. Each review edit is a POST
plus a preview refetch, so the earlier router-wide 20/min limit returned `429` during group
assignments and quick review sessions. The scope is covered by
[[apps/node-backend/tests/importRateLimitScope.test.ts]].

#### Report Rate Limiter

Restrictive for report generation, which runs report aggregation queries and builds a full HTML document per request (PDF printing happens later in the Electron shell, ADR-234):

```javascript
// 30 requests per minute per IP
export const reportRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "reports",
});
```

Applied to all `/api/reports/*` endpoints (financial, portfolio, tax POST and legacy GET).

#### Market Rate Limiter

Bounds upstream Yahoo Finance API hammering:

```javascript
// 90 requests per minute per IP
export const marketRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 90,
  keyPrefix: "market",
});
```

Applied to `/api/market/*` endpoints (search, quote, chart, news).

#### Investment Rate Limiter

Allows active portfolio workflows; `refresh-prices` reaches external providers:

```javascript
// 300 requests per minute per IP
export const investmentRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 300,
  keyPrefix: "investments",
});
```

Applied to `/api/investments/*` endpoints.

#### Aggregation Rate Limiter

Permissive for GET-heavy dashboard/statistics endpoints; Monte-Carlo forecast endpoints are CPU-bound:

```javascript
// 600 requests per minute per IP
export const aggregationRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 600,
  keyPrefix: "aggregations",
});
```

Applied to `/api/aggregations/*` endpoints.

#### Attachment Rate Limiter

Restrictive for file upload and download operations:

```javascript
// 60 requests per minute per IP
export const attachmentRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
  keyPrefix: "attachment",
});
```

Applied to `POST /api/attachments/*` (uploads) and `GET /api/attachments/*/download` endpoints. Prevents attachment spam and abuse while allowing typical user workflows (multiple file operations).

#### SPA Rate Limiter

Permissive limit for static file serving (SPA fallback):

```javascript
// 600 requests per minute per IP
export const spaRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 600,
  keyPrefix: "spa",
});
```

Applied only to `GET /^(?!\/api)/` fallback route in production (serving `index.html` for non-API paths). High limit intentional — protects against filesystem abuse rather than API logic; legitimate SPA page reloads and prefetching should never hit this limit.

## Configuration

### Endpoint-Specific Rate Limits

Certain routes have additional custom rate limits beyond the global presets:

| Route group           | Limit   | Limiter                  | Reason                                                   |
| --------------------- | ------- | ------------------------ | -------------------------------------------------------- |
| `/api/reports/*`      | 30/min  | `reportRateLimiter`      | Bounds report aggregation and HTML document building     |
| `/api/market/*`       | 90/min  | `marketRateLimiter`      | Proxies Yahoo Finance; bounds upstream hammering         |
| `/api/investments/*`  | 300/min | `investmentRateLimiter`  | refresh-prices hits external providers                   |
| `/api/aggregations/*` | 600/min | `aggregationRateLimiter` | GET-heavy dashboard; Monte-Carlo endpoints are CPU-bound |

**Per-endpoint overrides (applied in addition to route-group limiters):**

| Endpoint                                | Limit  | Reason                                              |
| --------------------------------------- | ------ | --------------------------------------------------- |
| `POST /api/attachments/transaction/:id` | 60/min | File uploads; attachmentRateLimiter                 |
| `GET /api/attachments/transaction/:id`  | 60/min | List attachments; attachmentRateLimiter             |
| `GET /api/attachments/:id/download`     | 60/min | File downloads; attachmentRateLimiter               |
| `DELETE /api/attachments/:id`           | 60/min | Delete attachments; attachmentRateLimiter           |
| `PATCH /api/transactions/:id`           | 30/min | Database-heavy operation                            |
| `GET /api/transactions/export/csv`      | 30/min | Export is resource-intensive                        |
| `PATCH /api/planned-transactions/:id`   | 30/min | Database-heavy operation                            |
| `GET /api/info/exchange-rates`          | 30/min | External API calls                                  |
| `POST /api/info/refresh-views`          | 10/min | Administrative, expensive materialized-view refresh |

## Response Headers

All rate-limited responses include headers:

```
X-RateLimit-Limit: 200
X-RateLimit-Remaining: 199
X-RateLimit-Reset: 1647619200
```

## Rate Limited Response

When exceeded, returns `429 Too Many Requests`:

```json
{
  "ok": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Please try again later.",
    "details": { "retry_after": 45 }
  }
}
```

## Limitations

- **In-memory storage**: Rate limit data is lost on restart
- **Single instance**: Not suitable for multi-instance deployments
- **IP-based**: May affect users behind NAT/proxies

## Production Considerations

For production deployments:

1. **Use Redis**: Replace in-memory store with Redis for distributed rate limiting
2. **Consider API keys**: Token-based rate limiting for authenticated users
3. **Adjust limits**: Tune limits based on actual usage patterns

## See Also

- [[docs/security/index]] - Security Documentation Index
- [[docs/security/input-validation]] - Input Validation
- [[docs/api/index]] - API Index

## Test Coverage Notes (2026-04-10, Updated 2026-05-29)

Rate-limiter middleware behavior is covered by [[apps/node-backend/tests/rateLimiter.test.ts]], including:

- allow-under-limit and `429 Too Many Requests` over-limit behavior,
- rolling window reset behavior,
- the client key (`req.socket.remoteAddress`, then `unknown`), which ignores `X-Forwarded-For`,
- presets: `adminRateLimiter` (`500 req/min` for observability reads), `adminMutateLimiter` (`30 req/min` for destructive operations), `importRateLimiter` (`20 req/min`), `attachmentRateLimiter` (`60 req/min` for file operations), `spaRateLimiter` (`600 req/min` for SPA fallback serving), `reportRateLimiter` (`30 req/min` for report document generation), `marketRateLimiter` (`90 req/min` for Yahoo Finance proxy), `investmentRateLimiter` (`300 req/min` for external price providers), and `aggregationRateLimiter` (`600 req/min` for CPU-bound dashboard/forecast endpoints).

Related code: [[apps/node-backend/src/middleware/rateLimiter.ts]]

## Client key: the socket peer (2026-10-20)

Every bucket is keyed by `keyPrefix` plus `req.socket.remoteAddress`. `X-Forwarded-For` is never
read. The backend only listens on loopback with no proxy in front of it
([[docs/adr/233-loopback-only-backend|ADR-233]]), so the June 2026 `TRUSTED_PROXIES` setting and its
IPv4 CIDR matcher were removed. Limits per bucket are unchanged.

## Development Bypass (Fail-Safe, June 2026)

The dev-only rate-limit bypass is gated on the **explicit** env var `VISION_DEV=true`.

Previously, these bypasses activated whenever `ENVIRONMENT=development`, which could silently fire in any deployment that happened to set `NODE_ENV=development`. The new check is fail-safe: the default is disabled, and the backend `dev` npm script sets `VISION_DEV=true` automatically.

```javascript
// config.ts
isDev: process.env.VISION_DEV === 'true',

// rateLimiter.ts — skip check
if (config.isDev) return next();
```

> [!warning] Never set `VISION_DEV=true` in production. It disables all rate limiting.
