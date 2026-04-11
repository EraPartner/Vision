import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/services/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(async (rows) => rows),
}));

import { query } from '../src/database/connection.js';
import {
  computeAndStoreSnapshots,
  getSnapshots,
  getLatestSnapshot,
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
