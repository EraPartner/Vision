---
title: Tags API
type: api
status: active
date: 2026-08-31
updated: 2026-08-31
tags: [api, tags, tagging, orthogonal-dimension, adr-052, bulk-tag]
description: REST endpoints for transaction tags — a slug-based orthogonal labelling dimension introduced in ADR-052 (May 2026). Tag attachment to transactions is performed via the bulk endpoint on /api/transactions.
aliases: [tags api, transaction tags api, /api/tags]
related_code:
  - apps/node-backend/src/routes/tags.js
  - apps/node-backend/src/repositories/tagRepository.js
  - apps/node-backend/src/lib/slugify.js
---

# Tags API

> [!abstract] Overview
> Tags are an orthogonal labelling dimension layered on top of transactions (independent of categories or recipients). Each tag has a slug-based identity, a colour, and an `is_active` soft-delete flag. Attachment / detachment is performed in bulk on `/api/transactions/bulk-tag` so the slug ↔ id resolution can happen once per call. Source: [[apps/node-backend/src/routes/tags.js]] and [[apps/node-backend/src/repositories/tagRepository.js]].

## Resource shape

```jsonc
{
  "id": 42,
  "slug": "subscription",
  "name": "Subscription",
  "color": "#10b981",
  "is_active": true,
  "created_at": "2026-05-08T14:22:01.123Z",
  "updated_at": "2026-05-08T14:22:01.123Z",
}
```

All responses use the unified envelope (`{ ok, data, meta? }` / `{ ok, error, meta? }`) — see [[docs/adr/026-unified-api-response-envelope|ADR-026]].

## Endpoints

| Method   | Path            | Description                                                                                                                                                               |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/tags`     | List tags. Query: `active=true` (default) / `false` / `all`. Pagination is opt-in: omit `limit`/`offset` for the complete list.                                           |
| `POST`   | `/api/tags`     | Find-or-create tag by slug (idempotent upsert). A `name` is slugified via `lib/slugify.js`; if the slug already exists, its row is reactivated and the colour is updated. |
| `PATCH`  | `/api/tags/:id` | Update `color` and/or `is_active`.                                                                                                                                        |
| `DELETE` | `/api/tags/:id` | Soft-delete by setting `is_active=false`. Existing transaction associations are preserved.                                                                                |

### `GET /api/tags`

Pagination is **opt-in** (`parseOptionalPagination`, see
[[docs/reference/code-patterns#Adding pagination to a list that never had it|code-patterns]]):
without `limit`/`offset` the complete list is returned — the tag pickers/filters that
consume this endpoint are never silently truncated. An explicit `limit` (clamped to 1000)
and/or `offset` pages the list, echoing `limit`/`offset` in the body while `total` stays
the full match count.

Response (`200`, unpaginated request):

```jsonc
{
  "ok":   true,
  "data": { "items": [ /* Tag, … */ ], "total": N, "links": [] }
}
```

### `POST /api/tags`

Body:

```jsonc
{ "name": "Subscription", "color": "#10b981" } // color optional
```

Response data always includes `created`: it is `true` only for a new tag and `false` when an
existing active or inactive tag is returned. New and reactivated tags use `201`; an existing
active tag uses `200`. The existing `reactivated` metadata remains available independently.

### `PATCH /api/tags/:id`

Body (at least one field):

```jsonc
{ "color": "#f5a3b8", "is_active": true }
```

### `DELETE /api/tags/:id`

Soft delete (sets `is_active = false`). Returns `200` with the deactivated tag — the row survives,
so the caller gets its new state rather than a `204` (see
[[docs/reference/code-patterns#DELETE Response Pattern|DELETE Response Pattern]]).

## Attaching tags to transactions

Tag attachment uses the bulk endpoint on the transactions router (one round-trip can handle 1–500 transactions):

```http
POST /api/transactions/bulk-tag
Content-Type: application/json
Rate-Limit: 30 req/min

{
  "transaction_ids": [101, 102, 103],
  "add_tag_ids":     [42, 43],
  "remove_tag_ids":  [44]
}
```

See the [[docs/api/transactions#post-apitransactionsbulk-tag|Transactions API · bulk-tag section]] for the full contract. Bulk tag operations are atomic per request: either every requested attachment succeeds or none do.

## Filtering transactions by tag

`GET /api/transactions` accepts a `tags` query parameter (comma-separated tag ids). The same parameter is honoured on the streaming export endpoints (`/export/csv`, `/export/json`).

## Error codes

| HTTP | `error.code`       | When                                                                                               |
| ---- | ------------------ | -------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR` | Empty name, invalid colour, missing body field.                                                    |
| 404  | `NOT_FOUND`        | `PATCH` / `DELETE` against an unknown id.                                                          |
| 409  | `CONFLICT`         | (Reserved — find-or-create is idempotent so a write-time conflict does not surface to the client.) |

## Related

- [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052: Transaction tags as orthogonal dimension]]
- [[docs/features/tags|Tags Feature]]
- [[docs/api/transactions|Transactions API]] — bulk-tag + `tags` filter
- [[docs/reference/data-model|Data Model Reference]] — `tags`, `transaction_tags`
