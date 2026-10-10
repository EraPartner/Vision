import { vi } from "vitest";
import type { Mock } from "vitest";
import type {
  ConvertRowsOptions,
  convertRowsToEur,
} from "../../src/services/currency/currencyConversionService.ts";
import type { batchConvertGroupsWithHistoricalRateFallback } from "../../src/repositories/infoRepositoryHelpers.ts";

/** A row as handed to the conversion boundary: anything with an optional `amount`. */
export interface ConvertibleRow {
  amount?: unknown;
  [column: string]: unknown;
}

/**
 * Fake for tests whose rows are already denominated in the requested target
 * currency. It performs no exchange-rate arithmetic; it only models the real
 * boundary's numeric `amount_eur` field.
 */
export function mockRowsAlreadyInTargetCurrency() {
  return vi.fn(async <R extends ConvertibleRow>(rows: R[]) =>
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
 */
export function mockCurrencyConversion(
  overrides: Record<string, unknown> = {},
) {
  const module = {
    FALLBACK_RATES: { EUR: 1 },
    clearMemoryCache: vi.fn(),
    clearHistoricalIndexCache: vi.fn(),
    getHistoricalRateIndex: vi.fn(),
    listLatestStoredRates: vi.fn(),
    warmCache: vi.fn(),
    convertRowsToEur: vi.fn(async <R>(rows: R[]) => rows),
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

/** A primed converted row: the caller's own columns plus `amount_eur`. */
export type ConvertedFixtureRow = Record<string, unknown> & {
  amount_eur: number;
};

// `vi.mocked` instantiates a generic function at its type-parameter
// constraint, so primed converted rows could carry only the conversion
// columns. Fixtures prime the caller's own columns too; these views type the
// mocks with fixture rows instead.

/** The mocked `convertRowsToEur`, typed for fixture rows. */
export function mockedConvertRowsToEur(fn: typeof convertRowsToEur) {
  return vi.mocked(fn) as unknown as Mock<
    (
      rows: readonly Record<string, unknown>[],
      targetCurrency?: string,
      options?: ConvertRowsOptions | null,
    ) => Promise<ConvertedFixtureRow[]>
  >;
}

/** The mocked `batchConvertGroupsWithHistoricalRateFallback`, typed for fixture rows. */
export function mockedBatchConvertGroups(
  fn: typeof batchConvertGroupsWithHistoricalRateFallback,
) {
  return vi.mocked(fn) as unknown as Mock<
    (
      groups: readonly (readonly Record<string, unknown>[])[],
      targetCurrency: string,
      dateField?: string,
    ) => Promise<ConvertedFixtureRow[][]>
  >;
}
