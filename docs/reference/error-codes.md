---
title: Error Codes Reference
type: reference
status: active
date: 2026-03-31
updated: 2026-05-16
tags: [reference, errors, api, responses, status-codes, envelope, adr-026]
description: Complete reference of all API error responses, status codes, and error formats used by the Vision backend. All responses use the unified envelope (ADR-026).
aliases: [error codes, error responses, status codes, HTTP errors, API errors, error handling]
---

# Error Codes Reference

> [!abstract] Overview
> All error responses returned by the Vision API use the unified envelope defined in [[docs/adr/026-unified-api-response-envelope|ADR-026]]. Route handlers throw typed errors (`AppError`, `ValidationError`, `NotFoundError`, `ConflictError`, `UnauthorizedError`, `ForbiddenError`); the central error handler shapes them.

## Error Format

Every API response — success or failure — uses this envelope shape:

```json
// success
{ "ok": true, "data": { /* … */ }, "meta": { "requestId": "…" } }

// failure
{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "Amount must be a non-zero number", "details": { /* optional, non-sensitive */ } }, "meta": { "requestId": "…" } }
```

- `error.code` is a stable, machine-readable identifier from `@vision/types/errors` (`ApiErrorCode`). Client error handling switches on `code`, never on `message`.
- `error.message` is human-readable and may be redacted in production for untyped 500s.
- `error.details` is optional and carries non-sensitive debug info (e.g. field-level Zod issues for validation errors).
- `meta.requestId` is always present when the request went through the `requestId` middleware (every API request does).

> [!info] Legacy `{ "detail": "…" }` shape removed
> Pre-ADR-026 endpoints returned `{ "detail": "…" }`. That shape no longer exists anywhere in the backend. The envelope is enforced by `middleware/envelope.js` (success) and `middleware/errorHandler.js` (failure); the unit `tests/contract/responseEnvelope.test.js` blocks regressions.

## Status Codes

### Client Errors (4xx)

| Code | Meaning | When Returned | Example |
|------|---------|---------------|---------|
| 400 | Bad Request | Validation failure, missing required fields, invalid data types | `{ detail: 'Missing required fields: date, amount' }` |
| 404 | Not Found | Resource does not exist or has been deleted | `{ detail: 'Transaction 42 not found' }` |
| 409 | Conflict | Duplicate entry detected | `{ detail: 'Duplicate transaction detected' }` |
| 422 | Unprocessable Entity | Zod/validation schema failure (detailed field errors) | `{ detail: 'Validation error: amount: Expected number, received string' }` |
| 429 | Too Many Requests | Rate limit exceeded | `{ detail: 'Too many requests. Try again in 60 seconds' }` |

### Server Errors (5xx)

| Code | Meaning | When Returned | Example |
|------|---------|---------------|---------|
| 500 | Internal Server Error | Unhandled exception, database error | `{ detail: 'Failed to retrieve transactions' }` |
| 502 | Bad Gateway | External service failure (price provider, exchange rate API) | `{ detail: 'Price provider unavailable' }` |
| 503 | Service Unavailable | Database connection lost, service starting up | `{ detail: 'Database connection unavailable' }` |

## Common Error Messages by Resource

### Transactions

| Error | Status | Cause |
|-------|--------|-------|
| `Missing required fields: date, amount` | 400 | POST without required fields |
| `Invalid date format` | 400 | Date not in YYYY-MM-DD format |
| `Amount must be a non-zero number` | 400 | Amount is 0, null, or non-numeric |
| `Transaction not found` | 404 | GET/PATCH/DELETE with invalid ID |
| `Duplicate transaction detected` | 409 | Import creates duplicate of existing transaction |

### Categories

| Error | Status | Cause |
|-------|--------|-------|
| `Category name is required` | 400 | POST without name |
| `Category already exists` | 409 | Duplicate GENERAL:DETAIL combination |
| `Category not found` | 404 | GET/PATCH/DELETE with invalid ID |
| `Cannot delete category with transactions` | 400 | DELETE on category in use |

### Recipients

| Error | Status | Cause |
|-------|--------|-------|
| `Recipient name is required` | 400 | POST without name |
| `Recipient not found` | 404 | GET/PATCH/DELETE with invalid ID |
| `Cannot merge recipient into itself` | 400 | Merge endpoint with same source/target |

### Investments / Portfolio

| Error | Status | Cause |
|-------|--------|-------|
| `Invalid asset class` | 400 | Asset class not in enum |
| `Insufficient units for sell` | 400 | Selling more units than held |
| `Investment not found` | 404 | GET/PATCH/DELETE with invalid ID |
| `Price provider not available` | 502 | Provider API down or unreachable |

### Imports

| Error | Status | Cause |
|-------|--------|-------|
| `No file uploaded` | 400 | POST without multipart file |
| `Unsupported bank format` | 400 | Bank name not in supported list |
| `CSV parsing error` | 400 | Malformed CSV file |
| `Import already in progress` | 409 | Concurrent import attempt |

### Splits

| Error | Status | Cause |
|-------|--------|-------|
| `Split amount exceeds transaction total` | 400 | Sum of splits > transaction amount |
| `Transaction not found` | 404 | Invalid transaction ID |
| `Split already settled` | 400 | Attempting to modify settled split |

## Rate Limiting

| Endpoint Group | Limit | Window | Headers |
|---------------|-------|--------|---------|
| Standard endpoints | 100 requests | 60 seconds | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` |
| Export/Patch endpoints | 30 requests | 60 seconds | Same headers |
| Admin endpoints | 10 requests | 60 seconds | Same headers |
| Import endpoints | 5 requests | 60 seconds | Same headers |

### Rate Limit Response

```json
{
  "detail": "Too many requests. Try again in 45 seconds."
}
```

## Frontend Error Handling

The API client (`apiClient`) handles errors automatically:

| Scenario | Behavior |
|----------|----------|
| 422 validation error | Throws `Error` with formatted message: `"Validation error: field: message; ..."` |
| 429 rate limit | Throws `Error` with retry-after hint |
| Network error | Retries up to 2 times for idempotent methods (GET, PUT, DELETE) |
| Timeout (30s) | Aborts request and throws `Error` |
| 204 No Content | Returns `undefined` |

### Hook-Level Error Handling

```ts
const { mutate, isError, error } = useCreateTransaction();

// In component:
if (isError) {
  toast.error('Failed to create', { description: error.message });
}
```

## Related

- [[docs/reference/code-patterns|Code Patterns Reference]] - Error handling patterns
- [[docs/api/index|API Documentation]] - All endpoints
- [[docs/security/rate-limiting|Rate Limiting]] - Rate limit configuration
- [[docs/troubleshooting|Troubleshooting]] - Common error solutions
