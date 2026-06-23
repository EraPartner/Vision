---
title: Rate Limiting
type: security
status: active
date: 2026-04-23
updated: 2026-06-01
tags:
  - security
  - rate-limiting
  - ddos
  - trusted-proxies
  - xff
  - dev-mode
description: Rate limiting implementation to protect against abuse and ensure
  fair resource usage. June 2026 adds global baseline limiter on /api,
  explicit trusted-proxy XFF handling, and VISION_DEV fail-safe dev bypass.
aliases:
  - rate limit
  - ddos protection
  - throttling
related_code:
  - apps/node-backend/src/middleware/rateLimiter.js
  - apps/node-backend/src/routes/info.js
  - apps/node-backend/src/routes/transactions.js
  - apps/node-backend/src/routes/reports.js
  - apps/node-backend/src/routes/marketLookup.js
  - apps/node-backend/src/routes/investments.js
  - apps/node-backend/src/routes/aggregations.js
  - apps/node-backend/src/config/config.js
  - apps/node-backend/src/config/env.js
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
  windowMs: env.RATE_LIMIT_GLOBAL_WINDOW_MS,  // default 60_000
  maxRequests: env.RATE_LIMIT_GLOBAL_MAX,       // default 1000
  keyPrefix: 'global-api',
});

// Mounted in main.js before all domain routers:
app.use('/api', globalRateLimiter, ...routers);
```

**Per-route limiters stack on top** — a request to `POST /api/import/csv` is counted against both `globalRateLimiter` (1000/min) and `importRateLimiter` (20/min). The per-route limit is always tighter.

The 1000 req/min default gives legitimate users ample headroom (the SPA makes 20–50 parallel requests on page load) while providing a hard ceiling against sustained scripted abuse or runaway loops.

Tune via [[docs/reference/environment-variables|environment variables]] `RATE_LIMIT_GLOBAL_MAX` and `RATE_LIMIT_GLOBAL_WINDOW_MS`.

### Global Rate Limiter (SPA Fallback Only)

Used only for serving `index.html` fallback in production (unchanged):

```javascript
// 600 requests per minute per IP
const spaLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 600, keyPrefix: 'spa' });

