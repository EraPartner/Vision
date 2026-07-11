import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

// Keep convertWithRates real (pure math); only stub the DB-backed current-rate loader.
vi.mock('../src/services/currency/currencyConversionService.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadCurrentRates: vi.fn() };
});

import { query } from '../src/database/connection.js';
import { loadCurrentRates } from '../src/services/currency/currencyConversionService.js';
import { fetchTaxData } from '../src/services/reports/dataFetcherTax.js';

const dividendRow = (over = {}) => ({
  id: 1,
  investment_id: 10,
  investment_name: 'Acme',
  symbol: 'ACME',
  asset_class: 'stock',
  type: 'dividend',
  amount: 1000,
  taxes: 150,
  fees: 0,
  currency: 'USD',
  rate_date: '2024-03-15',
  year: 2024,
  month: 3,
  ...over,
});

describe('fetchTaxData — Belgian tax FX uses transaction-date rates (ADR-085)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Today's USD rate is deliberately different from the historical one so the test
    // can tell which rate was applied.
    loadCurrentRates.mockResolvedValue({ EUR: 1, USD: 0.8 });
  });

  it('converts a foreign-currency dividend at the rate on the transaction date, not today', async () => {
    query
      .mockResolvedValueOnce({ rows: [dividendRow()] })
      .mockResolvedValueOnce({ rows: [{ currency_code: 'USD', rate_date: '2024-03-15', rate_to_eur: 0.9 }] });

    const data = await fetchTaxData('EUR', { kind: 'year', year: 2024 }, {});

    // 1000 USD * 0.90 (15 Mar 2024) = 900 EUR, NOT 1000 * 0.80 (today) = 800 EUR.
    expect(data.dividendsReceived).toBeCloseTo(900, 6);
    // 150 USD withholding * 0.90 = 135 EUR.
    expect(data.dividendWHTTotal).toBeCloseTo(135, 6);
  });

  it('uses the rate on-or-before the date when no exact-day rate exists (weekend convention)', async () => {
    query
      .mockResolvedValueOnce({ rows: [dividendRow({ rate_date: '2024-03-16' })] }) // a Saturday
      .mockResolvedValueOnce({ rows: [{ currency_code: 'USD', rate_date: '2024-03-15', rate_to_eur: 0.9 }] });

    const data = await fetchTaxData('EUR', { kind: 'year', year: 2024 }, {});

    // Saturday transaction falls back to Friday's stored rate (0.90), not today's.
    expect(data.dividendsReceived).toBeCloseTo(900, 6);
  });

  it('falls back to the current rate when no historical rate exists on/before the date', async () => {
    query
      .mockResolvedValueOnce({ rows: [dividendRow({ taxes: 0 })] })
      .mockResolvedValueOnce({ rows: [] }); // nothing stored

    const data = await fetchTaxData('EUR', { kind: 'year', year: 2024 }, {});

    // No historical rate → current rate 0.80 → 1000 * 0.80 = 800 EUR.
    expect(data.dividendsReceived).toBeCloseTo(800, 6);
  });

  it('leaves EUR rows untouched and skips the FX lookup entirely', async () => {
    query.mockResolvedValueOnce({ rows: [dividendRow({ currency: 'EUR', amount: 500, taxes: 30 })] });

    const data = await fetchTaxData('EUR', { kind: 'year', year: 2024 }, {});

    expect(data.dividendsReceived).toBeCloseTo(500, 6);
    expect(data.dividendWHTTotal).toBeCloseTo(30, 6);
    // Only the transactions query runs — no exchange_rates query for an all-EUR set.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('flags currencies summed 1:1 when no rate (historical or current) is available', async () => {
    // KRW has neither a stored historical rate nor a current rate.
    query
      .mockResolvedValueOnce({ rows: [dividendRow({ currency: 'KRW', amount: 1000, taxes: 0 })] })
      .mockResolvedValueOnce({ rows: [] }); // no historical rate stored for KRW

    const data = await fetchTaxData('EUR', { kind: 'year', year: 2024 }, {});

    // Summed at an unconverted 1:1 rate (1000 KRW → 1000), and surfaced so the
    // report can annotate it as approximate (ADR-085) instead of silently lying.
    expect(data.dividendsReceived).toBeCloseTo(1000, 6);
    expect(data.unconvertedCurrencies).toEqual(['KRW']);
  });

  it('buckets sell-leg taxes into TOB, not "Capital Gains / Sell Tax" (TOB hits both legs)', async () => {
    // Belgian TOB is levied on transfer AND acquisition — a sell's pt.taxes is
    // TOB like a buy's. It used to land in sellTaxTotal, rendered under a
    // "Capital Gains / Sell Tax" label (materially misleading with CGT at 0%
    // through 2025) while the TOB line under-reported the whole sell side.
    query.mockResolvedValueOnce({
      rows: [
        dividendRow({ id: 2, type: 'buy', amount: 1000, taxes: 3.5, currency: 'EUR' }),
        dividendRow({ id: 3, type: 'sell', amount: 1200, taxes: 4.2, currency: 'EUR' }),
      ],
    });

    const data = await fetchTaxData('EUR', { kind: 'year', year: 2024 }, {});

    expect(data.tobTotal).toBeCloseTo(7.7, 6); // buy 3.5 + sell 4.2
    expect(data.sellTaxTotal).toBe(0);
  });
});
