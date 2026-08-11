---
title: API - Recipients
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/recipients
description: Recipient (payee/payer) management with atomic merge and normalization-based matching
date: 2026-04-16
updated: 2026-08-10
tags: [api, recipients, payees, merge, atomic, phase-6, recipient-clusters]
status: active
aliases: [recipients-api, payee, payer, counterparty, recipient-management]
related_code: [[apps/node-backend/src/routes/recipients.js]], [[apps/node-backend/src/repositories/recipientRepository.js]], [[apps/node-backend/src/services/recipientMergeService.js]], [[apps/node-backend/src/services/recipientClusterService.js]]
---

# Recipients API

## Overview

Recipients represent payees (for expenses) or payers (for income) associated with transactions. Each recipient can have a default category and can be linked to bank accounts.

## Endpoints

### GET /api/recipients

Retrieve a list of recipients.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 50 | Max items (clamped: 1–5000) |
| offset | integer | 0 | Items to skip (clamped: ≥0) |
| search | string | null | Search in name |
| active | boolean | true | Show active/inactive |
| name | string | null | Filter by exact name match |
| default_category_id | integer | null | Filter by default category |
| uncategorized | boolean | null | Filter recipients without default category |
| sort_by | string | name | Sort field (name, created_at, updated_at) |
| sort_dir | string | asc | Sort direction (asc, desc) |

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "name": "Supermarket ABC",
      "normalized_name": "supermarket abc",
      "default_category_id": 5,
      "primary_recipient_id": null,
      "notes": "Main grocery store",
      "is_active": true,
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-15T00:00:00Z",
      "links": []
    }
  ],
  "total": 100,
  "limit": 50,
  "offset": 0,
  "links": []
}
```

Implementation note:
- Recipient list route now fetches `items` and `total` via `Promise.all` because both repository calls are independent; response payload and filtering behavior are unchanged ([[apps/node-backend/src/routes/recipients.js]]).
- Recipient repository list query now computes `primary_bank_account` via `LEFT JOIN LATERAL` and alias totals via a pre-aggregated join instead of per-row correlated subqueries, preserving sortable fields and response shape while improving scalability on larger recipient sets ([[apps/node-backend/src/repositories/recipientRepository.js]]).
- Recipient `getById` now uses the same lateral/pre-aggregated enrichment pattern as list queries (instead of correlated subqueries), and recipient update now returns enriched fields via a single CTE update-and-select query instead of update + follow-up read; API payloads and not-found behavior are unchanged ([[apps/node-backend/src/repositories/recipientRepository.js]]).

### POST /api/recipients

Create a new recipient.

**Request Body:**
```json
{
  "name": "Supermarket ABC",
  "default_category_id": 5,
  "notes": "Main grocery store"
}
```

**Required Fields:** name

**Behavior:** Automatically normalizes the name for matching (lowercase, trimmed).

### GET /api/recipients/:id

Retrieve a single recipient by ID.

**Response:**
```json
{
  "id": 1,
  "name": "Supermarket ABC",
  "normalized_name": "supermarket abc",
  "default_category_id": 5,
  "primary_recipient_id": null,
  "notes": "Main grocery store",
  "is_active": true,
  "created_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-15T00:00:00Z",
  "links": []
}
```

**Error Response (404):**
```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Recipient not found" } }
```

### PATCH /api/recipients/:id

Update a recipient.

**Request Body:**
```json
{
  "name": "Updated Name",
  "default_category_id": 6,
  "notes": "New notes"
}
```

### DELETE /api/recipients/:id

Permanently delete a recipient (hard delete).

**Response:** `204 No Content` — empty body, no envelope. `404` if not found.

### POST /api/recipients/:id/merge

Merge multiple recipients into one (the recipient identified by `:id` becomes the primary). **Phase 6: Atomic merge with transactional guarantees.**

**Request Body:**
```json
{
  "alias_ids": [2, 3]
}
```

Merges all transactions, splits, planned transactions, and bank accounts from alias recipients to the primary recipient. Sets `primary_recipient_id` on aliases.

**Atomic Guarantees (Phase 6):**
- All FK reassignments execute within a single database transaction.
- If any step fails, the entire merge rolls back (no partial state).
- Concurrent merges into the same primary are serialized via row-level locking (FOR UPDATE).
- Bank account deduplication is race-safe (INSERT ... ON CONFLICT).

**Response:**
```json
{
  "primary": { "id": 1, "name": "Primary Recipient" },
  "merged_ids": [2, 3],
  "reassigned": { "transactions": 7, "splits": 0, "planned": 0, "bankAccounts": 1 },
  "aliases": [
    { "id": 2, "name": "Alias One" },
    { "id": 3, "name": "Alias Two" }
  ],
  "patternSuggestion": null
}
```

`patternSuggestion` is `null` when no common prefix can be derived from the merged names, or `{ pattern, kind, matchCount, confidence }` when a `literal_prefix` suggestion is available.`

