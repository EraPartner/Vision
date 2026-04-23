---
title: Rate Limiting
type: security
status: active
date: 2026-04-23
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

Stricter limits for administrative operations:

```javascript
// 10 requests per minute per IP
export const adminRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 10, keyPrefix: 'admin' });
```

Applied to `POST /api/admin/*` endpoints.

#### Import Rate Limiter

Most restrictive for expensive import operations:

```javascript
// 5 requests per minute per IP
export const importRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 5, keyPrefix: 'import' });
```

Applied to `POST /api/import/*` endpoints.

## Configuration

### Endpoint-Specific Rate Limits

Certain routes have additional custom rate limits beyond the three global presets:

| Endpoint | Limit | Reason |
|----------|-------|--------|
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

## Test Coverage Notes (2026-04-10)

Rate-limiter middleware behavior is covered by [[apps/node-backend/tests/rateLimiter.test.js]], including:
- allow-under-limit and `429 Too Many Requests` over-limit behavior,
- rolling window reset behavior,
- client IP key fallback order (`req.ip` → `remoteAddress` → `unknown`),
- stricter presets: `adminRateLimiter` (`10 req/min`) and `importRateLimiter` (`5 req/min`).

Related code: [[apps/node-backend/src/middleware/rateLimiter.js]]
