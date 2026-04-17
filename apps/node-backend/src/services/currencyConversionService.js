/**
 * Currency Conversion Service — re-export barrel
 *
 * Implementation lives in ./currency/currencyConversionService.js
 * This file preserves backward compatibility for existing callers.
 */

export {
  convertToEur,
  convertRowsToEur,
  convertToCurrency,
  warmCache,
  clearMemoryCache,
  backfillPortfolioHistoricalRates,
  FALLBACK_RATES,
} from './currency/currencyConversionService.js';

export { default } from './currency/currencyConversionService.js';
