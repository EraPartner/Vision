---
title: API - Categories
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/categories
description: Ordered category hierarchy with stable IDs and a compatible GENERAL:DETAIL API
date: 2026-09-19
updated: 2026-09-19
tags: [api, categories, organization, GENERAL-DETAIL, atomic, phase-6]
status: active
aliases: [categories-api, category-management, labels, tags, GENERAL-DETAIL]
related_code: [[apps/node-backend/src/routes/categories.js]], [[apps/node-backend/src/repositories/categoryRepository.js]], [[apps/node-backend/src/repositories/categoryHierarchyRepository.js]]
---

# Categories API

## Overview

The canonical hierarchy uses a parent ID and ordered path arrays. Existing `GENERAL:DETAIL`
categories retain their IDs and historical aliases. The `/api/categories` endpoints keep the
legacy two-field create/update/list behavior; `/api/categories/tree` is the depth-agnostic API.
Use `pathIds` and `path`, not the colon-joined `category_name`, for structure.

## Endpoints

### Hierarchy endpoints

`GET /api/categories/tree` returns every category node, including assignable depth-one roots,
with `{ items, total }`. Each item includes `id`, `name`, `parentId`, `pathIds`, `path`,
`category_name`, `depth`, `description`, `is_active`, `hierarchyOnly`, and `legacyCompatible`.
The ordered path arrays are authoritative. Results include inactive nodes so the editor can
show them; assignment controls should still respect `is_active`.

`POST /api/categories/tree` accepts `{ "name": "SOLAR", "parentId": 12,
"description": "..." }`. Omit `parentId` or send null for a depth-one root. Names are trimmed,
uppercased, and unique among siblings. Missing or inactive parents and invalid names are rejected.

`GET /api/categories/tree/:id` returns one node. `PATCH /api/categories/tree/:id` accepts
optional `name`, `parentId` (including null to make a root), `description`, and `is_active`.
It keeps the node ID stable and rejects cycles, sibling collisions, and an inactive parent.
`DELETE /api/categories/tree/:id` deletes only a childless node and returns 204. Existing
foreign-key deletion rules determine whether linked records become uncategorized.

`POST /api/categories/tree/:id/merge` accepts `{ "targetId": 34 }`. It moves children and
direct category references to the active target, then deletes the source, in one transaction.
It retains redirects for legacy import pairs, including earlier redirects through chained
merges. Legacy category-name input also resolves those pairs. Merging a structural legacy root
also redirects future imports of that general prefix.
It rejects a target inside the source subtree. A duplicate sibling name or unique membership
returns 409 with no partial move; the user must resolve the collision and retry. The target
node is returned.

The tree API is additive. The legacy endpoints below preserve historical `general` and
`detail` aliases after a tree rename or move; they do not expose synthetic tree-only aliases
in their list. A legacy pair update relocates that row under the corresponding general root.
Legacy PATCH and DELETE reject tree-only nodes and structural roots.

### GET /api/categories

Retrieve legacy-compatible categories. Newly created tree-only nodes are on `/tree` instead.
Pagination is **opt-in** (`parseOptionalPagination`, see
[[docs/reference/code-patterns#Adding pagination to a list that never had it|code-patterns]]):
a request without `limit`/`offset` returns the **complete** collection — the full-list
legacy consumers are never silently truncated. The current category editor and pickers use
`/tree` for all depths.

**Query Parameters:**

| Parameter | Type    | Default       | Description                                                                       |
| --------- | ------- | ------------- | --------------------------------------------------------------------------------- |
| limit     | integer | — (unbounded) | Optional page size (clamped: 1–1000). Omit together with offset for the full list |
| offset    | integer | 0             | Items to skip (clamped: ≥0). Sending either limit or offset opts into pagination  |
| general   | string  | null          | Filter by general category                                                        |
| detail    | string  | null          | Filter by detail category                                                         |
| active    | boolean | true          | Show active/inactive                                                              |
| search    | string  | null          | Search in name                                                                    |

**Response** (unpaginated request — no `limit`/`offset` fields echoed):

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
  "links": []
}
```

When the request paginates (explicit `limit`/`offset`), the body additionally carries
`"limit"` and `"offset"`, and `total` stays the full match count.

Implementation note:

- Unpaginated requests skip the `COUNT(*)` round-trip entirely (`total` = row count); paginated requests fetch the page and the count ([[apps/node-backend/src/routes/categories.js]]).

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

**Response:** `201` with `created: true` if created; `200` with `created: false` if the existing
category is returned. The boolean is part of the response data alongside the category fields.

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

Canonical resource-action endpoint. Assign the identified category to multiple recipients.

**Request Body:**

```json
{
  "recipient_ids": [1, 2, 3]
}
```

For compatibility, `recipient_ids` also accepts one integer.

**Response:**

```json
{
  "updated_recipients": 3,
  "links": []
}
```

The response count reports how many recipient rows were updated.

## Category Format

Legacy category aliases use `GENERAL:DETAIL`. Canonical hierarchy paths use ordered ID and
name arrays; a colon in one segment is valid and must not be parsed as a boundary.

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
