---
title: Error Codes Reference
type: reference
status: active
date: 2026-03-31
tags: [reference, errors, api, responses, status-codes]
description: Complete reference of all API error responses, status codes, and error formats used by the Vision backend
aliases: [error codes, error responses, status codes, HTTP errors, API errors, error handling]
---

# Error Codes Reference

> [!abstract] Overview
> All error responses returned by the Vision API. Every error follows the same format for predictable handling.

## Error Format

All error responses use this structure:

```json
{
  "detail": "Human-readable error message"
}
```

Some endpoints include additional fields:

```json
{
  "detail": "Validation error",
  "errors": [
    { "field": "amount", "message": "Must be a non-zero number" }
  ]
}
```

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
