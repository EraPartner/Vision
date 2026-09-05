---
title: ADR-123 Effective-Date Current Balances
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags:
  [adr, accounts, balances, effective-date, forecasts, financial-correctness]
description: Keep future-dated ledger rows visible but exclude them from current balances and history until effective, while treating them as scheduled forecast inputs.
aliases: [adr-123, effective-date-current-balances]
---

# ADR-123: Effective-Date Current Balances

## Status

Accepted

## Context

Vision permits a transaction date after the application-timezone current day. Such rows are useful
for scheduled payments and known future income, but the account, bank, net-worth, reconciliation,
merge, and cross-workspace surfaces previously disagreed about whether they were current money.
Some headlines included them while history stopped at today. This made the same ledger produce
different present balances.

## Decision

A transaction becomes effective on its `date`, interpreted against the `APP_TIMEZONE` calendar day.
Future-dated rows remain ordinary visible ledger records, but they do not contribute to a current
balance, balance provenance, reconciliation drift, merge preview, net-worth current point, or
historical point before their date.

Current-balance SQL receives the application date as a bound parameter. Anchor selection and all
post-anchor or unstamped deltas are bounded by that date. The currency population remains unbounded,
so an account or currency represented only by future rows is still visible with a zero current
balance rather than disappearing.

Forecast repositories return future ledger rows separately as `scheduledActual`. Forecast responses
expose them as `scheduled_actual`. They are never training history or actual-to-date. Every forecast
cumulative path applies them on their effective date, independently of the optional
`include_planned` overlay. Pending `planned_transactions` remain optional and separate; executed
plans remain excluded, which avoids double-counting the linked ledger transaction.

## Consequences

- All present-balance surfaces share one effective-date boundary.
- Entering a future transaction cannot change money reported as available today.
- Forecast consumers can distinguish committed ledger entries from optional plans.
- Forecast cache keys carry an effective-date contract version so older cached payloads are not
  served without `scheduled_actual`.
- Unlinked duplicate future ledger and planned rows remain user-data ambiguity. Vision does not
  guess that two independently entered records represent one event.

## Related

- [[docs/adr/009-timezone-policy|ADR-009 Timezone Policy]]
- [[docs/adr/094-balance-reconciliation-drift|ADR-094 Balance Reconciliation Drift]]
- [[docs/adr/107-accounts-budgeting-ux-remake|ADR-107 Accounts Budgeting UX Remake]]
- [[docs/features/accounts|Accounts]]
- [[docs/features/net-worth|Net Worth]]
- [[docs/features/cash-flow-forecast|Cash Flow Forecast]]
