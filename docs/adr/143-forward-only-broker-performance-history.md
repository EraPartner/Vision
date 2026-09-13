---
title: ADR-143 - Forward-Only Broker Performance History
type: adr
status: Accepted
date: 2026-09-13
tags: [adr, portfolio, broker, performance, snapshots, database, backup]
description: Persist a daily account partition from the canonical portfolio summary without inventing or rewriting earlier broker history.
aliases: [broker history, per-broker snapshots]
---

# ADR-143: Forward-Only Broker Performance History

## Status

Accepted

## Context

The current portfolio summary has a parity-checked `byAccount` partition, but historical performance
contains only the global and asset-class series. Replaying old portfolio events with their current
account tags would rewrite history after a holding is moved or an account is renamed. The dormant
`portfolio_snapshot_accounts` relation was populated by that older replay model and cannot prove a
forward-only origin.

## Decision

Migration 0109 creates an empty `portfolio_broker_snapshots` table. The snapshot job first completes
the canonical aggregate history, then writes only the current application date from
`portfolioSummaryService.byAccount`. It collapses contribution rows into one account partition,
preserves `unassigned` holdings as an explicit series, and refuses a day whose partitions do not sum
to the global portfolio value within one-cent tolerance.

The current-day delete and replacement inserts use one transaction. Earlier dates are never updated
or synthesized. Each row copies the account key and display name and intentionally has no account
foreign key, so later retagging, renaming, archival, or deletion cannot mutate a recorded day.

`GET /api/info/portfolio-performance/by-broker` returns the frozen series. The Performance page
renders it as a separate chart. The new table is part of the database backup registry.

## Consequences

- The chart begins on the first snapshot run after migration 0109; there is no historical backfill.
- Same-day price or assignment changes replace the current day atomically.
- Historical labels describe the account identity recorded on that day, not the account's current name.
- Downgrade removes only the derived broker-history table and index.

## Related

- [[docs/features/portfolio|Portfolio]]
- [[docs/api/info|Info API]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/adr/index|All ADRs]]
