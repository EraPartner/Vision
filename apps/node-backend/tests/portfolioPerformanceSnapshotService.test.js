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
  nonUnitInvestments = [],
  transactions = [],
  prices = [],
  inflation = [{ month: '2026-01', monthly_rate: 0 }],
  fxRates = [{ currency_code: 'EUR', rate_to_eur: 1 }],
  fxHistory = [],
  fxNeutralColumn = true,
} = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('information_schema.columns')) {
      return { rows: fxNeutralColumn ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('SELECT MIN(first_date)::date AS first_data_date')) {
      return { rows: [{ first_data_date: firstDate }] };
    }
    if (sql.includes('FROM investments i') && sql.includes('asset_class IN')) {
      return { rows: investments };
    }
    if (sql.includes('FROM investments') && sql.includes('asset_class = ANY')) {
      return { rows: nonUnitInvestments };
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
      if (sql.includes('rate_date >=')) {
        return { rows: fxHistory };
      }
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

  it('applies stock splits to historical units so value tracks the live summary', async () => {
    // 10 units bought at 10; 2:1 split on day 2 → 20 units, price halves to 5.
    // Value must stay 100 across the split, not drop to 50 (the pre-fix bug).
    mockSnapshotQueries({
      investments: [{ id: 1, currency: 'EUR', current_price: 5, asset_class: 'stock' }],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 100, units: 10, currency: 'EUR', fx_rate_to_eur: null },
        { investment_id: 1, day: '2026-01-02', type: 'split', amount: 0, units: 20, currency: 'EUR', fx_rate_to_eur: null },
      ],
      prices: [
        { investment_id: 1, day: '2026-01-01', close_price: 10 },
        { investment_id: 1, day: '2026-01-02', close_price: 5 },
        { investment_id: 1, day: '2026-01-03', close_price: 5 },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].value).toBe(100); // 10 × 10
    expect(snapshots[1].value).toBe(100); // 20 × 5 (split applied)
    expect(snapshots[2].value).toBe(100); // 20 × 5
    expect(snapshots[0].invested).toBe(100);
    expect(snapshots[2].invested).toBe(100); // split leaves invested unchanged
  });

  it('reduces invested on return_of_capital without changing units/value', async () => {
    mockSnapshotQueries({
      investments: [{ id: 1, currency: 'EUR', current_price: 10, asset_class: 'stock' }],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 100, units: 10, currency: 'EUR', fx_rate_to_eur: null },
        { investment_id: 1, day: '2026-01-02', type: 'return_of_capital', amount: 30, units: 0, currency: 'EUR', fx_rate_to_eur: null },
      ],
      prices: [
        { investment_id: 1, day: '2026-01-01', close_price: 10 },
        { investment_id: 1, day: '2026-01-02', close_price: 10 },
        { investment_id: 1, day: '2026-01-03', close_price: 10 },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    expect(snapshots[0].invested).toBe(100);
    expect(snapshots[1].invested).toBe(70); // 100 − 30 returned
    expect(snapshots[1].value).toBe(100); // units unchanged → value unchanged
  });

  it('converts a foreign-currency holding with no stored fx rate at each day\'s historical rate', async () => {
    // USD holding, no fx_rate_to_eur on the buy. USD/EUR moves 0.80 → 0.85 → 0.90
    // (latest). System time is 2026-01-03, so 01-03 is the latest day.
    mockSnapshotQueries({
      investments: [{ id: 1, currency: 'USD', current_price: 10, asset_class: 'stock' }],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 100, units: 10, currency: 'USD', fx_rate_to_eur: null },
      ],
      prices: [
        { investment_id: 1, day: '2026-01-01', close_price: 10 },
        { investment_id: 1, day: '2026-01-02', close_price: 10 },
        { investment_id: 1, day: '2026-01-03', close_price: 10 },
      ],
      fxRates: [
        { currency_code: 'EUR', rate_to_eur: 1 },
        { currency_code: 'USD', rate_to_eur: 0.9 }, // is_latest
      ],
      fxHistory: [
        { currency_code: 'USD', day: '2026-01-01', rate_to_eur: 0.8 },
        { currency_code: 'USD', day: '2026-01-02', rate_to_eur: 0.85 },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    expect(snapshots).toHaveLength(3);
    // Value uses the rate that applied on each day — NOT today's 0.90 everywhere.
    expect(snapshots[0].value).toBe(80); // 100 USD × 0.80 (2026-01-01)
    expect(snapshots[1].value).toBe(85); // 100 USD × 0.85 (2026-01-02)
    // Latest day uses the latest (is_latest) rate so it reconciles with /portfolio-summary.
    expect(snapshots[2].value).toBe(90); // 100 USD × 0.90 (latest)
    // Invested reflects the buy-day rate (true cost), not today's — would be 90 if buggy.
    expect(snapshots[0].invested).toBe(80);
    expect(snapshots[2].invested).toBe(80);
  });

  it('computes the FX-neutral series locked at the cost-weighted purchase rate', async () => {
    // Same fixture as the historical-rate test above: the actual value follows
    // the day's rate (80 → 85 → 90) while the FX-neutral value stays at the
    // purchase-date rate (0.80) — their difference is the currency effect.
    mockSnapshotQueries({
      investments: [{ id: 1, currency: 'USD', current_price: 10, asset_class: 'stock' }],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 100, units: 10, currency: 'USD', fx_rate_to_eur: 0.8 },
      ],
      prices: [
        { investment_id: 1, day: '2026-01-01', close_price: 10 },
        { investment_id: 1, day: '2026-01-02', close_price: 10 },
        { investment_id: 1, day: '2026-01-03', close_price: 10 },
      ],
      fxRates: [
        { currency_code: 'EUR', rate_to_eur: 1 },
        { currency_code: 'USD', rate_to_eur: 0.9 },
      ],
      fxHistory: [
        { currency_code: 'USD', day: '2026-01-01', rate_to_eur: 0.8 },
        { currency_code: 'USD', day: '2026-01-02', rate_to_eur: 0.85 },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    expect(snapshots.map((s) => s.value)).toEqual([80, 85, 90]);
    expect(snapshots.map((s) => s.value_fx_neutral)).toEqual([80, 80, 80]);

    // The persisted INSERT carries the column when the migration is applied.
    const insertCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO portfolio_performance_snapshots'));
    expect(String(insertCall[0])).toContain('value_fx_neutral');
  });

  it('keeps the average purchase rate unchanged across sells (FX-neutral)', async () => {
    mockSnapshotQueries({
      investments: [{ id: 1, currency: 'USD', current_price: 10, asset_class: 'stock' }],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 100, units: 10, currency: 'USD', fx_rate_to_eur: 0.8 },
        { investment_id: 1, day: '2026-01-02', type: 'sell', amount: 50, units: 5, currency: 'USD', fx_rate_to_eur: 0.85 },
      ],
      prices: [
        { investment_id: 1, day: '2026-01-01', close_price: 10 },
        { investment_id: 1, day: '2026-01-02', close_price: 10 },
        { investment_id: 1, day: '2026-01-03', close_price: 10 },
      ],
      fxRates: [
        { currency_code: 'EUR', rate_to_eur: 1 },
        { currency_code: 'USD', rate_to_eur: 0.9 },
      ],
      fxHistory: [
        { currency_code: 'USD', day: '2026-01-01', rate_to_eur: 0.8 },
        { currency_code: 'USD', day: '2026-01-02', rate_to_eur: 0.85 },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    // Day 3: 5 units × 10 USD at today's 0.9 = 45 actual; at the remaining
    // position's purchase rate 0.8 = 40 neutral.
    expect(snapshots[2].value).toBe(45);
    expect(snapshots[2].value_fx_neutral).toBe(40);
  });

  it('omits value_fx_neutral from the INSERT when migration 0039 is not applied', async () => {
    mockSnapshotQueries({
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 100, units: 10, currency: 'EUR', fx_rate_to_eur: null },
      ],
      prices: [{ investment_id: 1, day: '2026-01-01', close_price: 10 }],
      fxNeutralColumn: false,
    });

    const snapshots = await computeAndStoreSnapshots('EUR');
    expect(snapshots.length).toBeGreaterThan(0);

    const insertCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO portfolio_performance_snapshots'));
    expect(String(insertCall[0])).not.toContain('value_fx_neutral');
  });

  it('falls back from historical price to last known transaction price and current price', async () => {
    // current_price set to match historical close so the latest-day override
    // (which uses inv.current_price for parity with /portfolio-summary) does
    // not skew the historical-fallback assertion on day 2.
    mockSnapshotQueries({
      investments: [
        { id: 1, currency: 'EUR', current_price: 12, asset_class: 'stock' },
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

    // day 2: investment 1 uses historical price 12 (forward-filled), investment 2 uses last tx price 9.
    expect(snapshots[1].value).toBe(54);
    expect(snapshots[1].stocks_etfs_value).toBe(36);
    expect(snapshots[1].crypto_value).toBe(18);
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
    // current_price set to match day-3 historical close — the latest-day
    // override uses current_price, so it must reflect the same price tier
    // for the spike-detection assertion to be meaningful.
    mockSnapshotQueries({
      investments: [{ id: 1, currency: 'EUR', current_price: 101, asset_class: 'stock' }],
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

  // Reconciliation regression tests — these lock in parity between the
  // snapshot builder and the live /portfolio-summary valuation. Bug:
  // pre-fix the snapshot ignored accrued interest and appreciation, leading
  // to the dashboard/net-worth headline mismatch users reported.
  it('values fixed-income (savings) as runningInvested + accrued interest, matching live summary', async () => {
    // 2 days in window: buy on Jan 1, snapshot taken Jan 3.
    // Live summary formula: principal × (rate/100/365) × daysSinceFirstBuy
    // 1000 × (5/100/365) × 2 = 0.27397...
    mockSnapshotQueries({
      investments: [],
      nonUnitInvestments: [
        { id: 1, currency: 'EUR', current_price: 9999, interest_rate: 5, asset_class: 'savings', active_from: '2026-01-01' },
      ],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 1000, units: 0, currency: 'EUR', fx_rate_to_eur: null },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    const expectedAccrued = 1000 * (5 / 100 / 365) * 2;
    const expectedValue = 1000 + expectedAccrued;
    expect(snapshots[2].value).toBeCloseTo(expectedValue, 2);
    expect(snapshots[2].cash_value).toBeCloseTo(expectedValue, 2);
    // Critically: NOT the inv.current_price (9999) — that would be the pre-fix bug.
    expect(snapshots[2].value).toBeLessThan(9999);
  });

  it('values real-estate as runningInvested + cumulative appreciation, matching live summary', async () => {
    mockSnapshotQueries({
      investments: [],
      nonUnitInvestments: [
        { id: 1, currency: 'EUR', current_price: 9999, interest_rate: 0, asset_class: 'real_estate', active_from: '2026-01-01' },
      ],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 200000, units: 0, currency: 'EUR', fx_rate_to_eur: null },
        { investment_id: 1, day: '2026-01-02', type: 'appreciation', amount: 5000, units: 0, currency: 'EUR', fx_rate_to_eur: null },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    // Day 1: buy only → 200000
    expect(snapshots[0].value).toBeCloseTo(200000, 2);
    // Day 2-3: buy + appreciation → 205000
    expect(snapshots[1].value).toBeCloseTo(205000, 2);
    expect(snapshots[2].value).toBeCloseTo(205000, 2);
    // Critically: NOT inv.current_price.
    expect(snapshots[2].value).not.toBe(9999);
  });

  it('resets fixed-income accrual clock when an interest payment is recorded', async () => {
    // Live summary: lastInterestDate beats firstBuyDate. After interest is paid
    // on day 2, the snapshot on day 3 should accrue from day 2, not day 1.
    mockSnapshotQueries({
      investments: [],
      nonUnitInvestments: [
        { id: 1, currency: 'EUR', current_price: 0, interest_rate: 5, asset_class: 'bond', active_from: '2026-01-01' },
      ],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 1000, units: 0, currency: 'EUR', fx_rate_to_eur: null },
        { investment_id: 1, day: '2026-01-02', type: 'interest', amount: 10, units: 0, currency: 'EUR', fx_rate_to_eur: null },
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    // Day 3 accrues from day 2 (1 day), not from day 1 (2 days).
    const expectedAccrued = 1000 * (5 / 100 / 365) * 1;
    expect(snapshots[2].value).toBeCloseTo(1000 + expectedAccrued, 2);
  });

  it('uses live current_price for the latest day so snapshot reconciles with /portfolio-summary', async () => {
    // asset_price_history lags behind investments.current_price (e.g. user
    // edited the price manually). The latest snapshot must reflect the live
    // value, not the stale historical close.
    mockSnapshotQueries({
      investments: [
        { id: 1, currency: 'EUR', current_price: 25, asset_class: 'stock' },
      ],
      transactions: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 10, units: 1, currency: 'EUR', fx_rate_to_eur: null },
      ],
      prices: [
        { investment_id: 1, day: '2026-01-01', close_price: 10 },
        { investment_id: 1, day: '2026-01-02', close_price: 12 },
        // Day 3 (today): no price history row, current_price = 25.
      ],
    });

    const snapshots = await computeAndStoreSnapshots('EUR');

    expect(snapshots[0].value).toBe(10);  // historical: close_price = 10
    expect(snapshots[1].value).toBe(12);  // historical: close_price = 12
    expect(snapshots[2].value).toBe(25);  // latest day: uses inv.current_price
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
