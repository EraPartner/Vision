import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import {
  mvAvailable,
  clearMvCache,
  sanitizeIsolatedDailyInvestmentSpikes,
} from '../src/repositories/infoRepositoryHelpers.js';
import { sanitizeIsolatedValueSpikes } from '../src/utils/portfolioMath.js';

describe('sanitizeIsolatedValueSpikes', () => {
  it('smooths an isolated one-day needle to the geometric mean of its neighbors', () => {
    const rows = [{ value: 1000 }, { value: 2000 }, { value: 1010 }];
    const out = sanitizeIsolatedValueSpikes(rows, 'value');
    expect(out[1].value).toBeCloseTo(Math.sqrt(1000 * 1010), 0); // ~1005, not 2000
    expect(out[0].value).toBe(1000);
    expect(out[2].value).toBe(1010);
  });

  it('leaves a genuine sustained move untouched', () => {
    const rows = [{ value: 1000 }, { value: 2000 }, { value: 2010 }];
    const out = sanitizeIsolatedValueSpikes(rows, 'value');
    expect(out[1].value).toBe(2000); // next does not revert → not a needle
  });
});

describe('sanitizeIsolatedDailyInvestmentSpikes', () => {
  it('recomputes the corrected day netWorth including liabilities (liquid + liabilities + investments)', () => {
    // Liabilities are stored as negative balances (ADR-092), exactly as the
    // net-worth builder emits them: netWorth = liquid + liabilities + investments.
    const snapshots = [
      { date: '2025-01-01', liquid: 500, liabilities: -200, investments: 1000, netWorth: 1300 },
      { date: '2025-01-02', liquid: 500, liabilities: -200, investments: 2000, netWorth: 2300 }, // isolated needle
      { date: '2025-01-03', liquid: 500, liabilities: -200, investments: 1010, netWorth: 1310 },
    ];

    const out = sanitizeIsolatedDailyInvestmentSpikes(snapshots);

    // Corrected investments: geometric mean sqrt(1000 * 1010) ≈ 1004.99.
    expect(out[1].investments).toBe(1004.99);
    // Regression pin: netWorth must include the -200 liabilities term.
    // The pre-fix recomputation (liquid + investments only) produced 1504.99.
    expect(out[1].netWorth).toBe(1304.99);

    // Control: non-spike neighbor days are untouched, liabilities included.
    expect(out[0]).toEqual({ date: '2025-01-01', liquid: 500, liabilities: -200, investments: 1000, netWorth: 1300 });
    expect(out[2]).toEqual({ date: '2025-01-03', liquid: 500, liabilities: -200, investments: 1010, netWorth: 1310 });

    // Input is not mutated.
    expect(snapshots[1].investments).toBe(2000);
    expect(snapshots[1].netWorth).toBe(2300);
  });

  it('leaves a sustained investments move untouched', () => {
    const snapshots = [
      { date: '2025-01-01', liquid: 500, liabilities: -200, investments: 1000, netWorth: 1300 },
      { date: '2025-01-02', liquid: 500, liabilities: -200, investments: 2000, netWorth: 2300 },
      { date: '2025-01-03', liquid: 500, liabilities: -200, investments: 2010, netWorth: 2310 },
    ];
    const out = sanitizeIsolatedDailyInvestmentSpikes(snapshots);
    expect(out).toEqual(snapshots); // next does not revert → not a needle
  });
});

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
