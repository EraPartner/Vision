---
title: API Documentation Index
type: api-index
status: active
date: 2026-04-24
updated: 2026-08-11
tags: [api, index, rest, endpoints, openapi, phase-5a, attachments, phase-2, phase-9, phase-f, admin, observability, ing, bnp, supported-adapters, portfolio-import, adr-078, research, adr-079, multi-provider]
description: Complete REST API documentation for the Vision backend; authoritative spec in openapi.yaml (Phase 2.4); JSON export and attachments added in Phase 5A; Phase F adds 4 admin endpoints for provider health, endpoint liveness, and metrics; Phase 9 aggregation shadow cutover complete; May 12 2026: ING and BNP Paribas Fortis adapters added (8 total banks supported); June 15 2026: Portfolio CSV Import (ADR-078) adds 12 endpoints under /api/portfolio/import; June 16 2026: Research aggregation (ADR-079) adds 6 endpoints under /api/research
aliases: [API, endpoints, REST]
---

# API Documentation

> [!abstract] Overview
> Vision uses a RESTful API built with Express.js. All endpoints return JSON. Base URL: `http://localhost:3002/api`
>
> **Phase 1 Update (ADR-026):** All endpoints use a unified response envelope with `{ ok: true/false, data, error?, meta? }` structure. See [[docs/adr/026-unified-api-response-envelope|ADR-026]].
>
> **Phase 2.4 Update:** OpenAPI 3.0.3 specification now available at `openapi.yaml` (project root) — the authoritative source for all API contracts, request/response schemas, and type generation.
>
> **Phase 9 Update (April 2026):** Aggregation shadow mode validation complete. `/api/aggregations/*` is now the sole aggregation path. Legacy `/api/info/*` aggregation routes and shadow divergence admin endpoints removed. See [[docs/adr/011-phase2-aggregation-envelope-standard|ADR-011]] and [[docs/adr/016-aggregation-shadow-mode|ADR-016]] for details.

