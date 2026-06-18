---
title: ADR-083 Internal Transfer Detection and Exclusion
type: adr
date: 2026-06-18
tags: [adr, transfers, internal-transfer, cash-flow, statistics, aggregations, import-pipeline, transfer-detection, migration, reconciliation]
description: Auto-detect transfers between a user's own accounts via a windowed, cross-batch reconciliation pass, persist the pairing as transfer_peer_id, and exclude marked transfers from cash-flow aggregates by default with a global toggle.
aliases: [internal transfers, transfer detection, transfer exclusion, transfer_peer_id]
---

# ADR-083: Internal Transfer Detection and Exclusion

## Status
Proposed

## Date
2026-06-18

## Context

Vision has **no transfer concept**. Income vs. spending is defined purely by amount sign
(`amount >= 0` → income, `amount < 0` → spending), and that rule is duplicated across the
`mv_monthly_summary` materialized view, several `infoRepository*` queries, the cash-flow
forecast inputs, and the PDF report builder. The `transactions` table has no `type` or
`is_transfer` column.

A movement between two of the user's **own** accounts (e.g. checking → savings) is recorded as
two transactions — a negative outflow and a positive inflow — that net to zero but **inflate
both gross income and gross spending** in every aggregate. Today the only mitigation is the user
manually configuring category/recipient **exclusions** (`excludedCategoryIds` /
`excludedRecipientIds`). That is an end-user burden and is easy to forget.

A naive "detect pairs within the import batch" approach fails the common **cross-bank** case: the
two legs arrive in **separate import batches** (Bank A's CSV today, Bank B's CSV days later), often
with a 0–2 day interbank settlement lag. The outflow has no counterpart at the moment it is
imported; the match only becomes possible once the other bank's statement is imported.

## Decision

Introduce a first-class internal-transfer concept with **persisted pairing** and a
**windowed, cross-batch reconciliation pass**, and exclude marked transfers from cash-flow
aggregates by default.

### Data model
- Add to `transactions`:
  - `transfer_peer_id INTEGER NULL` — self-referential FK → `transactions(id)` `ON DELETE SET NULL`.
  - `is_transfer BOOLEAN NOT NULL DEFAULT false`.
  - `transfer_source TEXT` — `'auto' | 'manual'` (so auto-detection never overrides a manual mark).
- Storing the **peer link** (not just a boolean) makes matches explicit, reversible, and
  re-evaluable when a leg is edited or deleted. Indexes: `(currency, amount, date)` to drive
  matching; partial index `WHERE is_transfer`.

### Detection — windowed reconciliation, not batch-scoped
- Detection runs as a reconciliation pass **after every import commit** and **on manual
  add/edit/delete**, matching unmatched candidates against the **full recent corpus**, not just the
  current batch. This is what makes the multi-bank / multi-batch case work: the late-arriving inflow
  matches the previously-imported, still-unmatched outflow.
- A transfer pair = opposite sign, **equal amount, same currency**, on **two different own
  `bank_account`s**, within **±N days** (default 3). Every `bank_account` in `transactions` is by
  definition one of the user's own accounts, so cross-account equal-and-opposite matching is reliable
  for the common case. Memo hints (`transfer`, `overschrijving`, `storting`, …) raise confidence but
  are not required.
- **Confidence / apply:**
  - Exactly one candidate within the window → **high confidence → auto-mark** both legs
    (`is_transfer = true`, `transfer_peer_id` set, `transfer_source = 'auto'`).
  - Multiple candidates → **ambiguous → suggestion only**; never auto-pick.
- **Re-evaluation:** editing a leg's amount/date or deleting it re-runs reconciliation for the peer
  and un-pairs orphans, so a "transfer" can never end up with a missing counterpart silently dropped
  from income.
- **Manual override:** users can mark/unmark any transaction as a transfer (`transfer_source =
  'manual'`); manual state is sticky and not overwritten by auto-detection.

### Exclusion
- Marked transfers are **excluded from income/spending in all aggregations by default**, governed by
  a single global setting `includeTransfers` (default `false`) in `user_settings`. Implemented as one
  consistent predicate (`AND NOT is_transfer` unless the toggle is on) applied at every aggregation
  site: `mv_monthly_summary`, the `infoRepository*` queries, forecast inputs, and reports. The
  trigger-maintained `agg_recipient_totals` sync is updated to skip transfer rows.

### Backfill
- A one-time reconciliation pass over all existing transactions runs **on upgrade** so historical
  figures are corrected, not just new activity.

### Out of scope (explicit)
- **Cross-currency** transfers (amounts differ; e.g. EUR→USD via Wise) — left to manual marking.
- **Never-imported counterpart** (only one bank tracked) — no pair can exist; the transaction stays
  counted. Manual single-leg marking is the escape hatch. This is a user data-completeness choice,
  not a system responsibility.

## Consequences

**Positive**
- Internal transfers stop inflating gross income/spending automatically and consistently across
  every view. The cross-bank / multi-batch case is handled by reconciliation rather than ignored.
- The peer link makes the relationship explicit, reversible, and self-healing on edit/delete.
- Auto-marking high-confidence pairs means figures self-correct without user action; ambiguity is
  surfaced rather than guessed.

**Negative / cost**
- Cross-cutting change: the sign-based income/spending rule lives in ~6 places that must **all**
  honor the flag, or pages will disagree. The `mv_monthly_summary` change requires a migration +
  refresh.
- New migration (two columns + source + indexes), a new reconciliation service, pipeline/service
  hooks, a backfill, and a new API surface (transfer suggestions list/confirm/reject, manual
  mark/unmark, the toggle) → `docs/reference/api-endpoint-matrix.md` must be updated.

**Risks / mitigations**
- Heuristic false positives (a same-day equal-and-opposite refund) — mitigated by requiring **two
  different own accounts**, the single-candidate confidence rule, and easy un-marking.
- Reconciliation cost — bounded by the ±N-day window and the `(currency, amount, date)` index.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/features/import|Import Feature]] (pipeline stages, dedup, recurring detection)
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]
- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Aggregation Strategy]] (`mv_monthly_summary`, `agg_recipient_totals`)
