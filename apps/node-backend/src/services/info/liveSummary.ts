/**
 * Shared resolver for the live portfolio summary.
 *
 * Served from the same module-scoped 60s cache the /portfolio-summary and
 * /portfolio-performance routes use, so every surface that shows the "current"
 * portfolio value (dashboard, performance, net-worth overlay) reads one
 * computation instead of recomputing per request. This is the single source of
 * truth for the current portfolio value across those surfaces.
 */

import { logger } from "../../config/logger.ts";
import { getPortfolioSummary } from "../portfolio/portfolioSummaryService.ts";
import type { PortfolioSummary } from "../portfolio/portfolioSummaryService.ts";
import {
  portfolioSummaryCache,
  PORTFOLIO_SUMMARY_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from "./cache.ts";

/** Live portfolio summary (cached, inflight-deduped). */
export function resolveLiveSummary(
  targetCurrency: string = "EUR",
): Promise<PortfolioSummary> {
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
 */
export async function resolveLivePortfolioValue(
  targetCurrency: string = "EUR",
): Promise<number | undefined> {
  try {
    // getPortfolioSummary builds `totals.totalPortfolioValue` as a rounded
    // number; the optional chaining guards a summary that resolved empty.
    const summary: Partial<PortfolioSummary> | undefined =
      await resolveLiveSummary(targetCurrency);
    const value = summary?.totals?.totalPortfolioValue;
    return Number.isFinite(value) ? value : undefined;
  } catch (err) {
    logger.warn(
      "Live portfolio value unavailable for net-worth overlay; using snapshot value",
      {
        targetCurrency,
        error: (err as Error | undefined)?.message,
      },
    );
    return undefined;
  }
}
