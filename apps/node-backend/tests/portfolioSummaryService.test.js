import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  convertToCurrency: vi.fn(async (amount, from, to) => {
    if (!from || from === to) return amount;
    if (from === 'USD' && to === 'EUR') return amount * 0.9;
    if (from === 'EUR' && to === 'USD') return amount / 0.9;
    return amount;
  }),
}));

vi.mock('../src/repositories/settingsRepository.js', () => ({
  settingsRepository: { get: vi.fn(async () => null) },
}));

import { query } from '../src/database/connection.js';
import { settingsRepository } from '../src/repositories/settingsRepository.js';
import {
  getPortfolioSummary,
  getBreakdownSummary,
} from '../src/services/portfolio/portfolioSummaryService.js';

const investmentRow = (overrides = {}) => ({
  id: 1,
  name: 'Apple Inc',
  symbol: 'AAPL',
  asset_class: 'stock',
  currency: 'USD',
  current_price: 200,
  interest_rate: 0,
  is_active: true,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  description: null,
  notes: null,
  location: null,
  municipality: null,
  cadastral_income: null,
  municipality_tax_rate: null,
  maturity_date: null,
  price_provider: null,
  price_provider_id: null,
  price_provider_url: null,
  price_provider_latest_url: null,
  price_provider_latest_path: null,
  price_provider_history_url: null,
  price_provider_history_path: null,
  price_provider_history_ts_path: null,
  price_provider_history_price_path: null,
  price_updated_at: null,
  ...overrides,
});

const txnRow = (overrides = {}) => ({
  id: 1,
  investment_id: 1,
  type: 'buy',
  amount: 100,
  units: 1,
  fees: 0,
  taxes: 0,
  date: '2026-01-01',
  currency: 'USD',
  ...overrides,
});

