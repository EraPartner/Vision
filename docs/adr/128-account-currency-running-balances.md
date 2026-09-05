---
title: ADR-128 Account-Currency Running Balances
type: adr
date: 2026-09-04
tags: [adr, accounts, transactions, currency, running-balance, data-integrity]
description: Compute and display transaction running balances independently per account and currency, with explicit currency labels and a single-currency account sparkline.
aliases: [currency-aware running balance]
---

# ADR-128: Account-Currency Running Balances

## Status

Accepted

## Context

The transaction list window partitioned only by account. An account containing EUR and USD rows
therefore exposed a precise-looking running balance that added unlike units. The account-detail
sparkline also connected those incomparable points. The main Transactions page did not display the
calculated balance or an explicit ISO currency column.

## Decision

`include_balance=true` partitions the chronological SQL window by `account_id` and
`COALESCE(currency, 'EUR')`. The Transactions page requests the field and displays Currency and
Running balance as read-only columns. Every balance is formatted in its row currency.

The account-detail ledger continues to show every currency partition. Its single header sparkline
uses only rows in the account's declared currency. Splitting the chart into multiple series is not
warranted for the compact header visualization.

## Consequences

- No displayed running balance adds unlike currencies.
- A multi-currency account has one independent balance sequence per currency.
- Legacy NULL currency rows remain compatible through the EUR partition.
- The calculated `running_balance` remains distinct from the import-stamped `balance` column.
- No database migration or API operation change is required; the field's semantics are corrected.

## Related

- [[docs/features/accounts|Accounts]]
- [[docs/features/transactions|Transactions]]
- [[docs/api/transactions|Transactions API]]
- [[docs/adr/088-normalized-account-model|ADR-088]]
