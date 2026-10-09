---
title: Recipient Bank Accounts API
type: endpoint
status: active
date: 2026-10-08
updated: 2026-10-08
tags:
  - api
  - recipients
  - banking
  - iban
description: API endpoints for managing bank accounts linked to recipients
aliases:
  - iban
  - bank accounts
  - recipient banking
related_code:
  - apps/node-backend/src/routes/recipientBankAccounts.ts
  - apps/node-backend/src/repositories/recipientBankAccountRepository.ts
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

| Field         | Type   | Description                     |
| ------------- | ------ | ------------------------------- |
| `recipientId` | number | Recipient ID (positive integer) |

**Query Parameters:**

| Parameter | Type    | Default | Description                                 |
| --------- | ------- | ------- | ------------------------------------------- |
| `active`  | boolean | `true`  | Set to `false` to include inactive accounts |

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

| Field         | Type   | Description                     |
| ------------- | ------ | ------------------------------- |
| `recipientId` | number | Recipient ID (positive integer) |

**Request Body:**

| Field            | Type    | Required | Description                     |
| ---------------- | ------- | -------- | ------------------------------- |
| `account_number` | string  | Yes      | Bank account number or IBAN     |
| `bank_name`      | string  | No       | Bank name                       |
| `address`        | string  | No       | Bank address                    |
| `account_label`  | string  | No       | Custom label for the account    |
| `set_as_primary` | boolean | No       | Set this as the primary account |

`account_number` must be a non-empty string of at most 34 characters; a number such as
`123456` is rejected. `bank_name`, `address`, and `account_label` are strings or `null`.
`set_as_primary` must be a JSON boolean or `null`. A wrong type or a missing body returns
`400 VALIDATION_ERROR` naming the field instead of a `500`.

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
  "created_at": "2025-01-20T10:00:00Z",
  "created": true
}
```

**Response:** `200 OK` (existing account retrieved)

```json
{
  "id": 1,
  "recipient_id": 1,
  "account_number": "BE68539007547034",
  "created": false,
  ...
}
```

**Error Response:** `400 Bad Request`

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "account_number: Missing required field"
  }
}
```

---

### PATCH /api/recipients/:recipientId/bank-accounts/:accountId

Update a bank account's details.

**Parameters:**

| Field         | Type   | Description                        |
| ------------- | ------ | ---------------------------------- |
| `recipientId` | number | Recipient ID (positive integer)    |
| `accountId`   | number | Bank account ID (positive integer) |

**Request Body:**

| Field           | Type   | Description       |
| --------------- | ------ | ----------------- |
| `bank_name`     | string | New bank name     |
| `address`       | string | New bank address  |
| `account_label` | string | New account label |

Each field is a string or `null`. A wrong type or a missing body returns `400 VALIDATION_ERROR`.

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
  "ok": false,
  "error": { "code": "APP_ERROR", "message": "Bank account not found" }
}
```

---

### DELETE /api/recipients/:recipientId/bank-accounts/:accountId

Soft delete (deactivate) a bank account.

**Parameters:**

| Field         | Type   | Description                        |
| ------------- | ------ | ---------------------------------- |
| `recipientId` | number | Recipient ID (positive integer)    |
| `accountId`   | number | Bank account ID (positive integer) |

**Response:** `200 OK` — the deactivated bank account. A soft delete keeps the row, so the
updated entity is returned rather than a `204` (see
[[docs/reference/code-patterns#DELETE Response Pattern|DELETE Response Pattern]]).

```json
{
  "id": 1,
  "recipient_id": 7,
  "account_number": "BE68539007547034",
  "is_active": false,
  "links": []
}
```

**Error Response:** `404 Not Found`

```json
{
  "ok": false,
  "error": { "code": "APP_ERROR", "message": "Bank account not found" }
}
```

---

### POST /api/recipients/:recipientId/bank-accounts/:accountId/set-primary

Set a bank account as the primary account for a recipient.

**Parameters:**

| Field         | Type   | Description                        |
| ------------- | ------ | ---------------------------------- |
| `recipientId` | number | Recipient ID (positive integer)    |
| `accountId`   | number | Bank account ID (positive integer) |

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
  "ok": false,
  "error": {
    "code": "APP_ERROR",
    "message": "Bank account not found or does not belong to this recipient"
  }
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
