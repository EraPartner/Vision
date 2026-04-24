---
title: ADR-010 - Phase 1 Aggregation Strategy
type: adr
status: Accepted
date: 2026-04-16
tags: [adr, architecture, performance, database, aggregations, phase-1, refactor]
description: Postgres-backed aggregations (MVs + trigger-maintained tables) as the caching tier instead of Redis or in-process caches
aliases: [adr-010, aggregation-strategy, aggregation-layer]
---

# ADR-010: Phase 1 Aggregation Strategy

## Status
Accepted (Phase 9 Cutover Complete)

## Date
2026-04-16

## Updated
2026-04-25 — Phase 9 cutover complete; shadow mode validation done, legacy infoRepository fallback removed from wiring.

## Context

The Vision dashboard and analytics pages rely on expensive aggregations (monthly summaries, category breakdowns, recipient insights, cashflow, performance, and owed balances) that currently compute on every request via the `infoRepository` monolith (~1433 LOC, contains all calc logic inline, performs full-table scans, and blocks on repeated aggregation requests during concurrent user access).

User pain points:
- Dashboard loads slowly (4–6 API calls in sequence, ~500–800ms aggregate latency at peak usage)
- Recipient page filters trigger O(n) traversals of all transactions
- Owed balance queries scan all splits + payments on each load

Two traditional caching strategies were evaluated:

### Alternative 1: Redis Cache Layer
- Pros: Decouples from database, supports TTL-based invalidation, horizontal scaling
- Cons: Adds deployment complexity, introduces another process to manage, potential cache coherence issues across workers, TTL misses lead to cache misses + slow requests

### Alternative 2: In-Process Memory Caches (LRU)
- Pros: No external dependencies, low latency
- Cons: Per-worker isolation (stale data across restarts), memory pressure on Node, manual invalidation logic, doesn't scale to multi-server

### Decision: PostgreSQL-Backed Aggregations

**Chosen strategy:** Materialized Views + trigger-maintained tables as the single caching tier. All aggregation reads happen against pre-computed Postgres artifacts, never raw table scans.

Two complementary maintenance approaches:

1. **Materialized Views** — for expensive temporal aggregates (monthly rollups, category breakdowns, daily cashflow). Refreshed on-demand after mutations via `refreshAggregations()`.

2. **Trigger-maintained tables** — for real-time aggregates that must be consistent with the source tables (recipient totals, split outstanding balances). Updated automatically by row-level triggers whenever source data changes.

## Decision

### Architecture

1. **Legacy aggregation layer** (existing in Phase 0):
   - `mv_monthly_summary` — monthly income/spending by category
   - `mv_category_totals` — all-time category totals
   - `mv_cashflow_daily` — daily cashflow (6 months + current)
   - `mv_bank_balances` — running balances per bank account
   - Refreshed via `materializedViewService.refreshMaterializedViews()` + debounce

2. **Phase 1 aggregation additions** (introduced in migration 0026):
   - `mv_recipient_monthly` — monthly totals per recipient per currency, rolled up to primary recipient; scoped to 24 months for freshness; unique index enables concurrent refresh
   - `agg_recipient_totals(recipient_id, currency)` — running totals per recipient per currency (all-time); trigger-maintained on `transactions` insert/update/delete
   - `agg_split_outstanding(split_id)` — outstanding balance per split; trigger-maintained on `transaction_splits` and `split_payments` changes

3. **Orchestrator** (`aggregationRefresh.js`):
   - `refreshAggregations()` — refreshes both legacy + Phase 1 MVs in parallel; no-op for trigger-maintained tables
   - `scheduleAggregationRefresh()` — debounced (1s) refresh after single-row mutations, coalesces rapid changes
   - `TRIGGER_MAINTAINED_TABLES` constant documents self-maintained tables (app code never refreshes these)

### Call-site Pattern

After bulk import:
```javascript
await aggregationService.refreshAggregations();
```

After single-row mutation (edit/delete transaction):
```javascript
await aggregationService.scheduleAggregationRefresh();
```

Cron refresh (optional, for safety):
```javascript
// Nightly task
setInterval(() => aggregationService.refreshAggregations(), 24 * 60 * 60 * 1000);
```

### Timezone Handling

Materialized views use `AT TIME ZONE` literal to bucket aggregates in `APP_TIMEZONE`, not UTC. See [[docs/adr/009-timezone-policy|ADR-009]].

Example:
```sql
date_trunc('month', t.date AT TIME ZONE 'Europe/Brussels')
```

