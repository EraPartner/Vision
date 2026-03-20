---
title: API - Recipients
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/recipients
description: Recipient (payee/payer) management
date: 2026-03-18
tags: [api, recipients, payees]
related_code: [[apps/node-backend/src/routes/recipients.js]]
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

### POST /api/recipients/merge

Merge multiple recipients into one.

**Request Body:**
```json
{
  "source_recipient_ids": [2, 3],
  "target_recipient_id": 1
}
```

Merges all transactions from source recipients to target recipient.

## Recipient Bank Accounts

Recipients can have associated bank accounts.

### GET /api/recipients/:id/accounts

Get bank accounts for a recipient.

### POST /api/recipients/:id/accounts

Add a bank account to a recipient.

### DELETE /api/recipients/:id/accounts/:accountId

Remove a bank account.

## Related

- [[docs/api/transactions|Transactions API]]
- [[docs/api/categories|Categories API]]
