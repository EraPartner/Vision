---
title: ADR-127 No Synthetic FX for Account Totals
type: adr
date: 2026-09-04
tags: [adr, accounts, foreign-exchange, balances, merge-preview, data-integrity]
description: Exclude native account balance partitions from converted totals when a required exchange rate is unavailable, expose the native amounts, and mark every affected total incomplete.
aliases: [incomplete account balance, missing exchange rate]
---

# ADR-127: No Synthetic FX for Account Totals

## Status

Accepted

## Context

The account hub and account-merge preview used the generic current-rate converter. Its legacy
fallback treats an unknown source currency as 1:1 and converts to EUR when the requested target
rate is unknown. Both paths produce a precise-looking number in the wrong unit.

## Decision

Account totals may include a currency partition only when the source and requested target rates
are available. Same-currency partitions require no rate, and EUR is the implicit base currency.
An unsupported partition is excluded from the converted sum. The API also returns all native
partitions, the excluded currency codes, and an incomplete flag.

The accounts hub shows each excluded native amount and marks both the account total and net-cash
total incomplete. The merge preview follows the same rule and shows the excluded native amounts.
No account or merge response substitutes a 1:1 rate.

## Consequences

- Displayed converted totals never invent exchange-rate equivalence.
- A partial sum remains useful, but it is explicitly labelled incomplete.
- Clients must treat `computed_balance` and `projectedBalance` as partial when their corresponding
  incomplete flag is true.
- The generic conversion service keeps its compatibility fallback for unrelated callers; account
  aggregation checks rate availability before calling it.

## Related

- [[docs/adr/094-balance-reconciliation-drift|ADR-094: Balance Reconciliation & Drift Detection]]
- [[docs/api/accounts|Accounts API]]
- [[docs/features/accounts|Accounts]]
- [[docs/adr/index|All ADRs]]
