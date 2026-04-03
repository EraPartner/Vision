---
title: Recipient Bank Accounts API
type: endpoint
status: active
date: 2026-03-18
tags: [api, recipients, banking, iban]
description: API endpoints for managing bank accounts linked to recipients
aliases: [iban, bank accounts, recipient banking]
related_code: ["apps/node-backend/src/routes/recipientBankAccounts.js", "apps/node-backend/src/repositories/recipientBankAccountRepository.js", "apps/node-backend/src/services/iban.js"]
---

# Recipient Bank Accounts API

Endpoints for managing bank accounts (IBAN, bank details) linked to recipients. Supports CRUD operations and primary account management.

## Base URL

```
/api/recipients/:recipientId/bank-accounts
```

## Endpoints

### GET /api/recipients/:recipientId/bank-accounts

List all bank accounts for a recipient.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `recipientId` | number | Recipient ID (positive integer) |

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `active` | boolean | `true` | Set to `false` to include inactive accounts |

**Response:** `200 OK`

```json
{
  "items": [
    {
      "id": 1,
      "recipient_id": 1,
      "account_number": "BE68539007547034",
      "bank_name": "BNP Paribas Fortis",
      "address": null,
      "account_label": "Primary Account",
      "is_primary": true,
      "is_active": true,
      "created_at": "2025-01-15T10:00:00Z"
    }
  ],
  "total": 1,
  "links": []
}
```

---

### POST /api/recipients/:recipientId/bank-accounts

Create or retrieve a bank account for a recipient.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `recipientId` | number | Recipient ID (positive integer) |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `account_number` | string | Yes | Bank account number or IBAN |
| `bank_name` | string | No | Bank name |
| `address` | string | No | Bank address |
| `account_label` | string | No | Custom label for the account |
| `set_as_primary` | boolean | No | Set this as the primary account |

**Response:** `201 Created` (new account)

```json
{
  "id": 2,
  "recipient_id": 1,
  "account_number": "BE68539007547034",
  "bank_name": "BNP Paribas Fortis",
  "address": null,
  "account_label": "Savings Account",
  "is_primary": false,
  "is_active": true,
  "created_at": "2025-01-20T10:00:00Z"
}
```

**Response:** `200 OK` (existing account retrieved)

```json
{
  "id": 1,
  "recipient_id": 1,
  "account_number": "BE68539007547034",
  ...
}
```

**Error Response:** `400 Bad Request`

```json
{
  "detail": "Missing required field: account_number"
}
```

---

### PATCH /api/recipients/:recipientId/bank-accounts/:accountId

Update a bank account's details.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `recipientId` | number | Recipient ID (positive integer) |
| `accountId` | number | Bank account ID (positive integer) |

**Request Body:**

| Field | Type | Description |
|-------|------|-------------|
| `bank_name` | string | New bank name |
| `address` | string | New bank address |
| `account_label` | string | New account label |

**Response:** `200 OK`

```json
{
  "id": 1,
  "recipient_id": 1,
  "account_number": "BE68539007547034",
  "bank_name": "Updated Bank Name",
  "address": "New Address",
  "account_label": "Updated Label",
  "is_primary": true,
  "is_active": true
}
```

**Error Response:** `404 Not Found`

```json
{
  "detail": "Bank account not found"
}
```

---

### DELETE /api/recipients/:recipientId/bank-accounts/:accountId

Soft delete (deactivate) a bank account.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `recipientId` | number | Recipient ID (positive integer) |
| `accountId` | number | Bank account ID (positive integer) |

**Response:** `200 OK`

```json
{
  "message": "Bank account 1 deactivated",
  "links": []
}
```

**Error Response:** `404 Not Found`

```json
{
  "detail": "Bank account not found"
}
```

---

### POST /api/recipients/:recipientId/bank-accounts/:accountId/set-primary

Set a bank account as the primary account for a recipient.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `recipientId` | number | Recipient ID (positive integer) |
| `accountId` | number | Bank account ID (positive integer) |

**Response:** `200 OK`

```json
{
  "id": 2,
  "recipient_id": 1,
  "account_number": "BE12345678901234",
  "bank_name": "KBC",
  "account_label": "Primary Account",
  "is_primary": true,
  "is_active": true
}
```

**Error Response:** `404 Not Found`

```json
{
  "detail": "Bank account not found or does not belong to this recipient"
}
```

## IBAN Support

The system supports IBAN (International Bank Account Number) format. IBANs are validated and stored securely.

## Use Cases

- **Payment tracking**: Link bank accounts to recipients for payment tracking
- **Invoice generation**: Pre-fill recipient bank details for invoices
- **Multi-account management**: Support recipients with multiple bank accounts

## See Also

- [[docs/api/index]] - API Index
- [[docs/api/recipients]] - Recipients API
- [[docs/integrations/bank-adapters]] - Bank Adapters
