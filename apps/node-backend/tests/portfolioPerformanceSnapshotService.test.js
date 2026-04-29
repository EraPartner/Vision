import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/database/connection.js', () => {
  const queryFn = vi.fn();
  return {
    query: queryFn,
    withTransaction: vi.fn(async (fn) => fn({ query: queryFn })),
  };
});

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/services/currency/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(async (rows) => rows),
}));

import { query } from '../src/database/connection.js';
import {
  computeAndStoreSnapshots,
  getSnapshots,
  getLatestSnapshot,
  computeMetrics,
  computeHeatmap,
} from '../src/services/portfolioPerformanceSnapshotService.js';

function buildQueryResponses({ includeData = true, emptyLatest = false } = {}) {
  if (!includeData) {
    return [
      { rows: [{ first_data_date: null }] },
    ];
  }

  return [
    { rows: [{ first_data_date: '2026-01-01' }] },
    {
      rows: [
        { id: 1, currency: 'EUR', current_price: 10, asset_class: 'stock' },
      ],
    },
    {
      rows: [
        {
          investment_id: 1,
          day: '2026-01-01',
          type: 'buy',
          amount: 10,
          units: 1,
          currency: 'EUR',
          fx_rate_to_eur: null,
        },
      ],
    },
    {
      rows: [
        { investment_id: 1, day: '2026-01-01', close_price: 10 },
      ],
    },
    {
      rows: [
        { month: '2026-01', monthly_rate: 0 },
      ],
    },
    {
      rows: [
        { currency_code: 'EUR', rate_to_eur: 1 },
      ],
    },
    { rows: [] },
    { rows: [] },
    {
      rows: emptyLatest
        ? []
        : [{ snapshot_date: '2026-01-01', value: 10, invested: 10, currency: 'EUR' }],
    },
  ];
}

function mockSnapshotQueries({
  firstDate = '2026-01-01',
  investments = [{ id: 1, currency: 'EUR', current_price: 10, asset_class: 'stock' }],
  transactions = [],
  prices = [],
  inflation = [{ month: '2026-01', monthly_rate: 0 }],
  fxRates = [{ currency_code: 'EUR', rate_to_eur: 1 }],
} = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('SELECT MIN(first_date)::date AS first_data_date')) {
      return { rows: [{ first_data_date: firstDate }] };
    }
    if (sql.includes('FROM investments i') && sql.includes('asset_class IN')) {
      return { rows: investments };
    }
    if (sql.includes('FROM portfolio_transactions pt') && sql.includes('ORDER BY pt.date::date, pt.id')) {
      return { rows: transactions };
    }
    if (sql.includes('FROM asset_price_history')) {
      return { rows: prices };
    }
    if (sql.includes('FROM belgian_inflation_rates')) {
      return { rows: inflation };
    }
    if (sql.includes('FROM exchange_rates')) {
      if (fxRates instanceof Error) throw fxRates;
      return { rows: fxRates };
    }
    if (sql.includes('DELETE FROM portfolio_performance_snapshots')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO portfolio_performance_snapshots')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT * FROM portfolio_performance_snapshots')) {
      return { rows: [] };
    }
    if (sql.includes('FROM portfolio_performance_snapshots') && sql.includes('snapshot_date >=')) {
      return { rows: [{ snapshot_date: '2026-01-01', value: 10, invested: 9, currency: 'EUR' }] };
    }
    return { rows: [] };
  });
}