describe('getPortfolioSummary', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('returns empty totals when no investments exist', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPortfolioSummary('EUR');

    expect(result.summaries).toEqual([]);
    expect(result.totals).toEqual({
      totalPortfolioValue: 0,
      totalInvested: 0,
      totalGainLoss: 0,
      totalRealizedGain: 0,
      totalUnrealizedGain: 0,
      totalGain: 0,
      totalIncome: 0,
      totalFees: 0,
      totalTaxes: 0,
      totalAssetGain: 0,
      totalFxGain: 0,
      totalReturnPct: 0,
      usedFallbackRate: false,
    });
    expect(result.currency).toBe('EUR');
  });

  it('computes single-currency stock totals correctly', async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: 'EUR', current_price: 200 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ type: 'buy', amount: 100, units: 1, currency: 'EUR' }),
          txnRow({ id: 2, type: 'buy', amount: 110, units: 1, currency: 'EUR' }),
        ],
      });

    const result = await getPortfolioSummary('EUR');

    expect(result.summaries).toHaveLength(1);
    const s = result.summaries[0];
    expect(s.totalUnits).toBe(2);
    expect(s.totalBuyCost).toBe(210);
    expect(s.currentValue).toBe(400); // 2 units * 200
    expect(s.unrealizedGain).toBe(190); // (200 - 105) * 2
    expect(s.realizedGain).toBe(0);

    expect(result.totals.totalPortfolioValue).toBe(400);
    expect(result.totals.totalInvested).toBe(210);
    expect(result.totals.totalUnrealizedGain).toBe(190);
  });

  it('pre-converts USD investments to EUR target currency', async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: 'USD', current_price: 200 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: 'buy', amount: 100, units: 1, currency: 'USD' })],
      })
      // historical rate index: no stored rates → per-txn conversion falls back
      // to today's rate (0.9) and the response is flagged
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPortfolioSummary('EUR');
    const s = result.summaries[0];

    // 1 unit * 200 USD * 0.9 = 180 EUR
    expect(s.currentValue).toBe(180);
    // 100 USD buy cost * 0.9 = 90 EUR
    expect(s.totalBuyCost).toBe(90);
    expect(s.currency).toBe('EUR');
    expect(s.originalCurrency).toBe('USD');
    expect(s.usedFallbackRate).toBe(true);
    expect(result.totals.usedFallbackRate).toBe(true);
  });

  it('locks invested at the transaction-date rate and attributes the FX gain', async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: 'USD', current_price: 200 })],
      })
      .mockResolvedValueOnce({
        // bought at 0.8 EUR/USD (stamped on the transaction)
        rows: [txnRow({ type: 'buy', amount: 100, units: 1, currency: 'USD', fx_rate_to_eur: 0.8 })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPortfolioSummary('EUR');
    const s = result.summaries[0];

    // Invested locked at buy-date rate: 100 USD * 0.8 = 80 EUR (today's 0.9 must not move it)
    expect(s.totalInvested).toBe(80);
    expect(s.totalBuyCost).toBe(80);
    // Value at today's rate: 200 USD * 0.9 = 180 EUR
    expect(s.currentValue).toBe(180);
    // Total gain includes FX: 180 − 80 = 100 EUR …
    expect(s.gainLoss).toBe(100);
    // … decomposed into native performance (100 USD * 0.9 = 90 EUR) + FX on
    // the invested capital (100 USD * (0.9 − 0.8) = 10 EUR)
    expect(s.assetGain).toBe(90);
    expect(s.fxGain).toBe(10);
    expect(s.nativeCurrentValue).toBe(200);
    expect(s.usedFallbackRate).toBe(false);

    expect(result.totals.totalInvested).toBe(80);
    expect(result.totals.totalGainLoss).toBe(100);
    expect(result.totals.totalAssetGain).toBe(90);
    expect(result.totals.totalFxGain).toBe(10);
  });

  it('aggregates totals across mixed currencies in target currency', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({ id: 1, currency: 'EUR', current_price: 100 }),
          investmentRow({ id: 2, currency: 'USD', current_price: 200, name: 'MSFT', symbol: 'MSFT' }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ id: 1, investment_id: 1, type: 'buy', amount: 100, units: 1, currency: 'EUR' }),
          txnRow({ id: 2, investment_id: 2, type: 'buy', amount: 200, units: 1, currency: 'USD' }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPortfolioSummary('EUR');

    // EUR investment: 100 EUR value, 100 EUR cost
    // USD investment: 200 USD * 0.9 = 180 EUR value, 200 USD * 0.9 = 180 EUR cost
    expect(result.totals.totalPortfolioValue).toBe(280);
    expect(result.totals.totalInvested).toBe(280);
  });

  it('totalReturnPct equals totalGainLoss / totalInvested * 100', async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: 'EUR', current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: 'buy', amount: 100, units: 1, currency: 'EUR' })],
      });

    const result = await getPortfolioSummary('EUR');
    const { totalGainLoss, totalInvested, totalReturnPct } = result.totals;

    expect(totalReturnPct).toBeCloseTo((totalGainLoss / totalInvested) * 100, 2);
  });

  it('totals match the sum of summary fields (reconciliation invariant)', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({ id: 1, currency: 'EUR', current_price: 150 }),
          investmentRow({ id: 2, currency: 'EUR', current_price: 50, name: 'B', symbol: 'B' }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ id: 1, investment_id: 1, type: 'buy', amount: 100, units: 1, currency: 'EUR' }),
          txnRow({ id: 2, investment_id: 2, type: 'buy', amount: 30, units: 1, currency: 'EUR' }),
        ],
      });

    const result = await getPortfolioSummary('EUR');
    const sumValue = result.summaries.reduce((s, x) => s + x.currentValue, 0);
    const sumInvested = result.summaries.reduce((s, x) => s + x.totalBuyCost, 0);
    const sumGainLoss = result.summaries.reduce((s, x) => s + x.gainLoss, 0);

    expect(result.totals.totalPortfolioValue).toBeCloseTo(sumValue, 2);
    expect(result.totals.totalInvested).toBeCloseTo(sumInvested, 2);
    expect(result.totals.totalGainLoss).toBeCloseTo(sumGainLoss, 2);
  });
});

