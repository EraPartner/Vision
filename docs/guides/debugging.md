---
title: Error Handling & Debugging Guide
type: guide
status: active
date: 2026-04-02
tags: [debugging, error-handling, troubleshooting, developer-guide]
description: Comprehensive guide to error handling patterns, debugging techniques, and common failure modes in Vision
aliases: [debugging, error handling, troubleshooting, debugging guide, error codes]
related_code: ["apps/node-backend/src/middleware/validation.js", "apps/frontend/src/components/shared/ErrorBoundary.tsx", "apps/frontend/src/lib/api.ts"]
---

# Error Handling & Debugging Guide

> [!abstract] Purpose
> This document covers error handling patterns, debugging techniques, and common failure modes across the Vision codebase. Designed for **developers** diagnosing issues and **AI agents** analyzing error flows.

---

## Error Hierarchy

### Backend Error Flow

```
Request → Validation Middleware → Route Handler → Service → Repository → PostgreSQL
              ↓                      ↓               ↓          ↓
         ValidationError        Route Error     Service Error  DB Error
              ↓                      ↓               ↓          ↓
         400 Response          500 Response    500 Response  500 Response
```

### Frontend Error Flow

```
User Action → Hook Mutation → API Client → Express Route
                  ↓              ↓
            onError callback  Timeout/Retry
                  ↓              ↓
            Toast Error     Retry or Fail
```

---

## Backend Error Handling

### Validation Middleware

**File:** [[apps/node-backend/src/middleware/validation.js]]

Validates request parameters before they reach route handlers:

| Check | Validation | Error Response |
|-------|-----------|----------------|
| ID parameters | Positive integer | 400 Bad Request |
| Date parameters | Valid date format | 400 Bad Request |
| Amount parameters | Valid number | 400 Bad Request |
| Required fields | Non-null, non-empty | 400 Bad Request |

### Error Response Format

```json
{
  "error": "Bad Request",
  "detail": "Amount must be a valid number",
  "status": 400
}
```

### Common Backend Errors

| Status | Cause | Resolution |
|--------|-------|------------|
| 400 | Invalid input | Check request body/query params |
| 404 | Resource not found | Verify ID exists |
| 409 | Conflict (duplicate) | Check for existing records |
| 422 | Validation error | Review error.detail array |
| 429 | Rate limit exceeded | Wait and retry |
| 500 | Internal server error | Check backend logs |

---

## Frontend Error Handling

### Error Boundary

**File:** [[apps/frontend/src/components/shared/ErrorBoundary.tsx]]

Catches React render errors and displays a fallback UI:

```
ErrorBoundary
├── Catches: Component render errors
├── Displays: Error message + retry button
└── Logs: Error to console/logger
```

### API Client Error Handling

**File:** [[apps/frontend/src/lib/api.ts]]

| Error Type | Handling |
|------------|----------|
| Timeout (30s) | AbortController + retry |
| Network failure | Retry with exponential backoff |
| 422 Validation | Parse error.detail array, show field-level messages |
| 429 Rate Limit | Show retry_after message |
| 5xx Server Error | Retry up to 2 times (idempotent methods only) |

### Retry Logic

```
Request fails with retryable status (408, 429, 502, 503, 504)
    │
    ├── attempt 0: Wait 500ms + jitter → retry
    ├── attempt 1: Wait 1000ms + jitter → retry
    └── attempt 2: Throw error → show toast
```

**Only idempotent methods retry:** GET, PUT, DELETE, HEAD, OPTIONS  
**Non-idempotent methods (POST, PATCH):** No automatic retry

---

## Debugging Techniques

### Backend Debugging

#### 1. Enable Verbose Logging

```bash
# Set log level to debug
export LOG_LEVEL=debug
bun run dev
```

#### 2. Database Query Logging

```javascript
// In connection.js consumers, log database errors from caught query failures
logger.error('Database error', { error: err.message });
```

#### 3. Test Individual Services

```bash
# Run specific service tests
bun vitest run src/tests/currencyConversionService.test.js
bun vitest run src/tests/deduplication.test.js
```

#### 4. Check PostgreSQL Connection

```bash
# From project root
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
# Verify connection
psql -h localhost -p 5432 -U ftm_user -d financial_transactions
```

