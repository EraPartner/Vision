---
title: Saved Charts API
type: endpoint
status: active
date: 2026-06-26
updated: 2026-08-11
tags:
  - api
  - charts
  - analytics
  - tags
  - ranked-chart
  - all-sources
description: API endpoints for saving and managing custom chart configurations (recipients, variants, time buckets, date filters added 2026-04-28; tag_ids added 2026-06-26; ranked variant + all_categories/all_recipients/all_tags dynamic source flags added 2026-06-26)
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

**Response:** `200 OK` — canonical collection body `{ items, total }` inside the
envelope's `data`.

Pagination is **opt-in** via `?limit=` (capped at 1000) and `?offset=`. With neither
param the response holds every saved chart and `total` is the row count; with either,
the body adds `limit` + `offset` and `total` becomes the full row count behind the page.

```json
{
  "items": [
    {
      "id": 1,
      "name": "Monthly Groceries",
      "chart_type": "bar",
      "chart_variant": "stacked",
      "time_bucket": "monthly",
      "category_ids": [1, 2, 3],
      "recipient_ids": [10, 11],
      "tag_ids": [3, 7],
      "all_categories": false,
      "all_recipients": false,
      "all_tags": false,
      "date_range_start": "2025-01-01",
      "date_range_end": null,
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-01T00:00:00Z"
    }
  ],
  "total": 1
}
```

---

### POST /api/saved-charts

Create a new saved chart configuration.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Chart name (non-empty, max 500 chars) |
| `chartType` | string | No | `line`, `bar`, or `area` (default: `line`) |
| `chartVariant` | string | No | `default`, `stacked`, `grouped`, or `ranked` (default: `default`) |
| `timeBucket` | string | No | `monthly` or `yearly` (default: `monthly`; ignored when `chartVariant='ranked'`) |
| `categoryIds` | number[] | No | Category IDs (ignored when `allCategories=true`) |
| `recipientIds` | number[] | No | Recipient IDs (ignored when `allRecipients=true`) |
| `tagIds` | number[] | No | Tag IDs (references `tags.id`; drives `GET /api/aggregations/tag-pivot` series; ignored when `allTags=true`) |
| `allCategories` | boolean | No | When `true`, dynamically chart all categories; ignores `categoryIds` (default: `false`) |
| `allRecipients` | boolean | No | When `true`, dynamically chart all recipients; ignores `recipientIds` (default: `false`) |
| `allTags` | boolean | No | When `true`, dynamically chart all tags; ignores `tagIds` (default: `false`) |
| `dateRangeStart` | string\|null | No | ISO date start filter |
| `dateRangeEnd` | string\|null | No | ISO date end filter |

**Response:** `201 Created` — same shape as GET item.

**Error Response:** `400 Bad Request`

```json
{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "Missing or invalid \"name\"" } }
```

Invalid `(chartType, chartVariant)` combinations also return `400`:
- `(line, stacked)`, `(line, grouped)`, `(area, grouped)`, `(line, ranked)`, `(area, ranked)`

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
- **chartVariant**: one of `default`, `stacked`, `grouped`, `ranked`
- **timeBucket**: one of `monthly`, `yearly`
- **categoryIds**: array of positive integers
- **recipientIds**: array of positive integers
- **tagIds**: array of positive integers (tag IDs from the `tags` table)
  - All three go through `validateIntArray`, which validates each element with the shared `validateId`: a plain base-10 integer in 1..2,147,483,647. A scalar is wrapped into a one-element array; **one bad element rejects the whole request** with `400 VALIDATION_ERROR` (`"<field> contains invalid value: <value>"`).
  - **Changed 2026-08-11:** elements were parsed with `parseInt`, so `categoryIds: ["12abc"]` was silently accepted as category `[12]` — a chart quietly filtered on a category nobody named. `"12abc"`, `"12.5"`, `"1e3"`, `"0x10"`, `" 5 "`, `"+5"` and `0` now all reject. Plain integers are unaffected. See [[docs/security/input-validation#Array Validation|Input Validation]].
- **allCategories / allRecipients / allTags**: boolean (default `false`)
- **dateRangeStart / dateRangeEnd**: ISO date string `YYYY-MM-DD` or `null`
- **Combination constraint**: `(line, stacked)`, `(line, grouped)`, `(area, grouped)`, `(line, ranked)`, and `(area, ranked)` are rejected with 400; `ranked` is only valid with `bar`
- **Series constraint**: at least one of `categoryIds`, `recipientIds`, `tagIds` must be non-empty **or** at least one of `allCategories`, `allRecipients`, `allTags` must be `true` to save a chart

## See Also

- [[docs/api/index]] - API Index
- [[docs/features/saved-charts]] - Feature specification
- [[docs/adr/041-saved-charts-schema-extension]] - ADR for schema extension
