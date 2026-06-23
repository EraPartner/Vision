---
title: Feature - Internal Transfers
type: feature
status: active
date: 2026-06-18
tags: [feature, transfers, internal-transfer, cash-flow, reconciliation, detection, statistics, aggregations, adr-083, migration-0044, migration-0045]
description: Automatic detection of transfers between a user's own accounts via a windowed cross-batch reconciliation pass, persisted as a transfer_peer_id pairing, and excluded from cash-flow aggregates by default with a global includeTransfers toggle.
aliases: [internal transfers, transfer detection, transfer exclusion]
---

# Feature: Internal Transfers

> [!abstract] Overview
> Money moved between a user's own accounts (e.g. checking → savings) is recorded as two
> equal-and-opposite transactions. Counted naively they **inflate both gross income and gross
> spending** while netting to zero. Vision detects these pairs and excludes them from cash-flow
> figures by default. See [[docs/adr/083-internal-transfer-detection|ADR-083]].

## Data model

Three columns on `transactions` (migration [[alembic/versions/0044_add_transfer_pairing.py|0044]]):

| Field | Type | Meaning |
|-------|------|---------|
| `is_transfer` | BOOLEAN, default false | Excluded from cash-flow aggregates when true |
| `transfer_peer_id` | INTEGER, self-FK `ON DELETE SET NULL` | The matched leg |
| `transfer_source` | TEXT `auto` \| `manual` | `manual` marks are sticky (never overwritten by auto-detection) |

Storing the peer link (not just a flag) makes matches explicit, reversible, and re-evaluable when a
leg is edited or deleted.

## Detection — windowed, cross-batch

`transferReconciliationService.reconcileTransfers()` matches **across the whole recent corpus, not
per import batch**, so the cross-bank case works: the two legs can arrive in separate imports days
apart, and the late-arriving leg pairs with the still-open earlier one.

A candidate pair is: opposite sign, **equal amount, same currency**, on **two different own
`bank_account`s**, within **±3 days**. The pure matcher
([[apps/node-backend/src/services/calculations/transfers.js]]) classifies candidates:

- **Single unambiguous candidate on each side → auto-marked** (`transfer_source = 'auto'`).
- **Contended (multiple candidates) → suggestion only** — surfaced via the API, never auto-picked.

Reconcile is **idempotent and self-correcting**: it releases pairs invalidated by an edit and
orphans left by a deletion before re-matching.

**Triggers:** after every import commit (before the MV refresh), after manual transaction
mutations (the transactions route uses `scheduleReconcile`), and a one-time **backfill on upgrade**
(`backfillTransfersOnce`, gated by the `transfers_backfilled` setting).

## Exclusion

Marked transfers are excluded from income/spending **everywhere by default**:

- Materialized views `mv_monthly_summary`, `mv_category_totals`, `mv_cashflow_daily`
  (`AND t.is_transfer = false`). **`mv_bank_balances` is NOT excluded** — account balances must
  reflect the real money movement of a transfer.
- The `agg_recipient_totals` trigger (migration [[alembic/versions/0045_exclude_transfers_from_aggregations.py|0045]]) — a row counts only when `is_active AND NOT is_transfer`.
- The base monthly / statistics / recipient queries.
- The cash-flow forecast is **net-based**, so same-day transfer legs already net to zero — no change needed.

### `includeTransfers` toggle

The `includeTransfers` user setting (default `false`) re-includes transfers. When on, the monthly
summary and statistics reads **bypass the transfer-excluding MVs** and drop the predicate
(`getIncludeTransfers()` in `infoRepositoryHelpers`). Recipient insights and the MV-backed category
breakdown remain exclude-only.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/transactions/transfer-suggestions` | Ambiguous matches awaiting confirmation |
| POST | `/api/transactions/transfers` | Manually confirm a pair `{ aId, bId }` |
| DELETE | `/api/transactions/transfers/:id` | Clear a transfer mark (and its peer) |

The toggle is read/written through the generic settings API (`includeTransfers` key).

## Out of scope

- **Cross-currency** transfers (amounts differ) — manual marking only.
- **Never-imported counterpart** (only one bank tracked) — stays counted; manual single-leg mark is the escape hatch.

## Related
- [[docs/adr/083-internal-transfer-detection|ADR-083]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/features/import|Import Feature]]
- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Aggregation Strategy]]
