---
title: "ADR-068: Drop mv_recipient_monthly Materialized View"
type: adr
status: Accepted
date: 2026-06-01
tags: [adr, database, materialized-views, aggregations, write-amplification, performance, migration-0038]
description: Drop the mv_recipient_monthly materialized view (migration 0038) — it was never read after agg_recipient_totals replaced it. Eliminates write-amplification on every transaction mutation. Downgrade recreates the 24-month version.
aliases: [mv-recipient-monthly, drop-recipient-monthly-mv, migration-0038]
---

# ADR-068: Drop mv_recipient_monthly Materialized View

## Status

Accepted

## Date

2026-06-01

## Context

`mv_recipient_monthly` was introduced in the Phase 1 aggregation refactor (ADR-010, migration 0035) as a pre-computed 24-month window of per-recipient monthly totals bucketed in `APP_TIMEZONE`.

At the same time, the `agg_recipient_totals` trigger-maintained table was introduced for all-time running totals per recipient per currency. As the application evolved, all recipient-insights queries were rewritten to use `agg_recipient_totals` (which provides real-time accuracy at sub-millisecond latency via row-level triggers). The materialized view was never used by any live code path.

Despite being unread, `mv_recipient_monthly` continued to consume resources:

- `aggregationRefresh.js` scheduled a `REFRESH MATERIALIZED VIEW CONCURRENTLY` on every transaction mutation (debounced 1 s), even though no query consumed the result.
- The refresh locks the view's unique index during the concurrent rebuild, adding latency on write-heavy import sessions.
- The aggregation envelope `source` field for recipient insights was incorrectly set to `'mv'` (reflecting the old code path) rather than `'live'`.

## Decision

1. Migration `0038_drop_mv_recipient_monthly.py` drops `mv_recipient_monthly`. The `downgrade()` path recreates the 24-month version for safe rollback.

2. `aggregationRefresh.js` no longer calls `REFRESH MATERIALIZED VIEW` for `mv_recipient_monthly`. The schedule is removed.

3. The recipient-insights aggregation envelope `source` field is corrected from `'mv'` to `'live'` to accurately reflect that results come from the trigger-maintained `agg_recipient_totals` table.

## Consequences

**Positive:**
- Write-amplification removed: transaction mutations no longer trigger MV refresh work that produced no readable output.
- Import sessions with thousands of rows will complete faster (no background concurrent refresh competing for the index lock).
- Source field in aggregation envelopes is now accurate.

**Negative:**
- Rollback requires running `alembic downgrade` to recreate the view before code that references it can be re-enabled.
- If a future query needs per-recipient monthly granularity, `agg_recipient_totals` only provides all-time totals — a new time-windowed aggregation would need to be built, either as a live SQL query or a new MV.

**Neutral:**
- `agg_recipient_totals` (trigger-maintained, real-time) is unchanged.
- No frontend or API contract changes.

## Related

- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Phase 1 Aggregation Strategy]]
- [[docs/performance/materialized-views|Materialized Views & Aggregation Strategy]]
- [[docs/reference/migration-dependencies|Migration Dependency Graph]]
- [[docs/adr/index|All ADRs]]