### Frontend Debugging

#### 1. React DevTools

- Install React DevTools browser extension
- Inspect component tree and props
- Check hook state values

#### 2. Network Tab

- Open browser DevTools → Network tab
- Filter by `api/` to see all API calls
- Check request/response payloads

#### 3. Query Cache Inspection

```typescript
// In browser console (with React DevTools)
// Access React Query devtools to inspect cache
```

#### 4. Check Context Values

```typescript
// In any component, log context values
const settings = useAppSettings();
console.log('AppSettings:', settings);
```

### Electron Debugging

#### 1. Main Process Logs

```bash
# View Electron main process logs
# Logs appear in terminal where electron:dev was started
```

#### 2. Renderer Process Console

```bash
# Open DevTools in Electron window
# Cmd+Option+I (macOS) / Ctrl+Shift+I (Windows/Linux)
```

#### 3. IPC Communication

```javascript
// Check IPC messages in main process
ipcMain.on('channel-name', (event, data) => {
    console.log('IPC received:', data);
});
```

---

## Common Failure Modes

### 1. Database Connection Failures

**Symptoms:**
- Backend fails to start
- "Connection refused" errors in logs

**Causes:**
- PostgreSQL not running
- Wrong connection credentials in `.env.local`
- Port conflict

**Resolution:**
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
# Verify: psql -h localhost -p 5432 -U ftm_user -d financial_transactions
```

### 2. Import Failures

**Symptoms:**
- Import shows 0 imported, many errors
- Progress stalls

**Causes:**
- Wrong bank adapter selected
- CSV format mismatch
- Encoding issues

**Resolution:**
- Verify bank adapter matches CSV format
- Check CSV encoding (UTF-8 recommended)
- Use custom adapter with column mapping if needed

### 3. Price Provider Failures

**Symptoms:**
- Portfolio prices show as stale or zero
- "Failed to fetch prices" errors

**Causes:**
- API rate limits (Yahoo Finance, Binance)
- Invalid symbol configuration
- Network connectivity issues

**Resolution:**
- Check provider configuration in investment settings
- Verify symbol format (e.g., `AAPL` for Yahoo, `BTCUSDT` for Binance)
- Wait for rate limit cooldown

### 4. Materialized View Staleness

**Symptoms:**
- Dashboard shows outdated totals
- Charts don't reflect recent transactions

**Causes:**
- View refresh failed or was skipped
- CONCURRENTLY refresh blocked

**Resolution:**
```bash
# Manual refresh via API
curl -X POST http://localhost:3002/api/info/refresh-views
```

### 5. React Query Cache Issues

**Symptoms:**
- UI shows stale data after mutation
- Data doesn't update after create/edit/delete

**Causes:**
- Missing `invalidateQueries` call in mutation
- Wrong query key in invalidation

**Resolution:**
- Verify mutation's `onSuccess` invalidates correct keys
- Check query key consistency between hook and invalidation

---

## Logging Strategy

### Backend Logging

**File:** [[apps/node-backend/src/config/logger.js]]

| Level | Usage |
|-------|-------|
| `error` | Unrecoverable errors, API failures |
| `warn` | Recoverable errors, fallback usage |
| `info` | Significant operations (imports, refreshes) |
| `debug` | Detailed operation tracing |

### Frontend Logging

**File:** [[apps/frontend/src/lib/logger.ts]]

| Level | Usage |
|-------|-------|
| `error` | API failures, render errors |
| `warn` | Deprecated usage, fallback behavior |
| `info` | Significant user actions |
| `debug` | Development tracing |

---

## Health Checks

### Backend Health

```bash
# Check if backend is running
curl http://localhost:3002/api/info/transaction-count
```

### Database Health

```bash
# Check PostgreSQL container and migration status
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps db
bun run db:current
```

### Frontend Health

```bash
# Build check
bun run --filter 'vision-frontend' build
```

---

## Related Documentation

- [[docs/reference/error-codes|Error Codes Reference]]
- [[docs/troubleshooting|Troubleshooting & FAQ]]
- [[docs/security/input-validation|Input Validation]]
- [[docs/testing/testing|Testing Documentation]]
