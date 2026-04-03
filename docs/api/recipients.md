---
title: API - Recipients
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/recipients
description: Recipient (payee/payer) management
date: 2026-04-02
tags: [api, recipients, payees]
status: active
aliases: [recipients-api, payee, payer, counterparty, recipient-management]
related_code: [[apps/node-backend/src/routes/recipients.js]], [[apps/node-backend/src/repositories/recipientRepository.js]]
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
| limit | integer | 50 | Max items |
| offset | integer | 0 | Items to skip |
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
{ "detail": "Recipient not found" }
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

Soft delete a recipient (sets is_active = false).

### POST /api/recipients/:id/merge

Merge multiple recipients into one (the recipient identified by `:id` becomes the primary).

**Request Body:**
```json
{
  "alias_ids": [2, 3]
}
```

Merges all transactions from alias recipients to the primary recipient. Sets `primary_recipient_id` on aliases.

**Response:**
```json
{
  "id": 1,
  "name": "Primary Recipient",
  "merged_ids": [2, 3],
  "aliases": [
    { "id": 2, "name": "Alias One" },
    { "id": 3, "name": "Alias Two" }
  ]
}
```

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

Soft delete a bank account (sets `is_active = false`).

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