describe('getBreakdownSummary (legacy compat)', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('returns a narrow shape sourced from getPortfolioSummary', async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: 'EUR', current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: 'buy', amount: 100, units: 1, currency: 'EUR' })],
      });

    const breakdown = await getBreakdownSummary('EUR');

    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]).toMatchObject({
      id: 1,
      name: 'Apple Inc',
      symbol: 'AAPL',
      assetClass: 'stock',
      currency: 'EUR', // originalCurrency from the test investment
      currentValue: 150,
      totalInvested: 100,
    });
  });

  it('breakdown values match getPortfolioSummary summaries (parity)', async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: 'USD', current_price: 200 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: 'buy', amount: 100, units: 1, currency: 'USD' })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const summary = await getPortfolioSummary('EUR');

    query.mockReset();
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: 'USD', current_price: 200 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: 'buy', amount: 100, units: 1, currency: 'USD' })],
      })
      .mockResolvedValueOnce({ rows: [] });
    const breakdown = await getBreakdownSummary('EUR');

    expect(breakdown[0].currentValue).toBe(summary.summaries[0].currentValue);
    expect(breakdown[0].totalInvested).toBe(summary.summaries[0].totalInvested);
    expect(breakdown[0].gainLoss).toBe(summary.summaries[0].gainLoss);
    expect(breakdown[0].assetGain).toBe(summary.summaries[0].assetGain);
    expect(breakdown[0].fxGain).toBe(summary.summaries[0].fxGain);
  });
});

