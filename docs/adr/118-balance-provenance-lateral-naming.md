---
title: Name the Account-Level Lateral for Balance Provenance
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags: [adr, accounts, balances, provenance, adr-094, adr-107]
description: Rename the account-level SQL lateral after balance emission moved to per-currency helpers, so its public name states that it returns provenance only.
---

# ADR-118: Name the Account-Level Lateral for Balance Provenance

## Context

ADR-107 described every current balance as coming from `accountBalanceSql.js`'s account-level
lateral. Multi-currency correctness later moved balance emission to the per-currency lateral and
aggregate helpers. The account-level lateral now returns only `anchor_date` and
`post_anchor_count`; its old `COMPUTED_BALANCE_LATERAL` name falsely suggested that it still
returned a balance.

## Decision

Name the default fragment `BALANCE_PROVENANCE_LATERAL`. Current balances continue to come from
`computedBalanceByCurrencyLateral` or `computedBalanceByCurrencyAggLateral`. The provenance
lateral remains shared by the accounts hub and dashboard so their statement anchor and
post-anchor count stay aligned.

ADR-123 later added the named `balanceProvenanceLateral({ asOfDate })` builder. Production callers
use that builder to bind the application date; the default fragment remains available on the
module's compatibility object for callers that need the default `CURRENT_DATE` expression.

This supersedes only ADR-107's name and its statement that the account-level lateral serves the
balance. ADR-107's product architecture and ADR-094's anchor-plus-delta definition remain active.

## Consequences

- Call sites cannot accidentally infer that the `lb` row contains a balance.
- Current documentation distinguishes numeric balance output from account-level provenance.
- The change is an internal rename; API response fields and balance values do not change.
