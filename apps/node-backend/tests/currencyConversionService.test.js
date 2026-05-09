/**
 * Currency Conversion Service tests.
 * Mirrors: apps/backend/tests/test_currency_conversion_service.py
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock database
vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  clearMemoryCache,
  convertToEur,
  convertRowsToEur,
  convertToCurrency,
  warmCache,
  backfillPortfolioHistoricalRates,
} from '../src/services/currency/currencyConversionService.js';
import { query } from '../src/database/connection.js';
import { logger } from '../src/config/logger.js';

const originalFetch = global.fetch;

describe('Currency Conversion Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryCache();
    // Mock DB to return no cached rates so we hit fallback
    query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
      return;
    }
    delete global.fetch;
  });

  // ── EUR identity ──────────────────────────────────────────
  it('should return same amount for EUR to EUR', async () => {
    const result = await convertToEur(100.00, 'EUR');
    expect(result).toBe(100.00);
  });

  it('should return same amount for null currency', async () => {
    const result = await convertToEur(100.00, null);
    expect(result).toBe(100.00);
  });

  it('should return same amount for undefined currency', async () => {
    const result = await convertToEur(100.00, undefined);
    expect(result).toBe(100.00);
  });

  // ── Zero / edge amounts ───────────────────────────────────
  it('should return 0 for zero amount', async () => {
    const result = await convertToEur(0.0, 'USD');
    expect(result).toBe(0);
  });

  it('should handle negative amounts (preserve sign)', async () => {
    const result = await convertToEur(-100.00, 'USD');
    expect(result).toBeLessThan(0);
    expect(typeof result).toBe('number');
  });

  // ── Fallback rates ───────────────────────────────────────
  it('should convert USD to EUR using fallback rates', async () => {
    // DB returns nothing, API will fail in test → fallback
    const result = await convertToEur(109.00, 'USD');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(50); // reasonable range
    expect(result).toBeLessThan(200);
  });

  it('should convert GBP to EUR using fallback rates', async () => {
    const result = await convertToEur(100.00, 'GBP');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(80);
  });

  it('should use 1:1 for unsupported currency', async () => {
    const result = await convertToEur(100.00, 'XYZ');
    expect(result).toBe(100.00);
  });

  // ── Case insensitivity ────────────────────────────────────
  it('should handle lowercase currency codes', async () => {
    const result = await convertToEur(100.00, 'eur');
    expect(result).toBe(100.00);
  });

  it('should handle mixed-case currency codes', async () => {
    const result = await convertToEur(100.00, 'Eur');
    expect(result).toBe(100.00);
  });

  // ── Cached DB rates ───────────────────────────────────────
  it('should load rates from database when available', async () => {
    query.mockResolvedValue({
      rows: [
        { currency_code: 'USD', rate_to_eur: 0.917, fetched_at: new Date().toISOString() },
        { currency_code: 'GBP', rate_to_eur: 1.16, fetched_at: new Date().toISOString() },
      ],
    });

    const result = await convertToEur(100.00, 'USD', '2026-02-17');
    expect(typeof result).toBe('number');
    // Should use the DB rate (100 * 0.917 ≈ 91.7)
    expect(result).toBeCloseTo(91.7, 0);
  });

  // ── Multiple currencies ───────────────────────────────────
  it('should convert multiple currencies correctly', async () => {
    const usd = await convertToEur(100.00, 'USD');
    const gbp = await convertToEur(100.00, 'GBP');
    const jpy = await convertToEur(10000.00, 'JPY');

    expect(typeof usd).toBe('number');
    expect(typeof gbp).toBe('number');
    expect(typeof jpy).toBe('number');
    // GBP should be worth more than USD per unit
    expect(gbp).toBeGreaterThan(usd);
  });

  // ── convertRowsToEur ─────────────────────────────────────
  it('should convert rows to EUR', async () => {
    const rows = [
      { amount: '100.00', currency: 'EUR', date: '2026-01-15' },
      { amount: '-50.00', currency: 'EUR', date: '2026-01-16' },
    ];

    const results = await convertRowsToEur(rows);
    expect(results).toHaveLength(2);
    expect(results[0].amount_eur).toBe(100.00);
    expect(results[1].amount_eur).toBe(-50.00);
  });

  it('should return empty array for empty rows', async () => {
    const results = await convertRowsToEur([]);
    expect(results).toEqual([]);
  });

  it('should return empty array for null rows', async () => {
    const results = await convertRowsToEur(null);
    expect(results).toEqual([]);
  });

  it('should convert rows to a non-EUR target currency', async () => {
    query.mockResolvedValue({
      rows: [
        { currency_code: 'USD', rate_to_eur: 0.5 },
        { currency_code: 'HUF', rate_to_eur: 0.0025 },
      ],
    });

    const rows = [{ amount: 100, currency: 'USD' }];
    const results = await convertRowsToEur(rows, 'HUF');
    // USD->EUR: 100 * 0.5 = 50; EUR->HUF divide by 0.0025 => 20000
    expect(results[0].amount_eur).toBeCloseTo(20000, 6);
  });

  it('should convert amount between arbitrary currencies', async () => {
    query.mockResolvedValue({
      rows: [
        { currency_code: 'USD', rate_to_eur: 0.5 },
        { currency_code: 'GBP', rate_to_eur: 1.25 },
      ],
    });

    const result = await convertToCurrency(100, 'USD', 'GBP');
    // 100 USD -> 50 EUR -> 40 GBP
    expect(result).toBeCloseTo(40, 6);
  });

  it('should fall back to EUR conversion when target currency is unsupported', async () => {
    query.mockResolvedValue({
      rows: [{ currency_code: 'USD', rate_to_eur: 0.5 }],
    });

    const result = await convertToCurrency(100, 'USD', 'ZZZ');
    expect(result).toBeCloseTo(50, 6);
  });

  it('should use 1:1 row conversion when source currency is unsupported', async () => {
    const [row] = await convertRowsToEur([{ amount: 50, currency: 'XYZ' }], 'EUR');
    expect(row.amount_eur).toBe(50);
  });

  it('should fall back to EUR row conversion when target currency is unsupported', async () => {
    const [row] = await convertRowsToEur([{ amount: 50, currency: 'USD' }], 'ZZZ');
    const expectedEur = await convertToEur(50, 'USD');

    expect(row.amount_eur).toBeCloseTo(expectedEur, 6);
  });

  it('should use nearest historical DB rate when exact date is missing', async () => {
    // Block ECB 90d fetch so getRateToEurForDate falls through to the DB nearest lookup deterministically.
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '',
    });

    query
      // getRates() initial load
      .mockResolvedValueOnce({ rows: [{ currency_code: 'USD', rate_to_eur: 0.9 }, { currency_code: 'EUR', rate_to_eur: 1.0 }] })
      // historical index load -> no rows for that date
      .mockResolvedValueOnce({ rows: [] })
      // exact rate lookup for USD/date -> none
      .mockResolvedValueOnce({ rows: [] })
      // nearest rate lookup for USD/date -> available
      .mockResolvedValueOnce({ rows: [{ rate_to_eur: 0.8 }] });

    const rows = [{ amount: 100, currency: 'USD', day: '2020-01-15' }];
    const converted = await convertRowsToEur(rows, 'EUR', { useHistoricalRatesByDate: true, dateField: 'day' });
    // With indexed historical prefetch and empty exact match, converter uses nearest DB rate.
    expect(converted[0].amount_eur).toBeCloseTo(80, 6);
  });

  it('should cache historical miss per currency/date and avoid duplicate DB lookups', async () => {
    query
      // getRates() initial load
      .mockResolvedValueOnce({ rows: [] })
      // historical index prefetch
      .mockResolvedValueOnce({ rows: [] })
      // exact historical lookup for ZZZ/date
      .mockResolvedValueOnce({ rows: [] })
      // nearest historical lookup for ZZZ/date
      .mockResolvedValueOnce({ rows: [] });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '',
    });

    const rows = [
      { amount: 10, currency: 'ZZZ', day: '2020-01-15' },
      { amount: 20, currency: 'ZZZ', day: '2020-01-15' },
    ];

    const converted = await convertRowsToEur(rows, 'EUR', { useHistoricalRatesByDate: true, dateField: 'day' });

    expect(converted).toHaveLength(2);
    expect(converted[0].amount_eur).toBe(10);
    expect(converted[1].amount_eur).toBe(20);

    const sqlCalls = query.mock.calls.map(([sql]) => String(sql));
    const exactLookups = sqlCalls.filter(sql => sql.includes('WHERE currency_code = $1 AND rate_date = $2::date'));
    const nearestLookups = sqlCalls.filter(sql => sql.includes('ORDER BY ABS(rate_date - $2::date) ASC'));

    expect(exactLookups).toHaveLength(1);
    expect(nearestLookups).toHaveLength(1);
  });

  it('should backfill only missing portfolio date-currency rates', async () => {
    // Block ECB 90d fetch so backfill falls through to the DB nearest lookup deterministically.
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '',
    });

    query
      // missing pairs scan
      .mockResolvedValueOnce({ rows: [{ currency_code: 'USD', rate_date: '2024-01-01' }] })
      // exact lookup in getRateToEurForDate -> none
      .mockResolvedValueOnce({ rows: [] })
      // ECB 90d fetch won't include this old date, so nearest lookup
      .mockResolvedValueOnce({ rows: [{ rate_to_eur: 0.91 }] })
      // exactCheck before insert -> none
      .mockResolvedValueOnce({ rows: [] })
      // saveHistoricalRate insert
      .mockResolvedValueOnce({ rows: [] });

    const result = await backfillPortfolioHistoricalRates();
    expect(result.inserted).toBeGreaterThanOrEqual(0);
    expect(result.missing).toBeGreaterThanOrEqual(0);
  });

  it('should use ECB historical feed during backfill when exact date exists in 90d feed', async () => {
    query.mockReset();
    clearMemoryCache();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<Cube><Cube time='2026-02-01'><Cube currency='USD' rate='2.0000'/></Cube></Cube>",
    });

    query
      // missing pairs scan
      .mockResolvedValueOnce({ rows: [{ currency_code: 'USD', rate_date: '2026-02-01' }] })
      // exact lookup in getRateToEurForDate -> none
      .mockResolvedValueOnce({ rows: [] })
      // saveHistoricalRate from getRateToEurForDate
      .mockResolvedValueOnce({ rows: [] })
      // exactCheck before insert -> none
      .mockResolvedValueOnce({ rows: [] })
      // saveHistoricalRate from backfill insert path
      .mockResolvedValueOnce({ rows: [] });

    const result = await backfillPortfolioHistoricalRates();

    expect(result).toEqual({ inserted: 1, missing: 0 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('eurofxref-hist-90d.xml'),
      expect.any(Object)
    );
  });

  // ── warmCache ─────────────────────────────────────────────
  it('should warm cache without throwing', async () => {
    await expect(warmCache()).resolves.not.toThrow();
  });

  it('should warm cache from fallback when both APIs are unavailable', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => '' })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    await warmCache();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('all APIs unavailable'));
  });
});
