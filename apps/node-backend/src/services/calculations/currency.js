/**
 * calculations/currency — consolidated FX façade.
 *
 * Phase 0 status (additive): re-exports the proven surface from
 * `services/currencyConversionService.js`. Call-sites continue importing the
 * old module until Phase 9 cleanup; new code should import from here so that
 * when the consolidation completes (merging the ECB + open.er-api fetch paths,
 * the DB-backed `exchange_rate_cache` pair table, and the historical lookup
 * helpers) there is a single import location to freeze as the public API.
 *
 * Scope of the eventual merge (tracked in plan Phase 0 step 4):
 *   - Keep ECB-priority + open.er-api supplement fetch semantics
 *   - Replace the in-memory `memoryCache` + `historicalEcb90dCache` with
 *     queries against the new `exchange_rate_cache(from_ccy, to_ccy, date, rate,
 *     fetched_at)` table (see alembic 0025)
 *   - Preserve `FALLBACK_RATES` as the last-resort safety net
 *   - Preserve conversion helpers verbatim for backward compatibility
 */

export {
  convertToEur,
  convertRowsToEur,
  convertToCurrency,
  warmCache,
  clearMemoryCache,
  backfillPortfolioHistoricalRates,
  FALLBACK_RATES,
} from '../currencyConversionService.js';