describe('portfolioPerformanceSnapshotService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-03T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty snapshot list when no first data date exists', async () => {
    query.mockResolvedValueOnce({ rows: [{ first_data_date: null }] });

    const result = await computeAndStoreSnapshots('EUR');

    expect(result).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('computes snapshots, deletes existing currency rows, and stores batches', async () => {
    const responses = buildQueryResponses();
    query.mockImplementation(async () => responses.shift() || { rows: [] });

    const result = await computeAndStoreSnapshots('EUR');

    expect(result.length).toBe(3);

    const deleteCall = query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM portfolio_performance_snapshots')
    );
    expect(deleteCall).toBeTruthy();
    expect(deleteCall[1]).toEqual(['EUR']);

    const insertCall = query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO portfolio_performance_snapshots')
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall[1].length).toBeGreaterThanOrEqual(14);

    const firstSnapshot = result[0];
    expect(firstSnapshot).toHaveProperty('snapshot_date');
    expect(firstSnapshot).toHaveProperty('gain_loss');
    expect(firstSnapshot).toHaveProperty('return_pct');
  });

  it('getLatestSnapshot returns null when table has no rows', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const latest = await getLatestSnapshot('EUR');

    expect(latest).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['EUR']);
  });

  it('stores snapshots with sell transactions and fx-rate based conversion', async () => {
    mockSnapshotQueries({
      transactions: [
        {
          investment_id: 1,
          day: '2026-01-01',
          type: 'buy',
          amount: 20,
          units: 2,
          currency: 'USD',
          fx_rate_to_eur: 0.5,
        },
        {
          investment_id: 1,
          day: '2026-01-02',
          type: 'sell',
          amount: 5,
          units: 1,
          currency: 'USD',
          fx_rate_to_eur: 0.5,
        },
      ],
      prices: [
        { investment_id: 1, day: '2026-01-01', close_price: 10 },
        { investment_id: 1, day: '2026-01-02', close_price: 10 },
        { investment_id: 1, day: '2026-01-03', close_price: 10 },
      ],
      fxRates: [
        { currency_code: 'EUR', rate_to_eur: 1 },
        { currency_code: 'USD', rate_to_eur: 0.8 },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].invested).toBe(10);
    expect(snapshots[1].invested).toBe(7.5);
    expect(snapshots[1].value).toBe(10);
    expect(snapshots[1].gain_loss).toBe(2.5);
    expect(snapshots[1].return_pct).toBeCloseTo(33.333, 2);
  });

  it('falls back from historical price to last known transaction price and current price', async () => {
    mockSnapshotQueries({
      investments: [
        { id: 1, currency: 'EUR', current_price: 14, asset_class: 'stock' },
        { id: 2, currency: 'EUR', current_price: 9, asset_class: 'crypto' },
      ],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 30, units: 3, currency: 'EUR', fx_rate_to_eur: null },
        { investment_id: 2, day: '2026-01-01', type: 'buy', amount: 18, units: 2, currency: 'EUR', fx_rate_to_eur: null },
      ],
      prices: [
        { investment_id: 1, day: '2026-01-01', close_price: 12 },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    // day 2/3: investment 1 uses previous historical price 12, investment 2 uses last tx price 9
    expect(snapshots[2].value).toBe(54);
    expect(snapshots[2].stocks_etfs_value).toBe(36);
    expect(snapshots[2].crypto_value).toBe(18);
  });

  it('handles missing fx-rates query and still computes in target currency', async () => {
    mockSnapshotQueries({
      investments: [{ id: 1, currency: 'USD', current_price: 10, asset_class: 'stock' }],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 10, units: 1, currency: 'USD', fx_rate_to_eur: null },
      ],
      prices: [{ investment_id: 1, day: '2026-01-01', close_price: 10 }],
      fxRates: new Error('fx unavailable'),
    });

    const snapshots = await computeAndStoreSnapshots('EUR');
    expect(snapshots[0].value).toBe(10);
    expect(snapshots[0].invested).toBe(10);
  });

  it('sanitizes isolated one-day spikes in computed values', async () => {
    mockSnapshotQueries({
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 100, units: 1, currency: 'EUR', fx_rate_to_eur: null },
      ],
      prices: [
        { investment_id: 1, day: '2026-01-01', close_price: 100 },
        { investment_id: 1, day: '2026-01-02', close_price: 1200 },
        { investment_id: 1, day: '2026-01-03', close_price: 101 },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');
    expect(snapshots[1].value).toBeGreaterThan(100);
    expect(snapshots[1].value).toBeLessThan(101);
  });

  it('returns latest snapshot row when present', async () => {
    query.mockResolvedValueOnce({ rows: [{ snapshot_date: '2026-01-03', value: 12, invested: 10, currency: 'EUR' }] });

    const latest = await getLatestSnapshot('EUR');

    expect(latest).toMatchObject({ snapshot_date: '2026-01-03', value: 12 });
  });

  it('returns range snapshots from getSnapshots', async () => {
    query.mockResolvedValueOnce({ rows: [{ snapshot_date: '2026-01-01', value: 10, invested: 9, currency: 'EUR' }] });

    const rows = await getSnapshots('2026-01-01', '2026-01-31', 'EUR');

    expect(rows).toHaveLength(1);
    expect(query.mock.calls[0][1]).toEqual(['EUR', '2026-01-01', '2026-01-31']);
  });
});

