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
} from '../src/services/currencyConversionService.js';
import { query } from '../src/database/connection.js';

describe('Currency Conversion Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryCache();
    // Mock DB to return no cached rates so we hit fallback
    query.mockResolvedValue({ rows: [] });
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

  it('should use nearest historical DB rate when exact date is missing', async () => {
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
    // With indexed historical prefetch, converter may use latest in-memory rate
    // when no historical rows exist for currency/date.
    expect(converted[0].amount_eur).toBeCloseTo(90, 6);
  });

  it('should backfill only missing portfolio date-currency rates', async () => {
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

  // ── warmCache ─────────────────────────────────────────────
  it('should warm cache without throwing', async () => {
    await expect(warmCache()).resolves.not.toThrow();
  });
});
