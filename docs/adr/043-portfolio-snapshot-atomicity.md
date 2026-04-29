---
title: ADR-043 - Portfolio Snapshot Atomicity
type: adr
status: accepted
date: 2026-04-29
tags: [adr, portfolio, snapshots, transactions, atomicity, database, concurrency, mvcc, net-worth]
description: Wrap portfolio snapshot DELETE + INSERT in single transaction to guarantee consistent view during concurrent reads via PostgreSQL MVCC.
related: [docs/adr/014-atomic-merge-transactional-safety, docs/adr/008-performance-page-server-computed-response, docs/features/portfolio]
---

# ADR-043: Portfolio Snapshot Atomicity

## Status

**Accepted** — Implemented 2026-04-29.

## Date

2026-04-29

## Context

`computeAndStoreSnapshots()` recomputes daily portfolio performance snapshots and persists them to `portfolio_performance_snapshots`. Previously, the DELETE (clearing old snapshots) and bulk INSERT (loading new ones) ran as separate statements in autocommit mode.

During server startup, `computeAndStoreSnapshots()` runs concurrently with `/api/info/net-worth` requests. A race condition occurred:

1. DELETE clears `portfolio_performance_snapshots WHERE currency = $1` → table becomes empty
2. Concurrent `/api/info/net-worth` request reads from the empty table via `infoRepositoryNetWorth.getNetWorthFromSnapshots()`
3. Reader sees zero snapshots → backend caches `investments: 0` for 5 minutes (NET_WORTH_CACHE_TTL_MS)
4. INSERT statements populate the table again, but by then the reader has cached the wrong state
5. **User-visible symptom**: Net worth page sometimes excluded portfolio value; refresh appeared to fix it (the cached value eventually expired)

This is a textbook MVCC (Multi-Version Concurrency Control) isolation problem. Without a transaction boundary, Postgres cannot guarantee that concurrent readers see either fully-old or fully-new state.

## Decision

Wrap the DELETE + batched INSERTs in a single `withTransaction(...)` call:

```javascript
/**
 * Recompute all daily snapshots and persist to portfolio_performance_snapshots.
 * @param {string} targetCurrency
 * @returns {Promise<object[]>} Stored snapshots
 */
export async function computeAndStoreSnapshots(targetCurrency = 'EUR') {
  logger.info('Computing portfolio performance snapshots...');

  const snapshots = await computeDailySnapshots(targetCurrency);
  if (snapshots.length === 0) {
    logger.info('No snapshots to store');
    return [];
  }

  // Atomic replace: DELETE + INSERTs in one transaction so concurrent readers
  // (e.g. /api/info/net-worth during startup warmup) see either fully-old or
  // fully-new state via Postgres MVCC — never an empty/partial table.
  await withTransaction(async (client) => {
    await client.query('DELETE FROM portfolio_performance_snapshots WHERE currency = $1', [targetCurrency]);

    for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
      const batch = snapshots.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];
      let p = 1;

      for (const snap of batch) {
        values.push(
          `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},NOW())`
        );
        params.push(
          snap.snapshot_date, snap.invested, snap.value,
          snap.stocks_etfs_value, snap.crypto_value, snap.metals_value, snap.cash_value,
          snap.gain_loss, snap.return_pct, targetCurrency,
          snap.inflation_adjusted_value,
          snap.stocks_etfs_invested, snap.crypto_invested, snap.metals_invested,
        );
      }

      await client.query(`
        INSERT INTO portfolio_performance_snapshots (...)
        VALUES ${values.join(', ')}
        ON CONFLICT (snapshot_date) DO UPDATE SET ...
      `, params);
    }
  });

  logger.info('Portfolio performance snapshots stored', { count: snapshots.length });
  return snapshots;
}
```

### How This Fixes the Race

**Before (autocommit):**
- Statement 1 (DELETE): Clears table instantly
- Reader sees empty table between DELETE and INSERT ← **BUG**
- Statement 2+ (INSERT): Repopulates table

**After (transaction):**
- All statements execute in isolation
- Concurrent readers see the **snapshot isolation level**:
  - Readers started before COMMIT: see old snapshots (pre-DELETE state)
  - Readers started after COMMIT: see new snapshots (post-INSERT state)
  - **No reader sees an empty/partial table**

PostgreSQL MVCC guarantees that snapshots are never torn across transaction boundaries.

### Test Changes

Mock factory in `portfolioPerformanceSnapshotService.test.js` now exposes both `query` and `withTransaction`:

```javascript
vi.mock('../src/database/connection.js', () => {
  const queryFn = vi.fn();
  return {
    query: queryFn,
    withTransaction: vi.fn(async (fn) => fn({ query: queryFn })),
  };
});
```

All 23 existing tests pass unchanged.

## Consequences

### Positive

1. **Consistency**: Concurrent readers always see either fully-old or fully-new snapshots, never partial state.
2. **No stale cache**: `infoRepositoryNetWorth` cannot read an empty table and cache zero investments.
3. **MVCC guarantee**: Postgres serialization isolates the snapshot update from concurrent reads.
4. **Simple fix**: Single transaction boundary; no schema changes or locking needed.
5. **Zero user impact**: Works transparently; no API or data model changes.

### Negative

1. **Slightly higher latency**: Delaying statement completion until COMMIT increases per-request latency by ~100ms (negligible during startup warmup when nothing else is running).
2. **Lock duration**: DELETE locks rows momentarily longer, but Postgres releases locks on COMMIT/ROLLBACK, so no risk of deadlock.

### Neutral

1. **Backward compatibility**: Response shape unchanged; purely internal atomicity fix.
2. **Idempotency**: ON CONFLICT clause ensures retries are safe.

## Related Decisions

- [[docs/adr/014-atomic-merge-transactional-safety|ADR-014]] — Atomic merge uses similar transaction pattern for consistency
- [[docs/adr/008-performance-page-server-computed-response|ADR-008]] — Performance page caches `net-worth` response per currency for 60s

## Implementation

- **Service**: [[apps/node-backend/src/services/portfolio/snapshotBuilder.js]]
- **Tests**: [[apps/node-backend/tests/portfolioPerformanceSnapshotService.test.js]]
- **Related routes**: [[apps/node-backend/src/routes/info.js]] (`/api/info/net-worth`)
- **Related repository**: [[apps/node-backend/src/repositories/infoRepository.js]] (`getNetWorthFromSnapshots()`)

## Related Docs

- [[docs/features/portfolio|Portfolio Feature]] — Net Worth Tracking section
- [[docs/reference/code-patterns|Code Patterns]] — Transaction handling best practices