describe('computeMetrics', () => {
  it('returns null for empty or missing snapshots', () => {
    expect(computeMetrics(null)).toBeNull();
    expect(computeMetrics([])).toBeNull();
  });

  it('computes basic metrics from two snapshots', () => {
    const snapshots = [
      { snapshot_date: '2025-01-01', invested: 1000, value: 1000, gain_loss: 0, inflation_adjusted_value: 1000 },
      { snapshot_date: '2026-01-01', invested: 1000, value: 1100, gain_loss: 100, inflation_adjusted_value: 1080 },
    ];

    const metrics = computeMetrics(snapshots);

    expect(metrics.currentValue).toBe(1100);
    expect(metrics.totalInvested).toBe(1000);
    expect(metrics.totalGainLoss).toBe(100);
    expect(metrics.totalReturnPct).toBe(10);
  });

  it('computes annualized return correctly over ~1 year', () => {
    const snapshots = [
      { snapshot_date: '2025-01-01', invested: 1000, value: 1000, gain_loss: 0, inflation_adjusted_value: 1000 },
      { snapshot_date: '2026-01-01', invested: 1000, value: 1100, gain_loss: 100, inflation_adjusted_value: 1080 },
    ];

    const metrics = computeMetrics(snapshots);

    // ~10% over ~1 year => annualized ≈ 10%
    expect(metrics.annualizedReturn).toBeCloseTo(10, 0);
  });

  it('computes real return adjusted for inflation', () => {
    const snapshots = [
      { snapshot_date: '2025-01-01', invested: 1000, value: 1000, gain_loss: 0, inflation_adjusted_value: 1000 },
      { snapshot_date: '2026-01-01', invested: 1000, value: 1100, gain_loss: 100, inflation_adjusted_value: 1080 },
    ];

    const metrics = computeMetrics(snapshots);

    // realReturn = (1080 - 1000) / 1000 * 100 = 8%
    expect(metrics.realReturnPct).toBe(8);
    // cumulativeInflation = (1100/1080 - 1) * 100 ≈ 1.85%
    expect(metrics.cumulativeInflation).toBeCloseTo(1.9, 0);
  });

  it('handles zero invested gracefully', () => {
    const snapshots = [
      { snapshot_date: '2025-01-01', invested: 0, value: 0, gain_loss: 0, inflation_adjusted_value: 0 },
      { snapshot_date: '2026-01-01', invested: 0, value: 0, gain_loss: 0, inflation_adjusted_value: 0 },
    ];

    const metrics = computeMetrics(snapshots);

    expect(metrics.totalReturnPct).toBe(0);
    expect(metrics.annualizedReturn).toBe(0);
    expect(metrics.realReturnPct).toBe(0);
  });

  it('handles single snapshot', () => {
    const snapshots = [
      { snapshot_date: '2025-06-15', invested: 500, value: 520, gain_loss: 20, inflation_adjusted_value: 510 },
    ];

    const metrics = computeMetrics(snapshots);

    expect(metrics.currentValue).toBe(520);
    expect(metrics.totalInvested).toBe(500);
    expect(metrics.totalGainLoss).toBe(20);
    expect(metrics.totalReturnPct).toBe(4);
  });
});

