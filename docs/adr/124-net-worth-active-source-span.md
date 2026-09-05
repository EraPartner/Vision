---
title: ADR-124 Net-Worth History Requires an Active Source
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags: [adr, net-worth, history, inactive-transactions, financial-correctness]
description: Start net-worth history only from an active valuatable transaction or an investment snapshot; inactive-only ledgers have no series.
aliases: [adr-124, net-worth-active-source-span]
---

# ADR-124: Net-Worth History Requires an Active Source

## Status

Accepted

## Context

The net-worth date probe fell back to the earliest transaction when it found neither an active
transaction nor an investment snapshot. The value queries then ignored that inactive row. An
inactive-only ledger therefore produced a dated series of zeroes whose length came from data that
could never contribute to any point.

## Decision

Net-worth history starts from the earliest active transaction that the answering balance path can
value, or from the earliest investment snapshot in the requested currency. Inactive transactions
do not establish a history span. If neither active source exists, the endpoint returns the zero
headline with an empty snapshot series.

An investment snapshot remains sufficient by itself. This decision changes only the transaction
fallback; it does not delete or reactivate ledger rows.

## Consequences

- An all-inactive ledger has no synthetic zero history.
- Archived activity remains stored and visible in its own ledger surfaces.
- Existing investment-only histories are preserved.
- The date probe and both downstream valuation paths now agree that transaction sources must be
  active.

## Related

- [[docs/features/net-worth|Net Worth]]
- [[docs/adr/123-effective-date-current-balances|ADR-123 Effective-Date Current Balances]]