### Maintenance Strategy

| Artifact | Maintenance | Refresh trigger | Latency |
|----------|-------------|-----------------|---------|
| `mv_monthly_summary` | View | After import, debounce after edit | ~100ms refresh |
| `mv_category_totals` | View | After import, debounce after edit | ~50ms refresh |
| `mv_cashflow_daily` | View | After import, debounce after edit | ~30ms refresh |
| `mv_bank_balances` | View | After import, debounce after edit | ~20ms refresh |
| `mv_recipient_monthly` | View | After import, debounce after edit | ~100ms refresh |
| `agg_recipient_totals` | Trigger | Real-time (AFTER trigger) | <1ms |
| `agg_split_outstanding` | Trigger | Real-time (AFTER trigger) | <1ms |

### Fallback Behavior

First call to `REFRESH MATERIALIZED VIEW CONCURRENTLY` after migration may fail with "has not been populated" error. Orchestrator falls back to non-concurrent refresh and retries the concurrent refresh on subsequent calls once the view has been populated.

## Consequences

### Positive

- **Single source of truth:** All dashboard aggregates point to Postgres; no cache coherence across Redis instances or in-process worker state
- **Deterministic results:** MVs with unique indexes prevent duplicate rows; trigger-maintained tables use UPSERT semantics for idempotency
- **No external dependencies:** Stays within the existing Postgres deployment; no Redis, memcached, or external cache service
- **Concurrent reads:** Readers pull from pre-computed views while refreshes happen in parallel (via CONCURRENTLY)
- **Failover safety:** If refresh fails, readers still get stale-but-consistent data from the previous refresh; no cache misses leading to slow fallback queries
- **Timezone-aware:** All aggregates bucket using `APP_TIMEZONE` consistently with [[docs/adr/009-timezone-policy|ADR-009]]

### Negative

- **Refresh latency:** After a large import or bulk edit, aggregates are stale until refresh completes (100–200ms typical, higher on slow hardware)
- **Storage overhead:** Materialized views duplicate data from source tables; not recommended for datasets >10GB (Vision is well under this)
- **Trigger maintenance cost:** Row-level triggers add per-mutation latency (~1ms per trigger); negligible for single-row edits but accumulates during bulk operations before they bulk-commit
- **Unique index requirement:** Each MV used in CONCURRENTLY refresh needs a unique index; adds minor maintenance burden when MVs are altered

### Rollback

If the strategy fails (e.g., refresh becomes a bottleneck), rollback is:
1. Remove `aggregationRefresh.js` call-sites (revert to in-process calc in routes)
2. Drop triggers and agg tables: `DROP TRIGGER ... ON transactions; DROP TABLE agg_recipient_totals CASCADE;`
3. Keep MVs as optional read-only optimization (or drop them too)
4. Code is backward-compatible; no schema breaking changes

## Migration

### Phase 1 (current)
- Alembic migration 0026 adds: `pg_trgm` index on `recipients.normalized_name`, `mv_recipient_monthly`, `agg_recipient_totals`, `agg_split_outstanding`, all supporting triggers and functions
- `aggregationRefresh.js` service created; not yet wired into route handlers
- Tests added: module surface assertions + migration artifact smoke tests

### Phase 2
- `monthly.js`, `category.js`, `recipient.js`, `cashflow.js` calc modules replace inline infoRepository logic
- `/api/aggregations/*` endpoints switch to call `refreshAggregations()` and read from MVs/agg tables
- Golden-fixture regression tests added for each calc module

### Phase 3–4
- Loan/recurrence calcs migrate to timezone-aware math
- Owed balance endpoint switches to `agg_split_outstanding`

### Phase 6
- Fuzzy recipient auto-link uses `idx_recipients_normalized_name_trgm` GIN index for O(log n) matching

### Phase 8
- Property-based tests confirm no drift across timezones when bucketing transactions

## Related

- [[docs/adr/009-timezone-policy|ADR-009: Timezone Policy]] — aggregates bucket in configured `APP_TIMEZONE`
- [[docs/adr/008-performance-page-server-computed-response|ADR-008: Performance Page Server-Computed Response]] — precursor to this decision
- [[docs/performance/materialized-views|Materialized Views]] — full technical reference
- [[docs/reference/data-model|Data Model Reference]] — entity definitions
- Alembic migration: [[alembic/versions/0026_finance_aggregations.py|0026_finance_aggregations.py]]
- Orchestrator service: [[apps/node-backend/src/services/aggregationRefresh.js|aggregationRefresh.js]]
