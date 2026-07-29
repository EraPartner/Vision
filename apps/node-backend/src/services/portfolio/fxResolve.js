/**
 * Shared FX auto-resolution for portfolio transactions.
 *
 * When a transaction's currency differs from EUR and no fx_rate_to_eur was
 * supplied, look up the on-or-before stored rate (ADR-074 semantics). Returns
 * undefined for EUR or when no rate can be resolved — the caller then leaves
 * fx_rate_to_eur unset and the read path applies its own fallback.
 *
 * Used by both the single-add controller and the CSV-import commit phase so FX
 * semantics live in one place.
 */

import { getStoredRateToEurOnOrBefore, normalizeDateInput } from '../currency/rateFetcher.js';
import { logger } from '../../config/logger.js';

/**
 * @param {string} currency
 * @param {string|Date|null|undefined} date
 * @returns {Promise<number|undefined>}
 */
export async function autoResolveFxRateToEur(currency, date) {
  const code = String(currency || 'EUR').toUpperCase().trim();
  if (code === 'EUR') return undefined;
  try {
    return await getStoredRateToEurOnOrBefore(code, normalizeDateInput(date));
  } catch (err) {
    logger.warn('fx_rate_to_eur auto-resolution failed', { currency: code, date, error: err.message });
    return undefined;
  }
}
