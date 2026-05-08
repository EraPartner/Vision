---
title: "ADR-052: Transaction Tags as Orthogonal Dimension"
type: adr
status: Accepted
date: 2026-05-08
tags: [adr, transactions, tags, categorization]
description: Adds a freeform tagging system to transactions and planned transactions as a second, orthogonal classification dimension
aliases: [adr-052, transaction-tags-adr]
---

# ADR-052: Transaction Tags as Orthogonal Dimension

## Status
Accepted

## Date
2026-05-08

## Context

Vision categorises every transaction into a single `GENERAL:DETAIL` category. This covers *what* the money is for but cannot express orthogonal groupings such as trips, projects, events, or cost-centres. A transaction filed under `LEISURE:TRAVEL` may also belong to a trip called `rome-2020`; there is no way to later answer "what did Rome 2020 cost?" without inventing a parallel category subtree.

Tags solve this as a second, freeform dimension:
- They cross-cut categories — a transaction can have both a category and multiple tags simultaneously.
- They are user-created on demand with no predefined hierarchy.
- They are globally scoped (Vision is single-user).

No prior ADR rejected tags; they simply had not been built.

## Decision

### Schema

Three tables: `tags` (global registry), `transaction_tags` (junction), `planned_transaction_tags` (junction for planned). Slugs are globally unique (not partial-on-active) so that junction rows referencing `tag_id` survive soft-delete and reactivation cycles.

Soft-delete via `is_active = false` preserves junction history. When a user types a previously-deleted slug, the row is reactivated atomically via an `ON CONFLICT DO UPDATE` upsert rather than creating a new row, which would orphan historical junctions.

### Slug semantics

- Slugs are immutable after creation. Renames are done as new-tag + bulk-retag (future).
- Slug normalisation: lowercase, trim, whitespace → `-`, strip non-alphanum-dash, collapse runs.
- Unicode characters are dropped in v1 (documented limitation); transliteration in v2 if needed.

### Read path

Tags are not `array_agg`'d into the main transaction list query (already five LEFT JOINs). Instead a batched second query is issued after the main query (`WHERE transaction_id = ANY($1)`), matching the pattern already used for planned-transaction executions.

### Filter semantics

Tag filter is OR: a transaction matches if it has *any* of the selected tags. `EXISTS (SELECT 1 FROM transaction_tags ... WHERE slug = ANY($n::text[]))` was chosen over `IN (SELECT ...)` for plan stability.

### Planned transaction inheritance

When `executeAndAdvance` creates an executed transaction, it copies `planned_transaction_tags` into `transaction_tags` inside the same `withTransaction` block, ensuring atomicity.

### Bulk-tag endpoint

`POST /api/transactions/bulk-tag` operates in a single database transaction (all-or-nothing). Slugs are resolved to IDs upfront; unknown slugs cause a 400 before any writes occur.

## Consequences

**Positive**
- Users can group transactions across categories (trips, projects, events) without modifying the category hierarchy.
- Tags auto-create on first use; no upfront setup required.
- Soft-delete + reactivation preserves history without orphaning chips.
- Bulk-tag toolbar lets users apply or remove tags from multiple rows in one action.

**Negative / Trade-offs**
- Slug immutability means renames require a new tag + bulk migration (future feature).
- Unicode dropped from slugs in v1 — users with non-ASCII naming conventions will see truncated slugs.
- Two-query read path adds latency proportional to batch size; acceptable at typical page sizes.

## Related

- [[docs/features/tags|Tags Feature Doc]]
- [[docs/adr/index|All ADRs]]
