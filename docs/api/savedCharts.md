---
title: Saved Charts API
type: endpoint
status: active
date: 2026-04-10
tags:
  - api
  - charts
  - analytics
description: API endpoints for saving and managing custom chart configurations
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
    "chartType": "bar",
    "categoryIds": [1, 2, 3],
    "workspace_id": 1
  }
]
```

---

### POST /api/saved-charts

Create a new saved chart configuration.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Chart name (non-empty string) |
| `chartType` | string | No | Type of chart: `line`, `bar`, or `area` (default: `line`) |
| `categoryIds` | number[] | No | Array of category IDs to include |

**Response:** `201 Created`

```json
{
  "id": 1,
  "name": "Monthly Groceries",
  "chartType": "bar",
  "categoryIds": [1, 2, 3],
  "workspace_id": 1
}
```

**Error Response:** `400 Bad Request`

```json
{
  "detail": "Missing or invalid \"name\""
}
```

---

### PATCH /api/saved-charts/:id

Update an existing saved chart configuration.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Chart ID (positive integer) |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | New chart name |
| `chartType` | string | No | Type of chart: `line`, `bar`, or `area` |
| `categoryIds` | number[] | No | Array of category IDs |

**Response:** `200 OK`

```json
{
  "id": 1,
  "name": "Updated Name",
  "chartType": "area",
  "categoryIds": [1, 2],
  "workspace_id": 1
}
```

**Error Responses:**
- `400 Bad Request` - Invalid parameters
- `404 Not Found` - Chart not found

---

### DELETE /api/saved-charts/:id

Delete a saved chart configuration.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Chart ID (positive integer) |

**Response:** `204 No Content`

**Error Responses:**
- `400 Bad Request` - Invalid ID
- `404 Not Found` - Chart not found

---

## Validation Rules

- **name**: Must be a non-empty string, max 500 characters
- **chartType**: Must be one of `line`, `bar`, or `area`
- **categoryIds**: Array of positive integers

Implementation note:
- Route handlers now reuse shared validation/parsing helpers (`parseChartIdParam`, `validateChartType`, `validateCategoryIds`) across create/update/delete flows, preserving existing error texts and response behavior ([[apps/node-backend/src/routes/savedCharts.js]]).

## See Also

- [[docs/api/index]] - API Index
- [[docs/features/portfolio]] - Portfolio Features

## Testing references (2026-04-10)

- [[apps/node-backend/tests/routes/savedCharts.test.js]] adds route-level regression coverage for payload validation/error paths, normalization/defaulting behavior, and not-found responses.
- Route source: [[apps/node-backend/src/routes/savedCharts.js]].

Related docs: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]].
