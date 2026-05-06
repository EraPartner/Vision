import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadMaterializedViewService() {
  vi.resetModules();

  const query = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  vi.doMock('../src/database/connection.js', () => ({ query }));
  vi.doMock('../src/config/logger.js', () => ({ logger }));

  const service = await import('../src/services/materializedViewService.js');
  return { ...service, query, logger };
}

describe('materializedViewService', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('falls back to non-concurrent refresh when concurrent refresh fails', async () => {
    const { refreshMaterializedViews, query, logger } = await loadMaterializedViewService();

    query.mockImplementation((sql) => {
      if (sql.includes('REFRESH MATERIALIZED VIEW CONCURRENTLY')) {
        return Promise.reject(new Error('cannot refresh materialized view concurrently'));
      }
      return Promise.resolve({ rows: [] });
    });

    await refreshMaterializedViews();

    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls).toContain('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_summary');
    expect(sqlCalls).toContain('REFRESH MATERIALIZED VIEW mv_monthly_summary');
    expect(logger.warn).toHaveBeenCalledWith('Falling back to non-concurrent refresh for mv_monthly_summary');
  });

  it('queues one deferred refresh while a refresh is in flight', async () => {
    vi.useFakeTimers();

    const { refreshMaterializedViews, query } = await loadMaterializedViewService();
    const pendingResolvers = [];
    let callCount = 0;

    query.mockImplementation(() => {
      callCount += 1;
      if (callCount <= 4) {
        return new Promise((resolve) => {
          pendingResolvers.push(resolve);
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const firstRefresh = refreshMaterializedViews();
    await refreshMaterializedViews();

    expect(query).toHaveBeenCalledTimes(4);

    pendingResolvers.forEach((resolve) => resolve({ rows: [] }));
    await firstRefresh;

    await vi.advanceTimersByTimeAsync(500);

    expect(query).toHaveBeenCalledTimes(8);
  });

  it('debounces scheduleRefresh calls into one refresh', async () => {
    vi.useFakeTimers();

    const { scheduleRefresh, query } = await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    scheduleRefresh();
    scheduleRefresh();

    await vi.advanceTimersByTimeAsync(999);
    expect(query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('creates materialized views and indexes in expected order', async () => {
    const { createMaterializedViews, query, logger } = await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await createMaterializedViews();

    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls.some((sql) => sql.includes('CREATE MATERIALIZED VIEW IF NOT EXISTS mv_monthly_summary AS'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS mv_monthly_summary_idx'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('CREATE MATERIALIZED VIEW IF NOT EXISTS mv_category_totals'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cashflow_daily'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('CREATE MATERIALIZED VIEW IF NOT EXISTS mv_bank_balances'))).toBe(true);
    expect(logger.info).toHaveBeenCalledWith('Materialized views ready');
  });

  it('ensures indexes and warns when one creation fails', async () => {
    const { ensureMaterializedViewIndexes, query, logger } = await loadMaterializedViewService();
    query.mockImplementation((sql) => {
      if (sql.includes('mv_cashflow_daily_idx')) {
        return Promise.reject(new Error('index create denied'));
      }
      return Promise.resolve({ rows: [] });
    });

    await ensureMaterializedViewIndexes();

    expect(query).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not create index mv_cashflow_daily_idx on mv_cashflow_daily',
      { error: 'index create denied' }
    );
  });
});