### POST /api/recipients/:id/unmerge

Remove a recipient from its primary merge group (clears `primary_recipient_id`).

**Response:**
```json
{
  "id": 2,
  "name": "Unmerged Recipient",
  "primary_recipient_id": null
}
```

### GET /api/recipients/:id/aliases

Get all alias recipients for a primary recipient.

**Response:**
```json
{
  "items": [
    { "id": 2, "name": "Alias One", "primary_recipient_id": 1 },
    { "id": 3, "name": "Alias Two", "primary_recipient_id": 1 }
  ],
  "total": 2
}
```

### GET /api/recipients/clusters

Identify recipient clusters for bulk merge operations. Analyzes active primary recipients and groups them by common prefixes and categories, returning potential match patterns for pattern-based merge suggestions.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| minCount | integer | 2 | Minimum recipients per cluster |

**Response:**
```json
{
  "items": [
    {
      "lcp": "SUPER",
      "confidence": 0.95,
      "recipientIds": [1, 5, 7],
      "recipientNames": ["Supermarket ABC", "Supermarket XYZ", "Super Convenience"],
      "categoryId": 5,
      "suggestedPattern": "super%",
      "suggestedKind": "prefix"
    }
  ],
  "total": 1
}
```

**Response Fields:**
- `lcp` (string): Longest common prefix of recipient names in the cluster
- `confidence` (number): Match confidence (0.0–1.0) based on LCP length and cluster size
- `recipientIds` (array): IDs of recipients in the cluster
- `recipientNames` (array): Names of recipients in the cluster
- `categoryId` (integer): Shared or most common category ID in the cluster
- `suggestedPattern` (string): Recommended pattern for merge rule (e.g., `"super%"` for prefix matching)
- `suggestedKind` (string): Pattern type, currently `"prefix"`

**Implementation:**
- Queries active primary recipients only (excludes aliases and inactive)
- Buckets by first-4-character prefix + category for initial grouping
- Analyzes longest common prefix (LCP) with minimum length of 8 characters
- Returns up to 50 clusters sorted by confidence (highest first)
- Used by the frontend to suggest pattern-based merge opportunities after manual merge actions

## Recipient Patterns

Recipients can have matching patterns used for automatic categorization during CSV import. These endpoints are handled inline in `recipients.js`.

### GET /api/recipients/:id/patterns

