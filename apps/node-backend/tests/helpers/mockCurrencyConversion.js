import { vi } from "vitest";

/**
 * Fake for tests whose rows are already denominated in the requested target
 * currency. It performs no exchange-rate arithmetic; it only models the real
 * boundary's numeric `amount_eur` field.
 */
export function mockRowsAlreadyInTargetCurrency() {
  return vi.fn(async (rows) =>
    rows.map((row) => ({
      ...row,
      amount_eur: Number(row.amount ?? 0),
    })),
  );
}

/**
 * Complete fake for currencyConversionService.js.
 *
 * Conversion is an identity operation by default. Tests that care about
 * converted values must prime explicit output rows instead of reimplementing
 * exchange-rate arithmetic in the mock.
 *
 * @param {Record<string, any>} [overrides]
 */
export function mockCurrencyConversion(overrides = {}) {
  const module = {
    FALLBACK_RATES: { EUR: 1 },
    clearMemoryCache: vi.fn(),
    clearHistoricalIndexCache: vi.fn(),
    getHistoricalRateIndex: vi.fn(),
    listLatestStoredRates: vi.fn(),
    warmCache: vi.fn(),
    convertRowsToEur: vi.fn(async (rows) => rows),
    convertToCurrency: vi.fn(),
    loadCurrentRates: vi.fn(),
    convertWithRates: vi.fn(),
    backfillPortfolioHistoricalRates: vi.fn(),
    ...overrides,
  };

  return {
    ...module,
    default: {
      convertRowsToEur: module.convertRowsToEur,
      convertToCurrency: module.convertToCurrency,
      loadCurrentRates: module.loadCurrentRates,
      convertWithRates: module.convertWithRates,
      warmCache: module.warmCache,
      clearMemoryCache: module.clearMemoryCache,
      listLatestStoredRates: module.listLatestStoredRates,
      backfillPortfolioHistoricalRates: module.backfillPortfolioHistoricalRates,
      FALLBACK_RATES: module.FALLBACK_RATES,
    },
  };
}
