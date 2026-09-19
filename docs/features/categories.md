---
title: Categories
type: feature
status: active
date: 2026-09-19
tags: [feature, categories, transactions, organization, hierarchy]
description: Parent-linked transaction categories with stable IDs, ordered paths, and legacy GENERAL:DETAIL compatibility
aliases:
  [
    categories-feature,
    transaction-categories,
    categorization,
    labels,
    GENERAL-DETAIL,
  ]
related_code:
  - apps/node-backend/src/routes/categories.js
  - apps/node-backend/src/repositories/categoryRepository.js
  - apps/node-backend/src/repositories/categoryHierarchyRepository.js
  - apps/frontend/src/features/categories/
---

# Categories

Categories organize transactions in an ordered tree. A category can be assigned at depth one or
at any deeper level. An existing `FOOD:GROCERIES` category keeps its ID and display label after
the migration. New categories use a parent ID and one node name; the colon-joined label is only
for display.

## Overview

Each transaction can be assigned a category to support spending analysis, budgeting, and reporting. Categories are shared across all transactions and recipients, and can have default category assignments.

## Category Model

| Field               | Type            | Description                                            |
| ------------------- | --------------- | ------------------------------------------------------ |
| `id`                | integer         | Unique identifier                                      |
| `parent_id`         | integer or null | Parent node; null marks a root                         |
| `name`              | text            | This node's name, independent of display delimiters    |
| `path_name`         | text            | Display projection of all ancestor names and this name |
| `general`, `detail` | text            | Legacy two-field aliases, not the canonical hierarchy  |
| `legacy_compatible` | boolean         | Row can be managed through the old two-field contract  |
| `hierarchy_only`    | boolean         | Synthetic root created for a legacy general group      |
| `description`       | text            | Human-readable description                             |
| `is_active`         | boolean         | Soft-delete flag                                       |
| `created_at`        | timestamp       | Creation time (UTC)                                    |
| `updated_at`        | timestamp       | Last modification time (UTC)                           |

## Ordered paths and the legacy format

The canonical API returns `pathIds` and `path` arrays. These hold ordered IDs and names from
root to the selected node. A name segment may itself contain a colon, so splitting
`category_name` cannot reconstruct the path. Existing two-field clients still use:

- **GENERAL**: Historical broad spending area (FOOD, TRANSPORT, UTILITIES, etc.)
- **DETAIL**: Historical detail alias (GROCERIES, RESTAURANTS, GAS, ELECTRIC, etc.)

Migration 0114 creates a structural root for each historical GENERAL and keeps each old category
as a child with the same ID. Old create/import behavior is retained for the pair. A subsequent
rename or move through the tree API changes the canonical path but leaves the historical aliases
intact so existing imports and references still resolve. Renaming or moving a structural legacy
root preserves its old general prefix and former root names as redirects. A merge records the removed pair as a
durable redirect, including through later merges. Merging a structural legacy root records its
general prefix so future imported details attach beneath the selected target. A new depth-one
node is assignable.

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

The hierarchy enables exact-node filtering and ancestor rollups at every depth. Financial
records keep one effective category ID. An ancestor total includes each assigned record once
for that ancestor, whether the record is assigned to the ancestor itself or a descendant.
`NULL` remains uncategorized, outside the tree.
Selecting a node for a chart exclusion excludes its direct assignments and descendants.
Transaction, planned-transaction, and recipient category-ID filters include the selected node
and descendants. Pivot ancestor drill-through may pass explicit descendant IDs as well.

Tax deduction candidate classification uses ordered name segments for assigned categories.
It retains the conservative name-based rules; historical two-level categories keep their
previous classification.

Rename and move keep the same ID. Deleting a node requires moving or deleting its children first;
direct assignments then follow the existing foreign-key uncategorization behavior. Merge moves
children and direct references atomically to an active target, or fails without partial changes
when sibling names or unique memberships conflict. A cycle is rejected by the database.
The legacy PATCH and DELETE endpoints cannot mutate tree-only or structural-root nodes; use the
tree API for those nodes. A merge target with legacy redirects cannot be deleted until those
redirects are resolved.

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

| Old Path                                 | New Path                                    |
| ---------------------------------------- | ------------------------------------------- |
| `components/forms/AddCategoryDialog.tsx` | `features/categories/AddCategoryDialog.tsx` |

Pages (`CategoriesPage.tsx`) have been updated to import from the new feature paths.

## Data Integrity Constraints

As of migration 0029:

- **categories(general, detail)** — UNIQUE (exactly one row per GENERAL:DETAIL pair)

This legacy constraint remains. New tree nodes also have unique names among siblings and unique
root names; a cycle is forbidden. See [[docs/adr/152-depth-agnostic-category-hierarchy|ADR-152]].

## API Endpoints

All category endpoints are documented in [[docs/api/categories|Categories API]].

Key transactional guarantees:

- **POST /api/categories** — Create-or-get with UNIQUE constraint on (general, detail).
- **POST /api/categories/:id/assign** — Atomic assignment (single DB transaction).
- **POST /api/categories/tree/:id/merge** — Moves children and direct references in one transaction.

## Import Review Category Assignment (ADR-046)

When importing bank statements, Vision now allows category assignment during the import review step before committing the batch. See [[docs/adr/046-import-review-category-assignment|ADR-046]] for design details.

Key behaviors:

- Per-row category override via `POST /api/import/batches/:id/rows/:rowId/category-override`
- Optional "Save as recipient default" checkbox to persist the category to `recipients.default_category_id`
- Committed transactions have category written explicitly: `COALESCE(override_category_id, recipient_default_category_id, NULL)`

## Related Features

- [[docs/features/recipients|Recipients]] — Recipient default categories
- [[docs/features/transactions|Transactions]] — Transaction categorization
- [[docs/features/tags|Tags]] — Orthogonal freeform tagging (cross-cutting groupings)
- [[docs/features/statistics|Statistics]] — Category-based spending reports
- [[docs/features/import|CSV Import]] — Category assignment during import review (ADR-046)

## Related ADRs

- [[docs/adr/046-import-review-category-assignment|ADR-046]] — Import review category assignment with optional persist-as-recipient-default
- [[docs/adr/015-recipient-bank-account-uniqueness|ADR-015]] — UNIQUE constraint migration for categories, recipients, and bank accounts