describe('asset-class formula coverage', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('savings account computes accrued + projected interest', async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({
          asset_class: 'savings',
          interest_rate: 5,
          current_price: 0,
          currency: 'EUR',
        })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: 'buy', amount: 1000, units: 0, currency: 'EUR', date: '2025-01-01' })],
      });

    const result = await getPortfolioSummary('EUR');
    const s = result.summaries[0];

    expect(s.totalInvested).toBe(1000);
    expect(s.projectedAnnualInterest).toBe(50); // 1000 * 5%
    expect(s.accruedInterest).toBeGreaterThan(0);
    expect(s.currentValue).toBeCloseTo(1000 + s.accruedInterest, 2);
  });

  it('does not double-count interest in fixed-income gainLoss', async () => {
    // €10 000 deposit, one €400 interest payment, negligible accrual → economic
    // gain 400. Old code added interest via realizedGain AND totalIncome → 800.
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ asset_class: 'savings', interest_rate: 0, current_price: 0, currency: 'EUR' })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ id: 1, type: 'buy', amount: 10000, units: 0, currency: 'EUR', date: '2025-01-01' }),
          txnRow({ id: 2, type: 'interest', amount: 400, units: 0, currency: 'EUR', date: '2026-01-01' }),
        ],
      });

    const result = await getPortfolioSummary('EUR');
    expect(result.summaries[0].gainLoss).toBe(400);
  });

  it('clamps negative net-invested to 0 instead of flipping it positive (abs)', async () => {
    // Fixed-income sold above contributions → buys−sells negative. abs() used to
    // report +500 "invested"; clamp reports 0.
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ asset_class: 'savings', interest_rate: 0, current_price: 0, currency: 'EUR' })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ id: 1, type: 'buy', amount: 1000, units: 0, currency: 'EUR', date: '2025-01-01' }),
          txnRow({ id: 2, type: 'sell', amount: 1500, units: 0, currency: 'EUR', date: '2026-01-01' }),
        ],
      });

    const result = await getPortfolioSummary('EUR');
    expect(result.summaries[0].totalInvested).toBe(0);
  });

  it('real estate adds appreciation to current value', async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ asset_class: 'real_estate', current_price: 0, currency: 'EUR' })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ id: 1, type: 'buy', amount: 250000, units: 0, currency: 'EUR' }),
          txnRow({ id: 2, type: 'appreciation', amount: 25000, units: 0, currency: 'EUR' }),
        ],
      });

    const result = await getPortfolioSummary('EUR');
    const s = result.summaries[0];

    expect(s.totalInvested).toBe(250000);
    expect(s.totalAppreciation).toBe(25000);
    expect(s.currentValue).toBe(275000);
    expect(s.unrealizedGain).toBe(25000);
  });

  it('does not double-count buy fees in gainLoss for unit-based assets', async () => {
    // Buy 1 unit for 100 with a 10 fee → cost basis 110; current price 150.
    // Economic gain is 40 (paid 110, worth 150). calculateCostBasis already
    // folds the fee into cost, so the old code's extra −fee gave 30.
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: 'EUR', current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: 'buy', amount: 100, units: 1, fees: 10, currency: 'EUR' })],
      });

    const result = await getPortfolioSummary('EUR');
    expect(result.summaries[0].gainLoss).toBe(40);
  });

  it('does not double-count rent/fees/taxes in real-estate gainLoss', async () => {
    // appreciation 10000 + rent 12000 − fees 2000 − taxes 1000 = 19000.
    // Old code computed appreciation + 2·rent − 2·fees − 2·taxes = 28000.
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ asset_class: 'real_estate', current_price: 0, currency: 'EUR' })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ id: 1, type: 'buy', amount: 250000, units: 0, currency: 'EUR' }),
          txnRow({ id: 2, type: 'appreciation', amount: 10000, units: 0, currency: 'EUR' }),
          txnRow({ id: 3, type: 'rent_income', amount: 12000, units: 0, currency: 'EUR' }),
          txnRow({ id: 4, type: 'fee', amount: 2000, units: 0, currency: 'EUR' }),
          txnRow({ id: 5, type: 'tax', amount: 1000, units: 0, currency: 'EUR' }),
        ],
      });

    const result = await getPortfolioSummary('EUR');
    expect(result.summaries[0].gainLoss).toBe(19000);
  });

  it('sells reduce units and trigger realized gain on a unit-based holding', async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: 'EUR', current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ id: 1, type: 'buy', amount: 100, units: 1, currency: 'EUR', date: '2025-01-01' }),
          txnRow({ id: 2, type: 'buy', amount: 120, units: 1, currency: 'EUR', date: '2025-06-01' }),
          txnRow({ id: 3, type: 'sell', amount: 200, units: 1, currency: 'EUR', date: '2026-01-01' }),
        ],
      });

    const result = await getPortfolioSummary('EUR');
    const s = result.summaries[0];

    expect(s.totalUnits).toBe(1);
    expect(s.realizedGain).toBeGreaterThan(0); // sold above avg cost basis
    expect(s.currentValue).toBe(150); // 1 unit * 150
  });

  it('honors the cost_basis_method setting (fifo vs weighted_avg realized gain)', async () => {
    // Two lots at different prices, then sell one unit at 200:
    //   weighted_avg: cost of sold unit = (100+120)/2 = 110 → gain 90
    //   fifo:         cost of sold unit = first lot 100    → gain 100
    const seedQueries = () => query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: 'EUR', current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ id: 1, type: 'buy', amount: 100, units: 1, currency: 'EUR', date: '2025-01-01' }),
          txnRow({ id: 2, type: 'buy', amount: 120, units: 1, currency: 'EUR', date: '2025-06-01' }),
          txnRow({ id: 3, type: 'sell', amount: 200, units: 1, currency: 'EUR', date: '2026-01-01' }),
        ],
      });

    settingsRepository.get.mockResolvedValueOnce('weighted_avg');
    seedQueries();
    const weighted = await getPortfolioSummary('EUR');
    expect(weighted.summaries[0].realizedGain).toBe(90);

    settingsRepository.get.mockResolvedValueOnce('fifo');
    seedQueries();
    const fifo = await getPortfolioSummary('EUR');
    expect(fifo.summaries[0].realizedGain).toBe(100);
    expect(fifo.summaries[0].totalInvested).toBe(120); // remaining lot at 120
  });

  it('falls back to weighted_avg on an invalid stored method', async () => {
    settingsRepository.get.mockResolvedValueOnce('not-a-method');
    query
      .mockResolvedValueOnce({ rows: [investmentRow({ currency: 'EUR', current_price: 150 })] })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ id: 1, type: 'buy', amount: 100, units: 1, currency: 'EUR', date: '2025-01-01' }),
          txnRow({ id: 2, type: 'buy', amount: 120, units: 1, currency: 'EUR', date: '2025-06-01' }),
          txnRow({ id: 3, type: 'sell', amount: 200, units: 1, currency: 'EUR', date: '2026-01-01' }),
        ],
      });

    const result = await getPortfolioSummary('EUR');
    expect(result.summaries[0].realizedGain).toBe(90); // weighted_avg
  });
});