describe('computeHeatmap', () => {
  it('returns empty structure for insufficient data', () => {
    expect(computeHeatmap(null)).toEqual({ years: [], data: {}, maxAbsPct: 0 });
    expect(computeHeatmap([])).toEqual({ years: [], data: {}, maxAbsPct: 0 });
    expect(computeHeatmap([{ snapshot_date: '2025-01-15', value: 100, invested: 100 }]))
      .toEqual({ years: [], data: {}, maxAbsPct: 0 });
  });

  it('computes monthly return for a market gain with no cash flow', () => {
    // Value goes up 10%, invested stays same => +10% return
    const snapshots = [
      { snapshot_date: '2025-01-31', value: 1000, invested: 1000 },
      { snapshot_date: '2025-02-28', value: 1100, invested: 1000 },
    ];

    const result = computeHeatmap(snapshots);

    expect(result.years).toEqual([2025]);
    // February (index 1) should show +10%
    expect(result.data[2025][1]).toBe(10);
    // January (index 0) should be null (first month, no prior)
    expect(result.data[2025][0]).toBeNull();
  });

  it('returns 0% when flat market with deposit (contribution-adjusted)', () => {
    // User deposits 1000 extra, but market is flat
    // Jan: value=1000, invested=1000, ratio=1.0
    // Feb: value=2000, invested=2000, ratio=1.0
    // return = (1.0 / 1.0 - 1) * 100 = 0%
    const snapshots = [
      { snapshot_date: '2025-01-31', value: 1000, invested: 1000 },
      { snapshot_date: '2025-02-28', value: 2000, invested: 2000 },
    ];

    const result = computeHeatmap(snapshots);

    expect(result.data[2025][1]).toBe(0);
  });

  it('detects market loss even with withdrawal', () => {
    // Market drops 10%, user also withdraws
    // Jan: value=1000, invested=1000, ratio=1.0
    // Feb: value=450, invested=500, ratio=0.9
    // return = (0.9 / 1.0 - 1) * 100 = -10%
    const snapshots = [
      { snapshot_date: '2025-01-31', value: 1000, invested: 1000 },
      { snapshot_date: '2025-02-28', value: 450, invested: 500 },
    ];

    const result = computeHeatmap(snapshots);

    expect(result.data[2025][1]).toBe(-10);
  });

  it('returns null when invested is zero (edge case)', () => {
    const snapshots = [
      { snapshot_date: '2025-01-31', value: 1000, invested: 0 },
      { snapshot_date: '2025-02-28', value: 500, invested: 0 },
    ];

    const result = computeHeatmap(snapshots);

    expect(result.data[2025][1]).toBeNull();
  });

  it('computes YTD via geometric compounding of monthly returns', () => {
    // 3 months: +10%, -5%, +8%
    // ratio: Jan=1.0, Feb=1.1, Mar=1.045, Apr=1.1286
    const snapshots = [
      { snapshot_date: '2025-01-31', value: 1000, invested: 1000 },
      { snapshot_date: '2025-02-28', value: 1100, invested: 1000 },
      { snapshot_date: '2025-03-31', value: 1045, invested: 1000 },
      { snapshot_date: '2025-04-30', value: 1128.6, invested: 1000 },
    ];

    const result = computeHeatmap(snapshots);

    expect(result.data[2025][1]).toBe(10);      // Feb
    expect(result.data[2025][2]).toBe(-5);       // Mar
    expect(result.data[2025][3]).toBe(8);        // Apr
    // YTD = (1.1 * 0.95 * 1.08 - 1) * 100 ≈ 12.86%
    // (verified in PerformanceBreakdown's ytd calculation)
  });

  it('spans multiple years correctly', () => {
    const snapshots = [
      { snapshot_date: '2024-11-30', value: 1000, invested: 1000 },
      { snapshot_date: '2024-12-31', value: 1050, invested: 1000 },
      { snapshot_date: '2025-01-31', value: 1100, invested: 1000 },
    ];

    const result = computeHeatmap(snapshots);

    expect(result.years).toEqual([2024, 2025]);
    // Dec 2024 (index 11) = +5%
    expect(result.data[2024][11]).toBe(5);
    // Jan 2025 (index 0) ≈ (1100/1000)/(1050/1000) - 1 ≈ 4.76%
    expect(result.data[2025][0]).toBeCloseTo(4.76, 1);
  });

  it('tracks maxAbsPct across all months', () => {
    const snapshots = [
      { snapshot_date: '2025-01-31', value: 1000, invested: 1000 },
      { snapshot_date: '2025-02-28', value: 800, invested: 1000 },   // -20%
      { snapshot_date: '2025-03-31', value: 1050, invested: 1000 },  // +31.25%
    ];

    const result = computeHeatmap(snapshots);

    expect(result.maxAbsPct).toBeCloseTo(31.25, 1);
  });
});
