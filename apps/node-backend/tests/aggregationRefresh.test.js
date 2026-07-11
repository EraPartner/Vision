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
  const clearMcCache = vi.fn().mockResolvedValue(undefined);
  const clearRollingMcCache = vi.fn().mockResolvedValue(undefined);

  vi.doMock('../src/database/connection.js', () => ({ query }));
  vi.doMock('../src/config/logger.js', () => ({ logger }));
  vi.doMock('../src/services/materializedViewService.js', () => ({
    refreshMaterializedViews: refreshLegacyMaterializedViews,
    scheduleRefresh: scheduleLegacyRefresh,
  }));
  vi.doMock('../src/repositories/cashflowForecastMcRepository.js', () => ({
    default: { clearAll: clearMcCache },
  }));
  vi.doMock('../src/repositories/cashflowForecastMcRollingRepository.js', () => ({
    default: { clearAll: clearRollingMcCache },
  }));

  const service = await import('../src/services/aggregationRefresh.js');
  return {
    ...service, query, logger, refreshLegacyMaterializedViews, scheduleLegacyRefresh,
    clearMcCache, clearRollingMcCache,
  };
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

  it('refreshes the legacy materialized views', async () => {
    const { refreshAggregations, refreshLegacyMaterializedViews } = await loadAggregationRefresh();

    await refreshAggregations();

    expect(refreshLegacyMaterializedViews).toHaveBeenCalledTimes(1);
  });

  it('no longer refreshes mv_recipient_monthly (write-amplification removed)', async () => {
    const { refreshAggregations, query } = await loadAggregationRefresh();
    query.mockResolvedValue({ rows: [] });

    await refreshAggregations();

    // The view is no longer in the refresh set — no REFRESH should be issued.
    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls.some((sql) => typeof sql === 'string' && sql.includes('mv_recipient_monthly'))).toBe(false);
  });

  it('invalidates the cashflow-forecast caches so diagnostics recompute on fresh data', async () => {
    const { refreshAggregations, clearMcCache, clearRollingMcCache } = await loadAggregationRefresh();

    await refreshAggregations();

    expect(clearMcCache).toHaveBeenCalledTimes(1);
    expect(clearRollingMcCache).toHaveBeenCalledTimes(1);
  });

  it('scheduleAggregationRefresh delegates to the legacy debounce', async () => {
    vi.useFakeTimers();
    const { scheduleAggregationRefresh, scheduleLegacyRefresh, query } = await loadAggregationRefresh();

    scheduleAggregationRefresh();
    scheduleAggregationRefresh();
    scheduleAggregationRefresh();

    expect(scheduleLegacyRefresh).toHaveBeenCalledTimes(3);
    expect(query).not.toHaveBeenCalled(); // no app-side MV refresh anymore
  });

  // TODO E15: single-transaction mutations previously had NO path to the MC
  // cache clear — an edit left the cashflow forecast stale for up to 6 hours.
  it('scheduleAggregationRefresh clears the forecast MC caches once per burst', async () => {
    vi.useFakeTimers();
    const { scheduleAggregationRefresh, clearMcCache, clearRollingMcCache } = await loadAggregationRefresh();

    scheduleAggregationRefresh();
    scheduleAggregationRefresh();
    scheduleAggregationRefresh();
    expect(clearMcCache).not.toHaveBeenCalled(); // still inside the debounce window

    await vi.advanceTimersByTimeAsync(1000);

    expect(clearMcCache).toHaveBeenCalledTimes(1);
    expect(clearRollingMcCache).toHaveBeenCalledTimes(1);
  });

  it('cancelPendingAggregationRefresh drops a pending MC-cache clear', async () => {
    vi.useFakeTimers();
    const { scheduleAggregationRefresh, cancelPendingAggregationRefresh, clearMcCache } = await loadAggregationRefresh();

    expect(() => cancelPendingAggregationRefresh()).not.toThrow(); // idle: no-op

    scheduleAggregationRefresh();
    cancelPendingAggregationRefresh();
    await vi.advanceTimersByTimeAsync(2000);

    expect(clearMcCache).not.toHaveBeenCalled();
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
