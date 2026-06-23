---
title: ADR-086 - Currency Integrity (NOT NULL + ISO CHECK + EUR Default)
type: adr
status: accepted
date: 2026-06-18
tags: [adr, database, currency, constraints, migrations, integrity, transactions, planned-transactions]
description: transactions.currency and planned_transactions.currency are made NOT NULL with DEFAULT 'EUR' and an ISO-4217 format CHECK. Migration 0046 authored, pending apply.
aliases: [adr-086, currency-integrity, currency-not-null]
---

# ADR-086: Currency Integrity (NOT NULL + ISO CHECK + EUR Default)

## Status
Accepted

## Date
2026-06-18

## Context

`transactions.currency` and `planned_transactions.currency` were nullable `VARCHAR(3)` columns with no format constraint. Every raw bank table stores `currency ... NOT NULL`, and every read path in the backend already coalesces a missing currency to `'EUR'` (e.g. `infoRepositoryBanks` uses `r.currency || 'EUR'`). A NULL currency forces those implicit EUR assumptions downstream and allows malformed codes (e.g. `'us'`, `'USDT1'`) to slip in silently.

Three INSERT paths in the codebase wrote explicit NULL for currency when no currency was provided: `transactionRepository.create`, `plannedTransactionRepository.create`, and `importPipeline/commit.js`.

## Decision

Migration `0046_currency_integrity.py` hardens the currency columns in three steps:

1. **Backfill:** UPDATE both tables — rows with NULL currency set to `'EUR'`.
2. **Format check:** `ADD CONSTRAINT chk_{table}_currency_iso CHECK (currency ~ '^[A-Z]{3}$') NOT VALID` — enforced for new and updated rows immediately; legacy rows are validated retroactively by follow-up migration `0049_validate_currency_checks` (normalises trim/case-fixable codes, then `VALIDATE CONSTRAINT`).
3. **Lock:** `ALTER COLUMN currency SET DEFAULT 'EUR'; ALTER COLUMN currency SET NOT NULL` — the column cannot regress to an unknown state.

A coupled app change ships in the same commit: the three INSERT paths that previously wrote NULL now write `'EUR'`. Without this change those inserts would violate NOT NULL after the migration is applied.

Downgrade removes `NOT NULL`, `DEFAULT`, and the CHECK but intentionally does not restore which rows were originally NULL (the EUR backfill is kept).

> [!warning] Migration status: AUTHORED, NOT YET APPLIED
> `alembic/versions/0046_currency_integrity.py` exists in the repository but has not been run against any database. Apply with `bun run db:upgrade` (or `alembic upgrade 0046_currency_integrity`). The app code change is already live.

## Consequences

**Positive:**
- Read paths can trust `currency IS NOT NULL` without defensive coalescing.
- Invalid currency codes are rejected at INSERT/UPDATE time rather than silently stored.
- `DEFAULT 'EUR'` means simple inserts that omit `currency` are still valid.

**Negative:**
- The NOT VALID CHECK means legacy malformed codes (if any) remain in existing rows until migration `0049` runs `VALIDATE CONSTRAINT`; if a long-lived DB holds un-normalisable codes (e.g. `EURO`, `€`), `0049` aborts in its transaction and an audit/fix pass is needed first.
- The downgrade is partially irreversible — EUR-backfilled rows cannot be distinguished from originally-EUR rows.

**Alternative considered:** Format CHECK only, leaving the column nullable — rejected because it preserves the "unknown currency" state that the read layer already papers over. The constraint without NOT NULL would not eliminate the coalesce assumptions.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/reference/migration-dependencies|Migration Dependencies]] — migration 0046 in Group 7
- [[docs/reference/data-model|Data Model Reference]] — Transaction, PlannedTransaction currency field
- [[docs/reference/database-query-patterns|Database Query Patterns]] — Currency Integrity constraint section
- [[alembic/versions/0046_currency_integrity.py]]
- [[alembic/versions/0049_validate_currency_checks.py]] — retroactive validation follow-up
