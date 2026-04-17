---
title: Recipients
type: feature
status: active
date: 2026-04-16
tags: [feature, recipients, transactions, payees, payers, merge, atomic]
description: Recipient (payee/payer) management with atomic merge, normalization-based fuzzy matching, and UNIQUE constraints
aliases: [recipients-feature, payees, payers, counterparties, recipient-management]
related_code:
  - apps/node-backend/src/routes/recipients.js
  - apps/node-backend/src/repositories/recipientRepository.js
  - apps/node-backend/src/services/recipientMergeService.js
  - apps/node-backend/src/services/calculations/normalization.js
  - apps/frontend/src/features/recipients/
---

# Recipients

Recipients are payees (for expenses) or payers (for income) associated with transactions. Each recipient can have a default category, bank account links, and be merged with other recipients.

## Overview

Recipients represent counterparties in financial transactions. They can be grouped via merge operations (e.g., "Supermarket ABC" and "ABC Supermarket" → unified recipient). The system now maintains atomic merge semantics, ensuring all related data (transactions, splits, planned transactions, bank accounts) is reassigned in a single database transaction.

## Features

### Recipient Model

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique identifier |
| `name` | text | Display name (user-facing) |
| `normalized_name` | text | Canonical lowercase form (UNIQUE, for matching) |
| `default_category_id` | integer | FK to categories; optional default category |
| `primary_recipient_id` | integer | FK to self; set when merged into another recipient |
| `notes` | text | User-provided notes |
| `is_active` | boolean | Soft-delete flag |
| `created_at` | timestamp | Creation time (UTC) |
| `updated_at` | timestamp | Last modification time (UTC) |

### Normalization & Matching (Phase 6)

Recipients are matched using a two-tier strategy:

1. **Exact match** — Normalized names compared directly (O(1) via UNIQUE constraint on `normalized_name`).
2. **Fuzzy match** — PostgreSQL `pg_trgm` trigram similarity (GIN index, O(log N)) via the `%` operator on `normalized_name`.

The `normalizeForMatching` function canonicalizes names: lowercase, trim, remove punctuation, deduplicate whitespace, preserve digits.

#### Example Normalization

```javascript
normalizeForMatching("SUPERMARKET  ABC!") → "supermarket abc"
normalizeForMatching("ABC Supermarket") → "abc supermarket"
// Both match the same recipient via fuzzy similarity (threshold: 0.7)
```

**Service:** [[apps/node-backend/src/services/calculations/normalization.js|normalization.js]]

### Atomic Merge (Phase 6)

Merging recipients is now transactional and atomic. When recipient A is merged into primary recipient P:

1. All transactions referencing A are reassigned to P.
2. All transaction splits referencing A are reassigned to P.
3. All planned transactions referencing A are reassigned to P.
4. All bank accounts referencing A are deduplicated and reassigned to P (race-safe via `INSERT ... ON CONFLICT DO NOTHING`).
5. Recipient A's `primary_recipient_id` is stamped with P's ID for historical traceability.

If any step fails, the entire merge rolls back.

**Guarantees:**
- Merges serialize cleanly via `FOR UPDATE` row-level lock on the primary recipient.
- Concurrent merges into the same primary are linearized by the database.
- Bank account deduplication is race-safe via `INSERT ... ON CONFLICT` and `RETURNING id` for exact-one semantics.

**Service:** [[apps/node-backend/src/services/recipientMergeService.js|recipientMergeService.js]]

### Frontend Reorganization (Phase 6)

Dialog components have been moved into feature folders:

| Old Path | New Path |
|----------|----------|
| `components/forms/AddRecipientDialog.tsx` | `features/recipients/AddRecipientDialog.tsx` |
| `components/recipients/MergeRecipientsDialog.tsx` | `features/recipients/MergeRecipientsDialog.tsx` |

Pages (`RecipientsPage.tsx`) have been updated to import from the new feature paths.

## API Endpoints

All recipient endpoints are documented in [[docs/api/recipients|Recipients API]].

Key transactional guarantees:
- **POST /api/recipients/:id/merge** — Atomic merge (single DB transaction, row-locked).
- **POST /api/recipients** — Create-or-get pattern with normalized name UNIQUE constraint.

## Data Integrity Constraints

As of migration 0029:

- **recipients.normalized_name** — UNIQUE (exactly one row per canonical name)
- **recipient_bank_accounts.account_number** — UNIQUE (exactly one account per number per workspace)
- **categories(general, detail)** — UNIQUE (exactly one row per GENERAL:DETAIL pair)

These constraints are enforced at the database level and handled gracefully in application code.

## Related Features

- [[docs/features/categories|Categories]] — Recipient categorization
- [[docs/features/transactions|Transactions]] — Transaction recipient links
- [[docs/features/splits|Splits & Owes]] — Debt tracking by recipient
- [[docs/features/recipient-insights|Recipient Insights]] — Spending analytics by merchant

## Related ADRs

- [[docs/adr/014-atomic-merge-transactional-safety|ADR-014]] — Atomic merge design and row-locking strategy
- [[docs/adr/015-recipient-bank-account-uniqueness|ADR-015]] — UNIQUE constraint migration for bank accounts and recipients
