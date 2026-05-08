import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadAggregationRefresh() {
  vi.resetModules();

  const query = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const refreshLegacyMaterializedViews = vi.fn().mockResolvedValue(undefined);
  const scheduleLegacyRefresh = vi.fn();

  vi.doMock('../src/database/connection.js', () => ({ query }));
  vi.doMock('../src/config/logger.js', () => ({ logger }));
  vi.doMock('../src/services/materializedViewService.js', () => ({
    refreshMaterializedViews: refreshLegacyMaterializedViews,
    scheduleRefresh: scheduleLegacyRefresh,
  }));

  const service = await import('../src/services/aggregationRefresh.js');
  return { ...service, query, logger, refreshLegacyMaterializedViews, scheduleLegacyRefresh };
}

describe('aggregationRefresh', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('exposes the trigger-maintained tables as a frozen array', async () => {
    const { TRIGGER_MAINTAINED_TABLES } = await loadAggregationRefresh();
    expect(TRIGGER_MAINTAINED_TABLES).toEqual(['agg_recipient_totals', 'agg_split_outstanding']);
    expect(Object.isFrozen(TRIGGER_MAINTAINED_TABLES)).toBe(true);
  });

  it('refreshes Phase-1 view via CONCURRENTLY by default', async () => {
    const { refreshAggregations, query, refreshLegacyMaterializedViews } = await loadAggregationRefresh();
    query.mockResolvedValue({ rows: [] });

    await refreshAggregations();

    expect(refreshLegacyMaterializedViews).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_recipient_monthly');
  });

  it('runs legacy and Phase-1 refreshes in parallel', async () => {
    const { refreshAggregations, query, refreshLegacyMaterializedViews } = await loadAggregationRefresh();

    let resolveLegacy;
    refreshLegacyMaterializedViews.mockReturnValue(new Promise((r) => { resolveLegacy = r; }));
    let resolveQuery;
    query.mockReturnValue(new Promise((r) => { resolveQuery = r; }));

    const p = refreshAggregations();
    // Both calls should fire before either settles — parallel, not serial.
    expect(refreshLegacyMaterializedViews).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);

    resolveLegacy();
    resolveQuery({ rows: [] });
    await p;
  });

  it('falls back to non-concurrent refresh when view is unpopulated', async () => {
    const { refreshAggregations, query, logger } = await loadAggregationRefresh();
    query.mockImplementation((sql) => {
      if (sql.includes('CONCURRENTLY')) {
        return Promise.reject(new Error('REFRESH MATERIALIZED VIEW CONCURRENTLY ... has not been populated'));
      }
      return Promise.resolve({ rows: [] });
    });

    await refreshAggregations();

    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls).toContain('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_recipient_monthly');
    expect(sqlCalls).toContain('REFRESH MATERIALIZED VIEW mv_recipient_monthly');
    expect(logger.warn).toHaveBeenCalledWith('Falling back to non-concurrent refresh for mv_recipient_monthly');
  });

  it('logs warning but does not retry when refresh fails for unrelated reason', async () => {
    const { refreshAggregations, query, logger } = await loadAggregationRefresh();
    query.mockRejectedValueOnce(new Error('permission denied'));

    await refreshAggregations();

    expect(query).toHaveBeenCalledTimes(1); // no retry
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to refresh mv_recipient_monthly',
      { error: 'permission denied' },
    );
  });

  it('coalesces concurrent Phase-1 refreshes — second call queues, runs once after first finishes', async () => {
    vi.useFakeTimers();
    const { refreshAggregations, query, refreshLegacyMaterializedViews } = await loadAggregationRefresh();

    let resolveFirst;
    query.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    query.mockResolvedValue({ rows: [] });
    refreshLegacyMaterializedViews.mockResolvedValue(undefined);

    const p1 = refreshAggregations();
    const p2 = refreshAggregations();

    // Second call should not invoke query yet — first is in-flight.
    expect(query).toHaveBeenCalledTimes(1);

    resolveFirst({ rows: [] });
    await p1;
    await p2;

    // Deferred Phase-1 refresh runs after 500 ms.
    await vi.advanceTimersByTimeAsync(500);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('scheduleAggregationRefresh debounces calls into one Phase-1 refresh', async () => {
    vi.useFakeTimers();
    const { scheduleAggregationRefresh, query, scheduleLegacyRefresh } = await loadAggregationRefresh();
    query.mockResolvedValue({ rows: [] });

    scheduleAggregationRefresh();
    scheduleAggregationRefresh();
    scheduleAggregationRefresh();

    expect(scheduleLegacyRefresh).toHaveBeenCalledTimes(3); // legacy delegates each time

    await vi.advanceTimersByTimeAsync(999);
    expect(query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('cancelPendingAggregationRefresh cancels the debounced timer', async () => {
    vi.useFakeTimers();
    const { scheduleAggregationRefresh, cancelPendingAggregationRefresh, query } = await loadAggregationRefresh();
    query.mockResolvedValue({ rows: [] });

    scheduleAggregationRefresh();
    cancelPendingAggregationRefresh();

    await vi.advanceTimersByTimeAsync(2000);
    expect(query).not.toHaveBeenCalled();
  });

  it('cancelPendingAggregationRefresh is a no-op when nothing is scheduled', async () => {
    const { cancelPendingAggregationRefresh } = await loadAggregationRefresh();
    expect(() => cancelPendingAggregationRefresh()).not.toThrow();
  });

  it('logs duration after a successful Phase-1 refresh', async () => {
    const { refreshAggregations, query, logger } = await loadAggregationRefresh();
    query.mockResolvedValue({ rows: [] });

    await refreshAggregations();

    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^Phase-1 aggregations refreshed in \d+ms$/));
  });

  it('default export exposes the public API', async () => {
    const mod = await loadAggregationRefresh();
    expect(mod.default).toMatchObject({
      refreshAggregations: expect.any(Function),
      scheduleAggregationRefresh: expect.any(Function),
      cancelPendingAggregationRefresh: expect.any(Function),
      TRIGGER_MAINTAINED_TABLES: expect.any(Array),
    });
  });
});
