---
title: API - Imports
type: endpoint
method: POST, GET
path: /api/import
description: CSV import for transactions, recipients, and categories
date: 2026-03-18
tags: [api, import, csv, bank]
related_code: [[apps/node-backend/src/routes/importRoutes.js]]
---

# Imports API

## Overview

The Imports API handles CSV file imports from various banks with automatic deduplication and category detection. Supports standard bank formats and custom configurations.

## Endpoints

### POST /api/import/csv

Import transactions from a CSV file using a predefined bank adapter.

**Content-Type:** multipart/form-data

**Form Data:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | CSV file (max 50MB) |
| bank_name | string | Yes | Bank identifier |

**Supported Banks:**
- belfius
- revolut
- kbc
- sabb
- wise
- vision
- custom

**Response:**
```json
{
  "imported": 150,
  "duplicates_skipped": 5,
  "errors": 2,
  "status": "completed",
  "error_message": null,
  "links": []
}
```

### POST /api/import/csv/custom

Import using custom CSV configuration.

**Form Data:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | CSV file |
| bank_name | string | Yes | Custom bank name |
| date_format | string | Yes | Date format (e.g., DD/MM/YYYY) |
| date_column | string | Yes | Column name for date |
| recipient_column | string | Yes | Column name for recipient |
| amount_column | string | Yes | Column name for amount |
| memo_column | string | No | Column name for memo |
| separator | string | No | CSV separator (default: ,) |
| encoding | string | No | File encoding (default: utf-8) |
| skip_rows | integer | No | Rows to skip (default: 0) |

### POST /api/import/csv/stream

Streaming import with SSE progress updates.

**Content-Type:** multipart/form-data

**Form Data:** Same as POST /api/import/csv

**Response:** Server-Sent Events stream with progress events:

```javascript
// Progress event
event: progress
data: {"processed": 50, "total": 150, "status": "processing"}

// Complete event
event: complete
data: {"imported": 150, "duplicates_skipped": 5, "errors": 0, "status": "completed"}
```

### GET /api/import/supported-banks

Get list of supported bank adapters.

**Response:**
```json
{
  "banks": ["Belfius", "Revolut", "Kbc", "Sabb", "Wise", "Vision", "Custom"],
  "total": 7
}
```

### POST /api/import/recipients

Bulk import recipients from CSV.

**Content-Type:** multipart/form-data

**Form Data:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | CSV file |
| separator | string | No | CSV separator |
| encoding | string | No | File encoding |

**CSV Format:**
```csv
name,default_category
"Supermarket ABC","FOOD:GROCERIES"
"Gas Station","TRANSPORT:GAS"
```

### POST /api/import/categories

Bulk import categories from CSV.

**CSV Format:**
```csv
general,detail,description
FOOD,GROCERIES,Supermarket purchases
FOOD,RESTAURANTS,Restaurant and cafe
TRANSPORT,GAS,Fuel purchases
```

## Import Behavior

### Deduplication
- Uses SHA-256 hash of (date, amount, recipient, bank_account)
- Duplicate transactions are skipped automatically
- Hash stored in raw transaction tables for future detection

### Category Detection
- Imports look up recipient's default category
- Creates/categorizes transactions based on recipient settings

### Error Handling
- Returns count of errors in response
- Partial imports complete even with some errors
- Error details in response message

## Rate Limits

- Standard imports: General rate limits apply
- Export endpoint: 30 requests per minute

## Related

- [[docs/api/transactions|Transactions API]]
- [[docs/api/recipients|Recipients API]]
- [[docs/integrations/index|Integrations]]