> [!warning] Path-param id contract (2026-08-11 — breaking for malformed ids)
> Every integer path param (`:id`, `:patternId`, `:accountId`, `:txnId`) accepts **only** a plain base-10 integer in 1..2,147,483,647. Anything else — `"12abc"`, `"12.5"`, `"1e3"`, `"0x10"`, `" 5 "`, `"+5"`, `0`, negatives — returns `400 VALIDATION_ERROR` with `"<field> must be a positive integer"`.
>
> This changed on 2026-08-11: the shared validator was `parseInt`-based, so it took the leading digits of anything and `"12abc"` silently resolved to id **12**, acting on a record the client never named. Clients sending well-formed ids are unaffected.
>
> A same-day follow-up extended this to the two remaining id parsers: **body id arrays** (`validateIntArray` — `categoryIds`/`recipientIds`/`tagIds` on saved charts, `excludedCategoryIds`/`excludedRecipientIds` on dashboard settings), where `["12abc"]` used to become `[12]` and silently change which rows an aggregation covered; and **import batch/row ids** (`/api/import/batches/*`, `/api/portfolio/import/batches/*`), where a bare `Number()` took `"0x10"` as batch 16 and `"1e3"` as batch 1000. Both now delegate to the same validator — the import ids keep a `Number.MAX_SAFE_INTEGER` ceiling rather than `int32`, since those PKs are `BIGSERIAL`. Full accept set: [[docs/security/input-validation#ID Validation|Input Validation]].

> [!tip] Quick Navigation
> - **OpenAPI Spec:** See `openapi.yaml` for formal specifications
> - **Type Generation:** TypeScript types auto-generated via `openapi-typescript` from the spec (see [[docs/adr/031-openapi-type-generation-frontend|ADR-031]])
> - **Endpoint Lookup:** Use `Ctrl/Cmd+O` to search any endpoint. All API docs follow the pattern `docs/api/<resource>.md`

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
| Market Lookup | `/api/market` | GET | [[docs/api/marketLookup\|Market Lookup API]] |
| Research (ADR-079) | `/api/research` | GET | [[docs/api/research\|Research API]] |
| Imports | `/api/import` | GET, POST | [[docs/api/imports\|Imports API]] |
| Portfolio Imports (ADR-078) | `/api/portfolio/import` | GET, POST, PATCH, DELETE | [[docs/api/portfolio-imports\|Portfolio Imports API]] |
| Attachments (Phase 5A) | `/api/attachments` | GET, POST, DELETE | [[docs/api/attachments\|Attachments API]] |
| Saved Charts | `/api/saved-charts` | GET, POST, PATCH, DELETE | [[docs/api/savedCharts\|Saved Charts API]] |
| Settings | `/api/settings` | GET, PUT, DELETE | [[docs/api/settings\|Settings API]] |
| Recipient Bank Accounts | `/api/recipients/:id/bank-accounts` | GET, POST, PATCH, DELETE | [[docs/api/recipientBankAccounts\|Recipient Bank Accounts API]] |
| Splits | `/api/splits` | GET, POST, PATCH, DELETE | [[docs/api/splits\|Splits API]] |
| Admin | `/api/admin` | GET, POST | [[docs/api/admin\|Admin API]] |
| Reports (Phase 3) | `/api/reports` | POST, GET (legacy) | [[docs/api/reports\|Reports API]] |
| Aggregations (Phase 2) | `/api/aggregations` | GET | [[docs/api/aggregations\|Aggregations API]] |
| Info & Analytics | `/api/info` | GET | [[docs/api/info\|Info & Analytics API]] |
| Portfolio Summary | `/api/info/portfolio-summary` | GET | [[docs/api/portfolio-summary\|Portfolio Summary API]] |
| AI Chat | `/api/ai` | GET, POST, PATCH, DELETE | [[docs/api/ai\|AI Chat API]] |
| Tags (ADR-052, May 2026) | `/api/tags` | GET, POST, PATCH, DELETE | [[docs/api/tags\|Tags API]] |
| Health | `/health` · `/health/detailed` | GET | [[docs/api/health\|Health API]] |

## Core Concepts

> [!info] Transaction Amounts
> - **Negative amounts**: Expenses (money leaving your account)
> - **Positive amounts**: Income (money entering your account)

> [!info] Categories
> Categories use `GENERAL:DETAIL` format:
> - `FOOD:GROCERIES`, `TRANSPORT:GAS`, `UTILITIES:ELECTRICITY`

> [!info] Bank Adapters
> Supported banks for import: Belfius, Revolut, ING, KBC, BNP Paribas Fortis, SABB, Wise, Vision (internal format), Custom (configurable)

## Rate Limiting

> [!warning] Rate Limits
> - **Standard endpoints**: 200 requests per minute (global default)
> - **Export / Patch / bulk endpoints**: 30 requests per minute
> - **Attachments**: `attachmentRateLimiter` 60 requests per minute (ADR-042)
> - **AI Chat**: per `AI_CHAT_RATE_LIMIT` env var (default 30 req/min)
> - **SPA fallback**: `spaRateLimiter` 600 requests per minute
> - **Admin endpoints**: stricter limits (e.g., `/api/info/refresh-views` uses `adminRateLimiter`)
> - Check `X-RateLimit-*` headers for current usage

## Authentication Notes

- Most endpoints are currently workspace-internal and do not require user auth.
- `/api/admin/*` supports optional Bearer-token protection via `ADMIN_AUTH_TOKEN`; when configured, requests must include `Authorization: Bearer <token>`.

## Response Envelope (ADR-026)

**Success Response** (`ok: true`):
```json
{
  "ok": true,
  "data": { /* endpoint-specific data */ },
  "meta": {
    "requestId": "req-12345...",
    "computedAt": "2026-04-24T...",
    "source": "live",
    "pagination": { "total": 42, "limit": 50, "offset": 0 }
  }
}
```

**Error Response** (`ok: false`):
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": { /* optional details */ }
  },
  "meta": {
    "requestId": "req-12345..."
  }
}
```

**List Response Envelope** (all paginated endpoints):
```json
{
  "ok": true,
  "data": {
    "items": [ /* array of items */ ],
    "total": 42,
    "limit": 50,
    "offset": 0
  },
  "meta": { "requestId": "..." }
}
```

See [[docs/reference/code-patterns#List Response Envelope Pattern|List Response Envelope Pattern]] for details.

## Error Codes and HTTP Status

| HTTP | Code | Meaning |
|------|------|---------|
| 400 | VALIDATION_ERROR | Invalid input or missing required fields |
| 404 | NOT_FOUND | Resource not found |
| 409 | CONFLICT | Duplicate or constraint violation |
| 429 | RATE_LIMITED | Rate limit exceeded |
| 500 | Internal Server Error |

## Related Documentation

- [[docs/features/index\|Feature Docs]] - How features use the API
- [[docs/integrations/index\|Integrations]] - External service integrations
- [[docs/architecture/backend-architecture\|Backend Architecture]] - Server architecture
- [[docs/security/index\|Security]] - Security policies
