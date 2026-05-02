---
title: Categories
type: feature
status: active
date: 2026-04-16
tags: [feature, categories, transactions, organization, GENERAL-DETAIL, hierarchical]
description: Transaction categorization using GENERAL:DETAIL format with atomic assignment and UNIQUE constraints
aliases: [categories-feature, transaction-categories, categorization, labels, GENERAL-DETAIL]
related_code:
  - apps/node-backend/src/routes/categories.js
  - apps/node-backend/src/repositories/categoryRepository.js
  - apps/frontend/src/features/categories/
---

# Categories

Categories organize transactions using a hierarchical "GENERAL:DETAIL" format (e.g., "FOOD:GROCERIES", "TRANSPORT:GAS"). This enables both broad-level (food, transport) and fine-grained (groceries, restaurants, gas) organization.

## Overview

Each transaction can be assigned a category to support spending analysis, budgeting, and reporting. Categories are shared across all transactions and recipients, and can have default category assignments.

## Category Model

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique identifier |
| `general` | text | Top-level category (e.g., "FOOD") |
| `detail` | text | Sub-category (e.g., "GROCERIES") |
| `description` | text | Human-readable description |
| `is_active` | boolean | Soft-delete flag |
| `created_at` | timestamp | Creation time (UTC) |
| `updated_at` | timestamp | Last modification time (UTC) |

## GENERAL:DETAIL Format

Categories are hierarchical with two levels:

- **GENERAL**: Broad spending area (FOOD, TRANSPORT, UTILITIES, etc.)
- **DETAIL**: Specific subcategory (GROCERIES, RESTAURANTS, GAS, ELECTRIC, etc.)

### Example Categories

```
FOOD:GROCERIES
FOOD:DINING
FOOD:COFFEE
TRANSPORT:GAS
TRANSPORT:PUBLIC
TRANSPORT:MAINTENANCE
UTILITIES:ELECTRICITY
UTILITIES:WATER
UTILITIES:INTERNET
HOUSING:RENT
HOUSING:MORTGAGE
MEDICAL:PRESCRIPTIONS
MEDICAL:CHECKUPS
ENTERTAINMENT:MOVIES
ENTERTAINMENT:GAMES
```

## Features

### Hierarchical Organization

The two-level hierarchy enables:
- **Broad filtering**: Show all food expenses across all subcategories.
- **Granular analysis**: Break down food spending by groceries vs. dining.
- **Flexible reporting**: Group or drill down as needed.

### Create-or-Get Pattern (Phase 6)

When creating a category:

```json
POST /api/categories
{ "general": "FOOD", "detail": "GROCERIES" }
```

If the exact GENERAL:DETAIL combination exists, the endpoint returns the existing category (idempotent). This is enforced via a UNIQUE constraint on `(general, detail)` and uses `INSERT ... ON CONFLICT DO NOTHING` with fallback lookup for race-free semantics.

### Atomic Category Assignment (Phase 6)

The category assignment endpoint now wraps recipient updates in a single database transaction:

```json
POST /api/categories/:id/assign
{ "recipient_ids": [1, 2, 3] }
```

All recipient updates execute within a single transaction, ensuring consistency.

### Frontend Reorganization (Phase 6)

Dialog components have been moved into feature folders:

| Old Path | New Path |
|----------|----------|
| `components/forms/AddCategoryDialog.tsx` | `features/categories/AddCategoryDialog.tsx` |

Pages (`CategoriesPage.tsx`) have been updated to import from the new feature paths.

## Data Integrity Constraints

As of migration 0029:

- **categories(general, detail)** — UNIQUE (exactly one row per GENERAL:DETAIL pair)

This constraint is enforced at the database level and handled gracefully in application code via the create-or-get pattern.

## API Endpoints

All category endpoints are documented in [[docs/api/categories|Categories API]].

Key transactional guarantees:
- **POST /api/categories** — Create-or-get with UNIQUE constraint on (general, detail).
- **POST /api/categories/:id/assign** — Atomic assignment (single DB transaction).

## Import Review Category Assignment (ADR-046)

When importing bank statements, Vision now allows category assignment during the import review step before committing the batch. See [[docs/adr/046-import-review-category-assignment|ADR-046]] for design details.

Key behaviors:
- Per-row category override via `POST /api/import/batches/:id/rows/:rowId/category-override`
- Optional "Save as recipient default" checkbox to persist the category to `recipients.default_category_id`
- Committed transactions have category written explicitly: `COALESCE(override_category_id, recipient_default_category_id, NULL)`

## Related Features

- [[docs/features/recipients|Recipients]] — Recipient default categories
- [[docs/features/transactions|Transactions]] — Transaction categorization
- [[docs/features/statistics|Statistics]] — Category-based spending reports
- [[docs/features/import|CSV Import]] — Category assignment during import review (ADR-046)

## Related ADRs

- [[docs/adr/046-import-review-category-assignment|ADR-046]] — Import review category assignment with optional persist-as-recipient-default
- [[docs/adr/015-recipient-bank-account-uniqueness|ADR-015]] — UNIQUE constraint migration for categories, recipients, and bank accounts
