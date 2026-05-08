import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import { mvAvailable, clearMvCache } from '../src/repositories/infoRepositoryHelpers.js';

describe('mvAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMvCache();
  });

  it('returns true and caches when the view exists with rows', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    expect(await mvAvailable('mv_category_totals')).toBe(true);
    expect(await mvAvailable('mv_category_totals')).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('caches negative results so a missing view does not produce N round-trips', async () => {
    query.mockRejectedValue(new Error('relation does not exist'));

    expect(await mvAvailable('mv_monthly_summary')).toBe(false);
    expect(await mvAvailable('mv_monthly_summary')).toBe(false);
    expect(await mvAvailable('mv_monthly_summary')).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('caches an empty-rows result as a negative entry as well', async () => {
    query.mockResolvedValue({ rows: [] });

    expect(await mvAvailable('mv_category_totals')).toBe(false);
    expect(await mvAvailable('mv_category_totals')).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('expires the negative cache after the TTL so a freshly created view is picked up', async () => {
    vi.useFakeTimers();
    try {
      query.mockResolvedValueOnce({ rows: [] });
      expect(await mvAvailable('mv_monthly_summary')).toBe(false);
      expect(query).toHaveBeenCalledTimes(1);

      // Advance past the 60s negative-cache TTL.
      vi.setSystemTime(Date.now() + 61_000);

      query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      expect(await mvAvailable('mv_monthly_summary')).toBe(true);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unknown view names instead of interpolating them into SQL', async () => {
    await expect(mvAvailable("not_a_real_mv'; DROP TABLE x; --")).rejects.toThrow(
      /unknown materialized view/i
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('clearMvCache forces a re-check on the next call', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    expect(await mvAvailable('mv_category_totals')).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);

    clearMvCache();

    expect(await mvAvailable('mv_category_totals')).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
