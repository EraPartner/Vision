---
title: Asynchronous Import Materialized-View Refresh
type: adr
status: Accepted
date: 2026-08-31
tags: [adr, imports, materialized-views, eventual-consistency, performance]
description: Import responses confirm durable ledger writes and attempted forecast-cache invalidation while materialized-view projections refresh asynchronously after reconciliation.
aliases: [ADR-115, asynchronous import refresh]
---

# ADR-115: Asynchronous Import Materialized-View Refresh

## Status

Accepted

## Date

2026-08-31

## Context

The budgeting import path awaited all three full materialized-view scans inside `commitBatch`, then requested a second scan from `commitImport`. Imports over 100 rows awaited both rounds. The all-time category projection made response latency grow with the complete ledger, even though the canonical transaction rows were already durable.

The previous policy intentionally returned a fresh derived snapshot. It did not provide a strict guarantee under concurrency because an in-flight refresh queues a later rerun and returns before that rerun completes.

## Decision

`commitBatch` owns durable transaction writes and planned-payment auto-linking only. `commitImport` marks the batch complete, attempts transfer reconciliation, then awaits both forecast Monte Carlo cache-invalidation attempts. Each failure is logged and remains non-fatal. It schedules one coalesced materialized-view refresh and returns without awaiting the scans.

The scheduler uses a five-second trailing debounce with a ten-second maximum wait for a continuous burst. Canonical transaction reads are immediately consistent. MV-backed monthly and category projections are eventually consistent. Statistics process caches are invalidated both when scheduling starts and after a successful refresh, so a request during the scan cannot preserve the old snapshot afterward.

Import rollback follows the same response boundary: both forecast-cache invalidations are attempted before return and materialized views refresh asynchronously.

## Consequences

- Import latency no longer includes one or two complete materialized-view rebuilds.
- The response confirms durable canonical data, completed batch state, attempted transfer reconciliation, and attempted forecast-cache invalidation. It does not confirm refreshed MV projections.
- Dashboard or statistics reads during the refresh window may see the previous MV snapshot.
- A process exit can lose a pending timer. Startup warmup or a later mutation provides recovery.
- Refresh failure remains non-fatal to the committed import and is observable through logs.

## Related

- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Aggregation Strategy]]
- [[docs/features/import|Import System]]
- [[docs/performance/materialized-views|Materialized Views and Aggregation Strategy]]
- [[docs/adr/index|All ADRs]]