List all matching patterns for a recipient.

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `id` | Recipient ID |

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "recipient_id": 5,
      "pattern": "SUPERMARKET",
      "pattern_kind": "literal_prefix",
      "case_sensitive": false,
      "priority": 0,
      "notes": null
    }
  ],
  "total": 1
}
```

### POST /api/recipients/:id/patterns

Create a new matching pattern for a recipient.

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `id` | Recipient ID |

**Request Body:**
```json
{
  "pattern": "SUPERMARKET",
  "pattern_kind": "literal_prefix",
  "case_sensitive": false,
  "priority": 0,
  "notes": "Matches all supermarket transactions"
}
```

**Required Fields:** `pattern`

**Response:** `201 Created`
```json
{
  "id": 1,
  "recipient_id": 5,
  "pattern": "SUPERMARKET",
  "pattern_kind": "literal_prefix",
  "case_sensitive": false,
  "priority": 0,
  "notes": "Matches all supermarket transactions"
}
```

**Error Response (400):**
```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Missing required field: pattern" } }
```

### POST /api/recipients/:id/patterns/preview

Preview which existing transactions would match a given pattern before saving it.

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `id` | Recipient ID |

**Request Body:**
```json
{
  "pattern": "SUPERMARKET",
  "pattern_kind": "literal_prefix",
  "case_sensitive": false
}
```

**Required Fields:** `pattern`

**Defaults:** `pattern_kind` defaults to `literal_prefix`; `case_sensitive` defaults to `false`.

**Response:** `200 OK`
```json
{
  "matchCount": 14,
  "matches": [
    { "id": 101, "description": "SUPERMARKET ABC", "date": "2026-05-01", "amount": -45.00 }
  ]
}
```

### PATCH /api/recipients/:id/patterns/:patternId

Update an existing pattern.

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `id` | Recipient ID |
| `patternId` | Pattern ID |

**Request Body:** Any subset of `pattern`, `pattern_kind`, `case_sensitive`, `priority`, `notes`.

**Response:** `204 No Content` — empty body, no envelope (see [[docs/reference/code-patterns#DELETE Response Pattern|DELETE Response Pattern]]).

**Error Response (400):**
```json
{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "patternId must be a positive integer" } }
```

### DELETE /api/recipients/:id/patterns/:patternId

Delete a pattern.

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `id` | Recipient ID |
| `patternId` | Pattern ID |

**Response:** `200 OK`
```json
{ "patternId": 1 }
```

**Error Response (400):**
```json
{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "patternId must be a positive integer" } }
```

## Recipient Bank Accounts

Recipients can have associated bank accounts. These endpoints are handled by `recipientBankAccounts.js`.

### GET /api/recipients/:id/bank-accounts

Get bank accounts for a recipient.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `active` | boolean | `true` | Filter active-only accounts |

### POST /api/recipients/:id/bank-accounts

Add or get an existing bank account for a recipient (create-or-get pattern).

**Request Body:**
```json
{
  "account_number": "BE12345678901234",
  "bank_name": "KBC",
  "account_label": "Main Account",
  "address": "Some Address",
  "set_as_primary": true
}
```

### PATCH /api/recipients/:id/bank-accounts/:accountId

Update a bank account's details.

**Request Body:**
```json
{
  "bank_name": "Updated Bank",
  "address": "New Address",
  "account_label": "New Label"
}
```

### DELETE /api/recipients/:id/bank-accounts/:accountId

Soft delete a bank account (sets `is_active = false`). Returns `200` with the deactivated account
— see [[docs/api/recipientBankAccounts#DELETE /api/recipients/:recipientId/bank-accounts/:accountId|Recipient Bank Accounts API]].

### POST /api/recipients/:id/bank-accounts/:accountId/set-primary

Set a bank account as the primary account for the recipient.

## Examples

### List Recipients

**curl:**
```bash
curl "http://localhost:3002/api/recipients?limit=20&active=true"
```

**apiClient:**
```ts
const { data } = await apiClient.getRecipients({ limit: 20, active: true });
```

### Create Recipient

**curl:**
```bash
curl -X POST http://localhost:3002/api/recipients \
  -H "Content-Type: application/json" \
  -d '{ "name": "Supermarket ABC" }'
```

**apiClient:**
```ts
const recipient = await apiClient.createRecipient({ name: 'Supermarket ABC' });
```

### Merge Recipients

**curl:**
```bash
curl -X POST http://localhost:3002/api/recipients/1/merge \
  -H "Content-Type: application/json" \
  -d '{ "alias_ids": [2, 3] }'
```

**apiClient:**
```ts
const merged = await apiClient.mergeRecipients(1, [2, 3]);
```

## Related

- [[docs/api/transactions|Transactions API]]
- [[docs/api/categories|Categories API]]
