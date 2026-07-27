---
title: API - Categories
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/categories
description: Category management for organizing transactions with UNIQUE constraint and atomic assignment
date: 2026-04-16
tags: [api, categories, organization, GENERAL-DETAIL, atomic, phase-6]
status: active
aliases: [categories-api, category-management, labels, tags, GENERAL-DETAIL]
related_code: [[apps/node-backend/src/routes/categories.js]], [[apps/node-backend/src/repositories/categoryRepository.js]]
---

# Categories API

## Overview

Categories organize transactions using a "GENERAL:DETAIL" format (e.g., "FOOD:GROCERIES", "TRANSPORT:GAS"). Categories are hierarchical with general as the parent category and detail as the subcategory.

## Endpoints

### GET /api/categories

Retrieve a list of categories.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 50 | Max items (clamped: 1–1000) |
| offset | integer | 0 | Items to skip (clamped: ≥0) |
| general | string | null | Filter by general category |
| detail | string | null | Filter by detail category |
| active | boolean | true | Show active/inactive |
| search | string | null | Search in name |

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "general": "FOOD",
      "detail": "GROCERIES",
      "description": "Groceries and supermarket purchases",
      "is_active": true,
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-01T00:00:00Z",
      "links": []
    }
  ],
  "total": 25,
  "limit": 50,
  "offset": 0,
  "links": []
}
```

Implementation note:
- Category list route now retrieves `items` and `total` concurrently with `Promise.all` (independent repository calls), keeping response shape and filtering semantics unchanged while reducing endpoint latency ([[apps/node-backend/src/routes/categories.js]]).

### POST /api/categories

Create a new category or get existing category.

**Request Body:**
```json
{
  "general": "FOOD",
  "detail": "GROCERIES",
  "description": "Groceries and supermarket purchases"
}
```

**Required Fields:** general, detail

**Behavior:** Returns existing category if "GENERAL:DETAIL" combination already exists (idempotent create-or-get).

Implementation note:
- Repository `createOrGet` now uses `INSERT ... ON CONFLICT (general, detail) DO NOTHING RETURNING *` with existing-row fallback lookup, preserving idempotent create-or-get semantics while reducing race-window risk and extra round-trips under concurrent requests ([[apps/node-backend/src/repositories/categoryRepository.js]]).

**Response:** 201 if created, 200 if existing category returned.

### POST /api/categories/assign

Assign a category to multiple recipients by name.

**Request Body:**
```json
{
  "category_general": "FOOD",
  "category_detail": "GROCERIES",
  "recipient_ids": [1, 2, 3]
}
```

**Required Fields:** category_general, category_detail, recipient_ids

**Response:**
```json
{
  "updated_recipients": [...],
  "links": []
}
```

### GET /api/categories/:id

Retrieve a single category by ID.

### PATCH /api/categories/:id

Update a category.

**Request Body:**
```json
{
  "description": "Updated description",
  "is_active": false
}
```

### DELETE /api/categories/:id

Permanently delete a category (hard delete).

**Response:** `204 No Content` — empty body, no envelope. `404` if not found.

### POST /api/categories/:id/assign

Assign a category to multiple recipients by ID.

**Request Body:**
```json
{
  "recipient_ids": [1, 2, 3]
}
```

## Category Format

Categories use the format: `GENERAL:DETAIL`

Examples:
- `FOOD:GROCERIES`
- `FOOD:RESTAURANTS`
- `TRANSPORT:GAS`
- `TRANSPORT:PUBLIC`
- `UTILITIES:ELECTRICITY`
- `UTILITIES:WATER`

## Related

- [[docs/api/transactions|Transactions API]]
- [[docs/api/recipients|Recipients API]]
