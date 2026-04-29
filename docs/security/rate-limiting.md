---
title: Rate Limiting
type: security
status: active
date: 2026-04-23
updated: 2026-04-29
tags:
  - security
  - rate-limiting
  - ddos
description: Rate limiting implementation to protect against abuse and ensure
  fair resource usage
aliases:
  - rate limit
  - ddos protection
  - throttling
related_code:
  - apps/node-backend/src/middleware/rateLimiter.js
  - apps/node-backend/src/routes/info.js
  - apps/node-backend/src/routes/transactions.js
---

# Rate Limiting

Vision implements rate limiting to protect against abuse, DoS attacks, and to ensure fair resource usage across all clients.

## Overview

The rate limiter is implemented as Express middleware with configurable limits per endpoint. It uses an in-memory store for tracking requests.

## Implementation

### Why No Global API Rate Limit?

Vision is a self-hosted single-user application. A global API rate limit only restricts the legitimate user's workflow. The SPA frontend makes 20-50 parallel requests on page load alone—a global 200 req/min limit would frequently trigger false positives.

**Instead:** Per-route limiters guard expensive and destructive operations (imports, admin actions), while the global limiter protects only the SPA fallback (production static file serving).

See [[#per-route-rate-limiters|Per-Route Rate Limiters]] for endpoint-specific protections.

### Global Rate Limiter (SPA Fallback Only)

Used only for serving `index.html` fallback in production:

```javascript
// 10,000 requests per minute per IP
const globalLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 10000, keyPrefix: 'global' });

// Applied only to the SPA fallback route
app.get(/^(?!\/api)/, globalLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(resolve(distPath, 'index.html'));
});
```

This high limit is intentional — it protects against filesystem abuse (not API logic), and legitimate SPA page reloads should never hit this limit.

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

## Test Coverage Notes (2026-04-10, Updated 2026-04-29)

Rate-limiter middleware behavior is covered by [[apps/node-backend/tests/rateLimiter.test.js]], including:
- allow-under-limit and `429 Too Many Requests` over-limit behavior,
- rolling window reset behavior,
- client IP key fallback order (`req.ip` → `remoteAddress` → `unknown`),
- presets: `adminRateLimiter` (`500 req/min` for observability reads), `adminMutateLimiter` (`30 req/min` for destructive operations), `importRateLimiter` (`20 req/min`), `attachmentRateLimiter` (`60 req/min` for file operations), and `spaRateLimiter` (`600 req/min` for SPA fallback serving).

Related code: [[apps/node-backend/src/middleware/rateLimiter.js]]
