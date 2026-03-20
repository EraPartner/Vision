---
title: Rate Limiting
type: security
status: active
date: 2025-03-18
tags: [security, rate-limiting, ddos]
description: Rate limiting implementation to protect against abuse and ensure fair resource usage
related_code: ["apps/node-backend/src/middleware/rateLimiter.js"]
---

# Rate Limiting

Vision implements rate limiting to protect against abuse, DoS attacks, and to ensure fair resource usage across all clients.

## Overview

The rate limiter is implemented as Express middleware with configurable limits per endpoint. It uses an in-memory store for tracking requests.

## Implementation

### Global Rate Limiter

Applied to all routes by default:

```javascript
// 200 requests per minute per IP
const globalLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 200, keyPrefix: 'global' });
```

### Admin Rate Limiter

Stricter limits for administrative operations:

```javascript
// 10 requests per minute per IP
export const adminRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 10, keyPrefix: 'admin' });
```

### Import Rate Limiter

Most restrictive for expensive import operations:

```javascript
// 5 requests per minute per IP
export const importRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 5, keyPrefix: 'import' });
```

## Configuration

### Per-Route Rate Limiters

Certain endpoints have custom rate limits:

| Endpoint | Limit | Reason |
|----------|-------|--------|
| `PATCH /api/transactions/:id` | 30/min | Database-heavy operation |
| `POST /api/transactions/export-csv` | 30/min | Export is resource-intensive |
| `PATCH /api/planned-transactions/:id` | 30/min | Database-heavy operation |
| `GET /api/info/exchange-rates` | 30/min | External API calls |

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
