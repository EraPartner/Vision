---
title: ADR-130 Canonical biweekly recurrence vocabulary
type: adr
status: accepted
date: 2026-09-07
tags: [adr, recurrence, api, schema, migration-0099, compatibility]
description: Canonicalizes every recurrence wire and storage value to biweekly while accepting the legacy hyphenated portfolio input for one compatibility release.
aliases: [canonical biweekly recurrence, recurrence vocabulary]
---

# ADR-130: Canonical biweekly recurrence vocabulary

## Status

Accepted

## Date

2026-09-07

## Context

Planned transactions stored and emitted `biweekly`, while portfolio transactions used the legacy
PostgreSQL enum value `bi-weekly`. The split vocabulary duplicated frontend types and allowed the
same cadence to behave differently across APIs.

## Decision

Every current wire contract and active table uses `biweekly`.

Migration 0099 converts `portfolio_transactions.recurrence_interval` from the legacy native enum
to `TEXT`, rewrites stored `bi-weekly` rows, and adds the named
`chk_portfolio_transactions_recurrence_interval` constraint. The old enum remains in place because
frozen legacy relations and downgrade paths may still refer to it.

For one compatibility release, portfolio write endpoints accept `bi-weekly` and normalize it at
the request boundary. Reads, generated types, shared runtime constants, and new writes expose only
`biweekly`. Downgrade reverses the stored spelling and casts the active column back to the enum.

## Consequences

- Shared portfolio and planned-transaction code now uses one spelling.
- Current clients receive a smaller, canonical enum.
- Old clients continue to write successfully during the compatibility release.
- PostgreSQL upgrade and downgrade must be exercised before release because the column type changes.
- The compatibility mapper should be removed only after one shipped release and a stored-data check.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/api/investments|Investments API]]
- [[docs/features/plannedTransactions|Planned Transactions]]
- [[docs/reference/data-model|Data Model Reference]]
