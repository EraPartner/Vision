/**
 * Shared resolver for the live portfolio summary.
 *
 * Served from the same module-scoped 60s cache the /portfolio-summary and
 * /portfolio-performance routes use, so every surface that shows the "current"
 * portfolio value (dashboard, performance, net-worth overlay) reads one
 * computation instead of recomputing per request. This is the single source of
 * truth for the current portfolio value across those surfaces.
 */

import { logger } from '../../config/logger.js';
import { getPortfolioSummary } from '../portfolio/portfolioSummaryService.js';
import {
  portfolioSummaryCache,
  PORTFOLIO_SUMMARY_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from './cache.js';

/**
 * Live portfolio summary (cached, inflight-deduped).
 * @param {string} targetCurrency
 * @returns {Promise<object>}
 */
export function resolveLiveSummary(targetCurrency = 'EUR') {
  return resolveCacheWithInflight(portfolioSummaryCache, targetCurrency, {
    ttlMs: PORTFOLIO_SUMMARY_CACHE_TTL_MS,
    loader: () => getPortfolioSummary(targetCurrency),
  });
}

/**
 * Live total portfolio value (current market value in `targetCurrency`), or
 * undefined when the summary is unavailable. Used to overlay the most-recent
 * net-worth point so it reconciles with the dashboard/performance cards.
 * Failures degrade to undefined (caller falls back to the stored snapshot
 * value) rather than failing the whole request.
 *
 * @param {string} targetCurrency
 * @returns {Promise<number|undefined>}
 */
export async function resolveLivePortfolioValue(targetCurrency = 'EUR') {
  try {
    const summary = await resolveLiveSummary(targetCurrency);
    const value = summary?.totals?.totalPortfolioValue;
    return Number.isFinite(value) ? value : undefined;
  } catch (err) {
    logger.warn('Live portfolio value unavailable for net-worth overlay; using snapshot value', {
      targetCurrency,
      error: err?.message,
    });
    return undefined;
  }
}