// Applied only to the SPA fallback route
app.get(/^(?!\/api)/, spaLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(resolve(distPath, 'index.html'));
});
```

### Per-Route Rate Limiters

#### Admin Rate Limiter

Permissive limits for read-heavy admin observability operations. The admin observability hub loads 5-6 parallel GETs on page load:

```javascript
// 500 requests per minute per IP
export const adminRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 500, keyPrefix: 'admin' });
```

Applied to `GET /api/admin/*` endpoints (observability hub reads).

#### Admin Mutate Limiter

Stricter limits for destructive admin operations:

```javascript
// 30 requests per minute per IP
export const adminMutateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'admin-mutate' });
```

Applied to `POST /api/admin/*` endpoints (database reset, VACUUM, provider probes, Kinesis sanitization).

#### Import Rate Limiter

Restrictive for expensive import operations:

```javascript
// 20 requests per minute per IP
export const importRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 20, keyPrefix: 'import' });
```

Applied to `POST /api/import/*` endpoints.

#### Report Rate Limiter

Restrictive for Puppeteer/Chromium PDF render, which forks a headless Chrome process — prevents fork-bomb scenarios:

```javascript
// 30 requests per minute per IP
export const reportRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'reports' });
```

Applied to all `/api/reports/*` endpoints (financial, portfolio, tax POST and legacy GET).

#### Market Rate Limiter

Bounds upstream Yahoo Finance API hammering:

```javascript
// 90 requests per minute per IP
export const marketRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 90, keyPrefix: 'market' });
```

Applied to `/api/market/*` endpoints (search, quote, chart, news).

#### Investment Rate Limiter

Allows active portfolio workflows; `refresh-prices` reaches external providers:

```javascript
// 300 requests per minute per IP
export const investmentRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 300, keyPrefix: 'investments' });
```

Applied to `/api/investments/*` endpoints.

#### Aggregation Rate Limiter

Permissive for GET-heavy dashboard/statistics endpoints; Monte-Carlo forecast endpoints are CPU-bound:

```javascript
// 600 requests per minute per IP
export const aggregationRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 600, keyPrefix: 'aggregations' });
```

Applied to `/api/aggregations/*` endpoints.

#### Attachment Rate Limiter

Restrictive for file upload and download operations:

```javascript
// 60 requests per minute per IP
export const attachmentRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 60, keyPrefix: 'attachment' });
```

Applied to `POST /api/attachments/*` (uploads) and `GET /api/attachments/*/download` endpoints. Prevents attachment spam and abuse while allowing typical user workflows (multiple file operations).

#### SPA Rate Limiter

Permissive limit for static file serving (SPA fallback):

```javascript
// 600 requests per minute per IP
export const spaRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 600, keyPrefix: 'spa' });
```

Applied only to `GET /^(?!\/api)/` fallback route in production (serving `index.html` for non-API paths). High limit intentional — protects against filesystem abuse rather than API logic; legitimate SPA page reloads and prefetching should never hit this limit.

## Configuration

### Endpoint-Specific Rate Limits

Certain routes have additional custom rate limits beyond the global presets:

| Route group | Limit | Limiter | Reason |
|-------------|-------|---------|--------|
| `/api/reports/*` | 30/min | `reportRateLimiter` | Puppeteer forks headless Chrome; prevents fork-bomb |
| `/api/market/*` | 90/min | `marketRateLimiter` | Proxies Yahoo Finance; bounds upstream hammering |
| `/api/investments/*` | 300/min | `investmentRateLimiter` | refresh-prices hits external providers |
| `/api/aggregations/*` | 600/min | `aggregationRateLimiter` | GET-heavy dashboard; Monte-Carlo endpoints are CPU-bound |

**Per-endpoint overrides (applied in addition to route-group limiters):**

| Endpoint | Limit | Reason |
|----------|-------|--------|
| `POST /api/attachments/transaction/:id` | 60/min | File uploads; attachmentRateLimiter |
| `GET /api/attachments/transaction/:id` | 60/min | List attachments; attachmentRateLimiter |
| `GET /api/attachments/:id/download` | 60/min | File downloads; attachmentRateLimiter |
| `DELETE /api/attachments/:id` | 60/min | Delete attachments; attachmentRateLimiter |
| `PATCH /api/transactions/:id` | 30/min | Database-heavy operation |
| `GET /api/transactions/export/csv` | 30/min | Export is resource-intensive |
| `PATCH /api/planned-transactions/:id` | 30/min | Database-heavy operation |
| `GET /api/info/exchange-rates` | 30/min | External API calls |
| `POST /api/info/refresh-views` | 10/min | Administrative, expensive materialized-view refresh |

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
  "detail": "Too many requests. Please try again later.",
  "retry_after": 45
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

Rate-limiter middleware behavior is covered by [[apps/node-backend/tests/rateLimiter.test.js]], including:
- allow-under-limit and `429 Too Many Requests` over-limit behavior,
- rolling window reset behavior,
- client IP key fallback order (`req.ip` → `remoteAddress` → `unknown`),
- presets: `adminRateLimiter` (`500 req/min` for observability reads), `adminMutateLimiter` (`30 req/min` for destructive operations), `importRateLimiter` (`20 req/min`), `attachmentRateLimiter` (`60 req/min` for file operations), `spaRateLimiter` (`600 req/min` for SPA fallback serving), `reportRateLimiter` (`30 req/min` for Puppeteer render), `marketRateLimiter` (`90 req/min` for Yahoo Finance proxy), `investmentRateLimiter` (`300 req/min` for external price providers), and `aggregationRateLimiter` (`600 req/min` for CPU-bound dashboard/forecast endpoints).

Related code: [[apps/node-backend/src/middleware/rateLimiter.js]]

## X-Forwarded-For / Trusted Proxies (June 2026)

Previously, the rate limiter derived the client IP from `X-Forwarded-For` without validation, allowing a hostile client to spoof any IP and bypass per-IP limits.

The `rateLimiter.js` module now exports an `ipMatchesRule(ip, rule)` helper and gates XFF trust on the `TRUSTED_PROXIES` env var:

```javascript
// config.js
trustedProxies: (process.env.TRUSTED_PROXIES ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean),

// rateLimiter.js
function resolveClientIp(req) {
  const socketIp = req.socket?.remoteAddress ?? 'unknown';
  const xff = req.headers['x-forwarded-for'];
  if (!xff || trustedProxies.length === 0) return socketIp;
  // Only trust XFF when the request came through a known proxy
  if (trustedProxies.some(rule => ipMatchesRule(socketIp, rule))) {
    return xff.split(',')[0].trim();
  }
  return socketIp;
}
```

**Default behavior (no `TRUSTED_PROXIES` set):** Client IP is always the raw socket address. XFF headers are ignored. Correct for direct-to-container deployments (standard Docker self-hosting).

**Behind a reverse proxy:** Set `TRUSTED_PROXIES` to your proxy's IP or CIDR (e.g. `192.168.1.1` or `10.0.0.0/8`). See [[docs/reference/environment-variables|environment variables]].

## Development Bypass (Fail-Safe, June 2026)

Dev-only bypasses — rate-limit skipping and wildcard CORS reflection — are now gated on the **explicit** env var `VISION_DEV=true`.

Previously, these bypasses activated whenever `ENVIRONMENT=development`, which could silently fire in any deployment that happened to set `NODE_ENV=development`. The new check is fail-safe: the default is disabled, and the backend `dev` npm script sets `VISION_DEV=true` automatically.

```javascript
// config.js
isDev: process.env.VISION_DEV === 'true',

// rateLimiter.js — skip check
if (config.isDev) return next();

// main.js — CORS reflection (dev only)
if (config.isDev) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
}
```

> [!warning] Never set `VISION_DEV=true` in production. It disables all rate limiting and opens CORS reflection.
