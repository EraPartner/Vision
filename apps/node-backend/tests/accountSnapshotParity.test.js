import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';
import { mockTxConnection } from './helpers/repoMocks.js';
vi.mock('../src/database/connection.js', () => mockTxConnection());

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { query } from '../src/database/connection.js';
import { computeDailySnapshots } from '../src/services/portfolio/snapshotBuilder.js';

// computeDailySnapshots fires getFirstDataDate, then a Promise.all of 7 queries
// (unit investments, txns, non-unit, price history, inflation, fx, fx history).
function mockBuilderQueries({ txns, prices }) {
  query.mockReset();
  query
    .mockResolvedValueOnce({ rows: [{ first_data_date: '2026-01-01' }] })       // getFirstDataDate
    .mockResolvedValueOnce({ rows: [{ id: 1, currency: 'EUR', current_price: 10, asset_class: 'stock' }] }) // unit investments
    .mockResolvedValueOnce({ rows: txns })                                       // all txns
    .mockResolvedValueOnce({ rows: [] })                                         // non-unit investments
    .mockResolvedValueOnce({ rows: prices })                                     // price history
    .mockResolvedValueOnce({ rows: [] })                                         // inflation
    .mockResolvedValueOnce({ rows: [] })                                         // fx latest
    .mockResolvedValueOnce({ rows: [] });                                        // fx history
}

beforeEach(() => vi.clearAllMocks());

describe('snapshotBuilder per-account split (ADR-100 parity)', () => {
  it('Σ value_by_account == value on every day, split by unit share', async () => {
    mockBuilderQueries({
      txns: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 60, units: 6, currency: 'EUR', fx_rate_to_eur: null, account_id: 10 },
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 40, units: 4, currency: 'EUR', fx_rate_to_eur: null, account_id: 20 },
      ],
      prices: [{ investment_id: 1, day: '2026-01-01', close_price: 10 }],
    });

    const snaps = await computeDailySnapshots('EUR');
    expect(snaps.length).toBeGreaterThan(0);

    for (const s of snaps) {
      const sum = Object.values(s.value_by_account).reduce((a, b) => a + b, 0);
      // Parity: the per-account split re-sums to the aggregate value (ADR-100).
      expect(sum).toBeCloseTo(s.value, 2);
    }

    // 10 units @ €10 = €100; account 10 holds 60%, account 20 holds 40%.
    const first = snaps[0];
    expect(first.value).toBeCloseTo(100, 2);
    expect(first.value_by_account['10']).toBeCloseTo(60, 2);
    expect(first.value_by_account['20']).toBeCloseTo(40, 2);
  });

  it('a partial sell shifts the split toward the remaining account', async () => {
    mockBuilderQueries({
      txns: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 60, units: 6, currency: 'EUR', fx_rate_to_eur: null, account_id: 10 },
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 40, units: 4, currency: 'EUR', fx_rate_to_eur: null, account_id: 20 },
        { investment_id: 1, day: '2026-01-02', type: 'sell', amount: 40, units: 4, currency: 'EUR', fx_rate_to_eur: null, account_id: 10 },
      ],
      prices: [{ investment_id: 1, day: '2026-01-01', close_price: 10 }],
    });

    const snaps = await computeDailySnapshots('EUR');
    // After 2026-01-02: account 10 has 2 units, account 20 has 4 → total 6 → €60.
    const after = snaps.find((s) => s.snapshot_date === '2026-01-02');
    expect(after.value).toBeCloseTo(60, 2);
    expect(after.value_by_account['10']).toBeCloseTo(20, 2);
    expect(after.value_by_account['20']).toBeCloseTo(40, 2);
    for (const s of snaps) {
      const sum = Object.values(s.value_by_account).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(s.value, 2);
    }
  });

  it('legacy lots with no account collapse into an "unassigned" bucket', async () => {
    mockBuilderQueries({
      txns: [
        { investment_id: 1, day: '2026-01-01', type: 'buy', amount: 100, units: 10, currency: 'EUR', fx_rate_to_eur: null, account_id: null },
      ],
      prices: [{ investment_id: 1, day: '2026-01-01', close_price: 10 }],
    });
    const snaps = await computeDailySnapshots('EUR');
    expect(snaps[0].value_by_account.unassigned).toBeCloseTo(100, 2);
  });
});
