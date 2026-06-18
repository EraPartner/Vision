---
title: ADR-092 Liabilities as Negative Accounts
type: adr
date: 2026-06-18
tags: [adr, accounts, liabilities, mortgage, loan, net-worth, adr-088, adr-093]
description: Model a mortgage/loan as an account of type=liability whose value is its negative ledger balance, so net worth nets debt with no special-casing, and unify the existing loan amortization schedule into the account model via the loan's account_id.
aliases: [liabilities, negative accounts, mortgage account, debt accounts]
---

# ADR-092: Liabilities as Negative Accounts

## Status
Proposed

## Date
2026-06-18

## Context

Debt (a mortgage, a loan) is part of net worth but had no home in the data model. Loans existed
only as planned transactions with an amortization schedule
(`planned_transactions.is_loan` + `planned_transaction_loan_schedule`); their outstanding balance
never reduced net worth. With the account entity (ADR-088) in place, a liability is naturally just
another account — a negative one.

## Decision

A liability is an **account with `type='liability'`** whose value is its **negative ledger
balance** (outstanding debt). Net worth = Σ accounts **including** liabilities, with **no
special-casing** — a liability simply contributes a negative number (formalized in ADR-093).

This already works from the foundation: liability accounts default `in_net_worth=true` (ADR-089,
honored at the net-worth aggregation) and their balances are negative, so they net debt in
automatically. Two concrete consequences this ADR makes explicit:

- **Cash widgets exclude liabilities.** A mortgage is not spendable cash, so `type='liability'`
  accounts are **excluded from the bank-balances widget** (`getBankBalances`) — they still count
  in net worth, just not as cash. Likewise they are `spendable=false`, `liquidity_class=illiquid`
  (the ADR-089 type-driven defaults already set this).

- **Loan-schedule unification.** A loan's planned transaction links to its liability account via
  `account_id` (column already on `planned_transactions`, migration 0050). Payments flow through
  the liability account's ledger, reducing the outstanding balance; the amortization schedule
  remains the source for the principal/interest split and remaining-balance figure. The liability
  account's current value can be reconciled against the schedule's remaining balance (ADR-094) or
  set from a statement.

No new schema is required (`type='liability'` and `account_id` already exist).

## Consequences

**Positive**
- Net worth finally reflects debt, with one rule (Σ accounts) — no mortgage special-case.
- Loans stop being orphaned planned transactions; they belong to a real account.

**Negative / cost**
- Liability balances are only as accurate as their ledger/reconciliation; the amortization
  schedule is the cross-check (ADR-094).
- Cash/liquid calculations must consistently exclude liabilities (done at `getBankBalances`; FIRE
  / rebalancing must follow suit when built).

**Risks / mitigations**
- A liability accidentally showing as cash → excluded by `type='liability'` at the cash widget,
  not just by sign.
- Double-counting a loan (as both a planned transaction and an account balance) → the loan's
  planned transaction links to the liability account; payments are the account's ledger, not a
  separate net-worth line.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/088-account-entity|ADR-088: Account Entity]]
- [[docs/adr/089-account-typed-model|ADR-089: in_net_worth / liquidity / type defaults]]
- [[docs/adr/093-net-worth-sum-of-accounts|ADR-093: Net Worth = Σ Accounts]]
