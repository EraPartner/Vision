---
title: Security - Data Protection & CSP
type: security
status: active
date: 2026-04-02
tags: [security, csp, data-protection, privacy, content-security-policy]
description: Content Security Policy, data protection, and privacy considerations for Vision
aliases: [CSP, data protection, privacy, content security policy, security headers]
related_code: ["apps/node-backend/src/main.js", "apps/frontend/src/lib/api.ts"]
---

# Security: Data Protection & CSP

## Overview

Vision is a desktop-first financial application handling sensitive financial data. This document covers data protection, Content Security Policy, and privacy considerations.

---

## Content Security Policy (CSP)

### Backend Configuration

The Express server sets CSP headers in `main.js`:

```javascript
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https:",
    "font-src 'self'",
    "connect-src 'self' http://localhost:*",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});
```

### Key Directives

| Directive | Value | Rationale |
|-----------|-------|-----------|
| `default-src` | `'self'` | Only load resources from same origin |
| `script-src` | `'self'` | No inline scripts, no external scripts |
| `style-src` | `'self' 'unsafe-inline'` | Tailwind requires inline styles |
| `img-src` | `'self' https:` | Allow remote HTTPS images (news thumbnails) |
| `connect-src` | `'self' http://localhost:*` | Only connect to local backend |
| `frame-ancestors` | `'none'` | Prevent clickjacking |

### News Image Exception

Market lookup news cards display remote HTTPS thumbnails. The CSP `img-src 'self' https:` allows this while restricting other resource types.

---

## Security Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Frame-Options` | `DENY` | Prevent iframe embedding |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `X-XSS-Protection` | `1; mode=block` | XSS filter |
| `Strict-Transport-Security` | `max-age=31536000` | HSTS (production only) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limit referrer info |

---

## Input Validation

### Frontend (Zod)

All form inputs are validated with Zod schemas before submission:

```typescript
import { z } from 'zod';

const transactionSchema = z.object({
  date: z.string().date(),
  amount: z.number(),
  recipient_id: z.number().positive(),
  category_id: z.number().positive().optional(),
  memo: z.string().max(500).optional(),
});
```

### Backend (Middleware)

Request validation middleware validates:
- ID parameters (positive integers)
- Date formats (ISO 8601)
- Amount ranges
- Required fields

**Location:** [[apps/node-backend/src/middleware/validation.js]]

---

## SQL Injection Prevention

All database queries use **parameterized queries**:

```javascript
// ✅ Safe
await query('SELECT * FROM transactions WHERE id = $1', [id]);

// ❌ Never do this
await query(`SELECT * FROM transactions WHERE id = ${id}`);
```

### Repository Convention

- Positional parameters (`$1`, `$2`, ...)
- Manual parameter index tracking
- No string concatenation in SQL

---

## Rate Limiting

### Global Rate Limiter

Applied to all routes as a baseline protection.

### Per-Route Limiters

| Endpoint | Limit | Reason |
|----------|-------|--------|
| `GET /api/transactions/export/csv` | 30 req/min | Expensive operation |
| `PATCH /api/transactions/:id` | 30 req/min | Prevent abuse |
| `GET /api/info/net-worth` | 30 req/min | Expensive computation |
| `GET /api/info/exchange-rates` | 30 req/min | External API calls |
| `POST /api/info/exchange-rates/refresh` | Admin only | Admin operation |

**Location:** [[apps/node-backend/src/middleware/rateLimiter.js]]

---

## Data Protection

### Local-First Architecture

By default, Vision stores all data locally:
- **Database:** Local PostgreSQL instance
- **Backend:** Local Node.js process
- **Frontend:** Local Chromium instance

No data is transmitted externally except:
- Price provider API calls (binance, yahoo, kinesis)
- Exchange rate fetching (ECB, open.er-api)
- Inflation data (Statbel, Eurostat)
- Market lookup data (Yahoo Finance)

### Environment Variables

Sensitive configuration via environment variables only:
- Database credentials
- API keys (Kinesis, etc.)
- CORS origins

Never stored in source code or committed to git.

### Error Information Disclosure

Production error responses suppress stack traces and internal details:

```javascript
// Production
{ "detail": "Internal server error" }

// Development
{ "detail": "Error message with stack trace" }
```

---

## Electron Security

### Context Isolation

```javascript
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}
```

### IPC Communication

Limited IPC channel exposure through preload scripts. Only validated functions are exposed to the renderer.

---

## Future Security Roadmap

| Feature | Status | Description |
|---------|--------|-------------|
| Authentication | Planned | Multi-user support with auth |
| Encryption at rest | Planned | Database encryption |
| API authentication | Planned | Token-based API auth |
| Audit logging | Planned | Track all data modifications |
| Backup encryption | Planned | Encrypted backup files |

---

## Related

- [[docs/security/index]] — Security documentation index
- [[docs/security/input-validation]] — Input validation details
- [[docs/security/rate-limiting]] — Rate limiting details
- [[docs/architecture/electron]] — Electron architecture
