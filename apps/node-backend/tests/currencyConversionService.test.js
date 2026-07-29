/**
 * Currency Conversion Service tests.
 * Mirrors: apps/backend/tests/test_currency_conversion_service.py
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from './helpers/mockLogger.js';

// Mock database
vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
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

  it('probes a currency with no stored rates ONCE per request, not once per distinct day', async () => {
    // A daily series (balance history) hands this function up to 366 distinct
    // days. The historical index is empty only when `exchange_rates` holds no
    // row for the currency at all — and then the per-date point lookup misses
    // on every single day and goes to the network, which offline means
    // hundreds of sequential multi-second timeouts. One attempt per currency
    // per request is enough; it saves what it fetches for next time.
    query.mockResolvedValue({ rows: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' });

    const rows = Array.from({ length: 60 }, (_, i) => ({
      amount: 1,
      currency: 'ZZZ',
      day: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    }));

    const converted = await convertRowsToEur(rows, 'EUR', { useHistoricalRatesByDate: true, dateField: 'day' });
    expect(converted).toHaveLength(60);

    const sqlCalls = query.mock.calls.map(([sql]) => String(sql));
    const exactLookups = sqlCalls.filter(sql => sql.includes('WHERE currency_code = $1 AND rate_date = $2::date'));
    const nearestLookups = sqlCalls.filter(sql => sql.includes('ORDER BY ABS(rate_date - $2::date) ASC'));
    expect(exactLookups).toHaveLength(1);
    expect(nearestLookups).toHaveLength(1);
    // 60 distinct days must not become 60 provider round-trips either.
    expect(global.fetch.mock.calls.length).toBeLessThanOrEqual(2);
  });

  /**
   * Route the mocked DB by SQL shape — the backfill flow now spans the pairs
   * scan, the repair flag in user_settings, rate lookups/saves and the
   * fx_rate_to_eur stamping, so positional mocks are unreadable.
   */
  function dispatchQueries(handlers) {
    query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      for (const [pattern, result] of handlers) {
        if (s.includes(pattern)) {
          return typeof result === 'function' ? result(params, s) : result;
        }
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it('does not fabricate exchange-rate history for unresolvable old dates', async () => {
    // Block every external fetch so neither the 90d nor the full feed resolves.
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '',
    });

    dispatchQueries([
      ['FROM user_settings', { rows: [{ value: true }] }], // repair already done
      ['LEFT JOIN exchange_rates', { rows: [{ currency_code: 'USD', rate_date: '2024-01-01' }] }],
      ['GROUP BY pt.currency', { rows: [{ currency_code: 'USD', rate_date: '2024-01-01' }] }],
      ['SELECT rate_to_eur\n     FROM exchange_rates\n     WHERE currency_code = $1 AND rate_date = $2::date', { rows: [] }],
      ['ORDER BY ABS(rate_date - $2::date)', { rows: [{ rate_to_eur: 0.91 }] }], // nearest — must NOT be saved
      ['SELECT 1 FROM exchange_rates', { rows: [] }],
      ['to_regclass', { rows: [{ base_table: null }] }],
      ['SET fx_rate_to_eur', { rows: [], rowCount: 0 }],
    ]);

    const result = await backfillPortfolioHistoricalRates();

    // The nearest-rate fallback is reported as unresolved, not inserted as history.
    expect(result).toEqual({ inserted: 0, missing: 1, repaired: 0, stamped: 0 });
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO exchange_rates'));
    expect(inserts).toHaveLength(0);
  });

  it('should use ECB historical feed during backfill when exact date exists in 90d feed', async () => {
    query.mockReset();
    clearMemoryCache();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<Cube><Cube time='2026-02-01'><Cube currency='USD' rate='2.0000'/></Cube></Cube>",
    });

    let savedRate = false;
    dispatchQueries([
      ['FROM user_settings', { rows: [{ value: true }] }], // repair already done
      ['LEFT JOIN exchange_rates', { rows: [{ currency_code: 'USD', rate_date: '2026-02-01' }] }],
      ['GROUP BY pt.currency', { rows: [{ currency_code: 'USD', rate_date: '2026-02-01' }] }],
      ['INSERT INTO exchange_rates', () => { savedRate = true; return { rows: [] }; }],
      ['SELECT rate_to_eur\n     FROM exchange_rates\n     WHERE currency_code = $1 AND rate_date = $2::date', { rows: [] }],
      // Batched existence check (replaces the former per-row SELECT 1): returns
      // the now-present pair once the rate has been saved.
      ['JOIN UNNEST', () => ({ rows: savedRate ? [{ currency_code: 'USD', rate_date: '2026-02-01' }] : [] })],
      ['to_regclass', { rows: [{ base_table: null }] }],
      ['SET fx_rate_to_eur', { rows: [], rowCount: 1 }],
    ]);

    const result = await backfillPortfolioHistoricalRates();

    expect(result).toEqual({ inserted: 1, missing: 0, repaired: 0, stamped: 1 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('eurofxref-hist-90d.xml'),
      expect.any(Object)
    );
  });

  it('repairs previously fabricated old rates from the full ECB history (one-time)', async () => {
    query.mockReset();
    clearMemoryCache();

    // 90d feed empty; full-history feed carries the true old rate (1/2 = 0.5).
    global.fetch = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes('eurofxref-hist.xml')) {
        return {
          ok: true,
          text: async () => "<Cube><Cube time='2020-03-02'><Cube currency='USD' rate='2.0000'/></Cube></Cube>",
        };
      }
      return { ok: false, status: 503, text: async () => '' };
    });

    let repairFlagSet = false;
    const savedRates = [];
    dispatchQueries([
      ['FROM user_settings', () => ({ rows: repairFlagSet ? [{ value: true }] : [] })],
      ['INSERT INTO user_settings', () => { repairFlagSet = true; return { rows: [] }; }],
      ['LEFT JOIN exchange_rates', { rows: [] }], // nothing missing after repair
      // weekend txn date 2020-03-07 → stored fabricated rate differs from truth
      ['GROUP BY pt.currency', { rows: [{ currency_code: 'USD', rate_date: '2020-03-07' }] }],
      ['WHERE currency_code = ANY', { rows: [{ currency_code: 'USD', rate_date: '2020-03-07', rate_to_eur: 0.91 }] }],
      ['INSERT INTO exchange_rates', (params) => { savedRates.push(params); return { rows: [] }; }],
      ['to_regclass', { rows: [{ base_table: null }] }],
      ['SET fx_rate_to_eur', { rows: [], rowCount: 1 }],
    ]);

    const result = await backfillPortfolioHistoricalRates();

    expect(result).toEqual({ inserted: 0, missing: 0, repaired: 1, stamped: 1 });
    // The Saturday date resolves to the preceding business day's rate
    // (2020-03-02 in this fixture) per the on-or-before convention, and is
    // saved under the transaction's own date. saveHistoricalRate binds
    // (currency, rate, date).
    expect(savedRates).toHaveLength(1);
    expect(savedRates[0][0]).toBe('USD');
    expect(savedRates[0][1]).toBeCloseTo(0.5, 10);
    expect(savedRates[0][2]).toBe('2020-03-07');
    expect(repairFlagSet).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('eurofxref-hist.xml'),
      expect.any(Object)
    );
  });

  it('caches the historical rate index and reuses it across convertRowsToEur calls', async () => {
    clearMemoryCache();
    query.mockReset();
    query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('is_latest = true')) return { rows: [] }; // getRates → fallback
      if (s.includes('WHERE currency_code = ANY')) {
        return { rows: [{ currency_code: 'USD', rate_date: '2024-03-15', rate_to_eur: 0.9 }] };
      }
      return { rows: [] };
    });

    const rows = [{ amount: 100, currency: 'USD', day: '2024-03-15' }];
    const opts = { useHistoricalRatesByDate: true, dateField: 'day' };

    const [first] = await convertRowsToEur(rows, 'EUR', opts);
    const [second] = await convertRowsToEur(rows, 'EUR', opts);

    expect(first.amount_eur).toBeCloseTo(90, 6);
    expect(second.amount_eur).toBeCloseTo(90, 6);

    // The full-history index load runs once; the second call reuses the cache.
    const indexLoads = query.mock.calls.filter(([sql]) => String(sql).includes('WHERE currency_code = ANY'));
    expect(indexLoads).toHaveLength(1);
  });

  // ── warmCache ─────────────────────────────────────────────
  it('should warm cache without throwing', async () => {
    // Mock both upstream fetches so the test never reaches real ECB / open.er-api
    // endpoints. The unmocked variant flaked under CI coverage instrumentation
    // (845ms locally → >5s in CI when network was slow/blocked).
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => '' })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

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
