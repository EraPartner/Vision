---
title: API Documentation Index
type: api-index
---

# API Documentation

## Overview

Vision uses a RESTful API built with Express.js.

## Endpoints

```dataview
TABLE method, path, description
FROM "docs/api"
WHERE type = "endpoint"
SORT path ASC
```

## Schemas

```dataview
LIST
FROM "docs/api"
WHERE type = "schema"
```

## Quick Reference

| Area | Description |
|------|-------------|
| [[docs/api/transactions|Transactions]] | CRUD for financial transactions |
| [[docs/api/categories|Categories]] | Category management ("GENERAL:DETAIL" format) |
| [[docs/api/recipients|Recipients]] | Payee/payer management |
| [[docs/api/plannedTransactions|Planned Transactions]] | Scheduled and recurring payments |
| [[docs/api/investments|Investments]] | Portfolio holdings (stocks, crypto, real estate) |
| [[docs/api/watchlist|Watchlist]] | Investment watchlist |
| [[docs/api/imports|Imports]] | CSV import with deduplication |
| [[docs/api/settings|Settings]] | User preferences |
| [[docs/api/savedCharts|Saved Charts]] | Custom chart configurations |
| [[docs/api/marketLookup|Market Lookup]] | Real-time market data (Yahoo Finance) |
| [[docs/api/admin|Admin]] | System administration and updates |
| [[docs/api/splits|Splits]] | Transaction splitting and debt tracking |
| [[docs/api/recipientBankAccounts|Recipient Bank Accounts]] | Bank account management for recipients |
| [[docs/api/info|Info & Analytics]] | Statistics, dashboards, and insights |

## Core Concepts

### Transaction Amounts
- **Negative amounts**: Expenses (money leaving your account)
- **Positive amounts**: Income (money entering your account)

### Categories
Categories use "GENERAL:DETAIL" format:
- `FOOD:GROCERIES`
- `TRANSPORT:GAS`
- `UTILITIES:ELECTRICITY`

### Bank Adapters
Supported banks for import:
- Belfius, Revolut, KBC, SABB, Wise
- Vision (internal format)
- Custom (configurable)

## Rate Limiting

API endpoints implement rate limiting to prevent abuse:
- Standard: 100 requests per minute
- Export/Patch endpoints: 30 requests per minute
- Check `X-RateLimit-*` headers for limits

## Error Handling

Error responses include:
```json
{
  "detail": "Error message description"
}
```

Common status codes:
- 400: Bad Request (validation error)
- 404: Not Found
- 409: Conflict (duplicate detection)
- 429: Rate Limited
- 500: Internal Server Error
