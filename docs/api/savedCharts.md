---
title: Saved Charts API
type: endpoint
status: active
date: 2026-04-28
tags:
  - api
  - charts
  - analytics
description: API endpoints for saving and managing custom chart configurations (recipients, variants, time buckets, date filters added 2026-04-28)
aliases:
  - saved-charts-api
  - custom-charts
  - chart-config
  - analytics-saved
related_code:
  - apps/node-backend/src/routes/savedCharts.js
  - apps/node-backend/src/repositories/savedChartsRepository.js
---

# Saved Charts API

Endpoints for saving and managing custom chart configurations for analytics.

## Base URL

```
/api/saved-charts
```

## Endpoints

### GET /api/saved-charts

Retrieve all saved chart configurations for the workspace.

**Response:** `200 OK`

```json
[
  {
    "id": 1,
    "name": "Monthly Groceries",
    "chart_type": "bar",
    "chart_variant": "stacked",
    "time_bucket": "monthly",
    "category_ids": [1, 2, 3],
    "recipient_ids": [10, 11],
    "date_range_start": "2025-01-01",
    "date_range_end": null,
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-01-01T00:00:00Z"
  }
]
```

---

### POST /api/saved-charts

Create a new saved chart configuration.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Chart name (non-empty, max 500 chars) |
| `chartType` | string | No | `line`, `bar`, or `area` (default: `line`) |
| `chartVariant` | string | No | `default`, `stacked`, or `grouped` (default: `default`) |
| `timeBucket` | string | No | `monthly` or `yearly` (default: `monthly`) |
| `categoryIds` | number[] | No | Category IDs |
| `recipientIds` | number[] | No | Recipient IDs |
| `dateRangeStart` | string\|null | No | ISO date start filter |
| `dateRangeEnd` | string\|null | No | ISO date end filter |

**Response:** `201 Created` — same shape as GET item.

**Error Response:** `400 Bad Request`

```json
{ "detail": "Missing or invalid \"name\"" }
```

Invalid `(chartType, chartVariant)` combinations also return `400`:
- `(line, stacked)`, `(line, grouped)`, `(area, grouped)`

---

### PATCH /api/saved-charts/:id

Update an existing saved chart. All body fields are optional — only provided fields are updated.

**Request Body:** same optional fields as POST.

**Response:** `200 OK` — updated chart object.

**Error Responses:**
- `400 Bad Request` — invalid parameters or invalid type/variant combination
- `404 Not Found` — chart not found

---

### DELETE /api/saved-charts/:id

Delete a saved chart configuration.

**Response:** `204 No Content`

**Error Responses:**
- `400 Bad Request` — invalid ID
- `404 Not Found` — chart not found

---

## Validation Rules

- **name**: non-empty string, max 500 characters
- **chartType**: one of `line`, `bar`, `area`
- **chartVariant**: one of `default`, `stacked`, `grouped`
- **timeBucket**: one of `monthly`, `yearly`
- **categoryIds**: array of positive integers
- **recipientIds**: array of positive integers
- **dateRangeStart / dateRangeEnd**: ISO date string `YYYY-MM-DD` or `null`
- **Combination constraint**: `(line, stacked)`, `(line, grouped)`, and `(area, grouped)` are rejected with 400

## See Also

- [[docs/api/index]] - API Index
- [[docs/features/saved-charts]] - Feature specification
- [[docs/adr/041-saved-charts-schema-extension]] - ADR for schema extension
