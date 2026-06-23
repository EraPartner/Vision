---
title: ADR-094 Balance Reconciliation & Drift Detection
type: adr
date: 2026-06-18
tags: [adr, accounts, reconciliation, drift, statement-balance, adr-088]
description: Store an authoritative statement balance per account and diff it against the computed ledger balance to surface drift ("drifted €12.40 — missing a transaction"), now that accounts have identity.
aliases: [reconciliation, drift detection, statement balance]
---

# ADR-094: Balance Reconciliation & Drift Detection

## Status
Proposed

## Date
2026-06-18

## Context

Imports miss rows, manual entries get fat-fingered, and there was no way to tell: the running
balance was just whatever the transactions summed to. Now that an account has identity
(ADR-088), it can also carry an **authoritative statement balance** the user reads off their
bank, and Vision can flag when its computed balance disagrees.

## Decision

Add to `accounts`:
- `statement_balance NUMERIC(15,2)` — what the bank says.
- `statement_balance_date DATE` — as of when.

**Drift** per account = `statement_balance − computed_balance`, where `computed_balance` is the
`balance` of the account's most recent active transaction (the same figure the bank-balances
widget reports, ADR-010/ADR-088). A non-zero drift means the ledger and the bank disagree — most
often a missing or duplicated transaction since the last import.

- The accounts list/detail expose `computed_balance` and `drift` (computed, not stored); the UI
  shows a drift badge ("drifted €12.40") when `statement_balance` is set and drift ≠ 0.
- `statement_balance` / `statement_balance_date` are editable via the account PATCH (validated:
  numeric balance, ISO date).
- This is descriptive only — it never auto-creates a balancing transaction; it points the user at
  the discrepancy.

## Consequences

**Positive**
- Catches missing/duplicate transactions early, per account, with a concrete euro figure.
- Reuses the existing computed-balance figure (no new balance engine).

**Negative / cost**
- One small migration (two nullable columns); the drift figure is only as useful as the user
  keeping the statement balance current.

**Risks / mitigations**
- *Stale statement balance reads as drift* → show `statement_balance_date` alongside so the user
  knows how fresh it is; drift only shown when a statement balance exists.
- *Cross-currency accounts* → drift compares same-currency figures (the account's currency); no FX
  in the diff.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/088-account-entity|ADR-088: Account Entity]]
- [[docs/adr/010-phase1-aggregation-strategy|ADR-010]] (computed balance source)
