/**
 * calculations/currency façade tests.
 *
 * Phase 0 is additive: the new module re-exports the same API as the legacy
 * currencyConversionService. Test locks that identity so future merging can
 * swap implementations without call-site drift.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
}));
vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const facade = await import('../src/services/calculations/currency.js');
const legacy = await import('../src/services/currencyConversionService.js');

describe('services/calculations/currency', () => {
  it('re-exports the legacy API surface identically', () => {
    expect(facade.convertToEur).toBe(legacy.convertToEur);
    expect(facade.convertRowsToEur).toBe(legacy.convertRowsToEur);
    expect(facade.convertToCurrency).toBe(legacy.convertToCurrency);
    expect(facade.warmCache).toBe(legacy.warmCache);
    expect(facade.clearMemoryCache).toBe(legacy.clearMemoryCache);
    expect(facade.backfillPortfolioHistoricalRates)
      .toBe(legacy.backfillPortfolioHistoricalRates);
    expect(facade.FALLBACK_RATES).toBe(legacy.FALLBACK_RATES);
  });

  it('FALLBACK_RATES exposes a usable EUR baseline', () => {
    expect(facade.FALLBACK_RATES.EUR).toBe(1);
    expect(Object.keys(facade.FALLBACK_RATES).length).toBeGreaterThan(10);
  });

  it('convertToCurrency returns input unchanged when from === to', async () => {
    const result = await facade.convertToCurrency(42, 'EUR', 'EUR');
    expect(result).toBe(42);
  });
});
