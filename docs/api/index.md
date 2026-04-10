---
title: API Documentation Index
type: api-index
status: active
date: 2026-04-10
tags: [api, index, rest, endpoints]
description: Complete REST API documentation for the Vision backend
aliases: [API, endpoints, REST]
---

# API Documentation

> [!abstract] Overview
> Vision uses a RESTful API built with Express.js. All endpoints return JSON. Base URL: `http://localhost:3002/api`

> [!tip] Quick Navigation
> Use `Ctrl/Cmd+O` to search for any endpoint. All API docs follow the pattern `docs/api/<resource>.md`.

## Endpoints by Resource

```dataview
TABLE WITHOUT FILE
  path AS "Path",
  method AS "Methods",
  description AS "Description"
FROM "docs/api"
WHERE type = "endpoint"
SORT path ASC
```

## Quick Reference

| Resource | Path | Methods | Documentation |
|----------|------|---------|---------------|
| Transactions | `/api/transactions` | GET, POST, PATCH, DELETE | [[docs/api/transactions\|Transactions API]] |
| Categories | `/api/categories` | GET, POST, PATCH, DELETE | [[docs/api/categories\|Categories API]] |
| Recipients | `/api/recipients` | GET, POST, PATCH, DELETE | [[docs/api/recipients\|Recipients API]] |
| Planned Transactions | `/api/planned-transactions` | GET, POST, PATCH, DELETE | [[docs/api/plannedTransactions\|Planned Transactions API]] |
| Investments | `/api/investments` | GET, POST, PATCH, DELETE | [[docs/api/investments\|Investments API]] |
| Watchlist | `/api/watchlist` | GET, POST, PATCH, DELETE | [[docs/api/watchlist\|Watchlist API]] |
| Market Lookup | `/api/market-lookup` | GET | [[docs/api/marketLookup\|Market Lookup API]] |
| Imports | `/api/import` | GET, POST | [[docs/api/imports\|Imports API]] |
| Saved Charts | `/api/saved-charts` | GET, POST, PATCH, DELETE | [[docs/api/savedCharts\|Saved Charts API]] |
| Settings | `/api/settings` | GET, PUT, DELETE | [[docs/api/settings\|Settings API]] |
| Recipient Bank Accounts | `/api/recipients/:id/bank-accounts` | GET, POST, PATCH, DELETE | [[docs/api/recipientBankAccounts\|Recipient Bank Accounts API]] |
| Splits | `/api/splits` | GET, POST, PATCH, DELETE | [[docs/api/splits\|Splits API]] |
| Admin | `/api/admin` | GET, POST | [[docs/api/admin\|Admin API]] |
| Info & Analytics | `/api/info` | GET | [[docs/api/info\|Info & Analytics API]] |

## Core Concepts

> [!info] Transaction Amounts
> - **Negative amounts**: Expenses (money leaving your account)
> - **Positive amounts**: Income (money entering your account)

> [!info] Categories
> Categories use `GENERAL:DETAIL` format:
> - `FOOD:GROCERIES`, `TRANSPORT:GAS`, `UTILITIES:ELECTRICITY`

> [!info] Bank Adapters
> Supported banks for import: Belfius, Revolut, KBC, SABB, Wise, Vision (internal format), Custom (configurable)

## Rate Limiting

> [!warning] Rate Limits
> - **Standard endpoints**: 100 requests per minute
> - **Export/Patch endpoints**: 30 requests per minute
> - **Admin refresh endpoints**: stricter limits (e.g., `/api/info/refresh-views` uses admin limiter)
> - Check `X-RateLimit-*` headers for current usage

## Authentication Notes

- Most endpoints are currently workspace-internal and do not require user auth.
- `/api/admin/*` supports optional Bearer-token protection via `ADMIN_AUTH_TOKEN`; when configured, requests must include `Authorization: Bearer <token>`.

## Error Handling

All error responses follow this format:

```json
{
  "detail": "Error message description"
}
```

| Status Code | Meaning |
|-------------|---------|
| 400 | Bad Request (validation error) |
| 404 | Not Found |
| 409 | Conflict (duplicate detection) |
| 429 | Rate Limited |
| 500 | Internal Server Error |

## Related Documentation

- [[docs/features/index\|Feature Docs]] - How features use the API
- [[docs/integrations/index\|Integrations]] - External service integrations
- [[docs/architecture/backend-architecture\|Backend Architecture]] - Server architecture
- [[docs/security/index\|Security]] - Security policies
