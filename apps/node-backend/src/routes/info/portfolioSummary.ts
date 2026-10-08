/**
 * /api/info/portfolio-summary:
 *   - Realtime portfolio totals + per-investment summaries.
 *   - Single source of truth for portfolio dashboard and performance headline cards.
 *   - All monetary values pre-converted to the requested target currency.
 */

import { Router } from "express";
import { getPortfolioSummary } from "../../services/portfolio/portfolioSummaryService.ts";
import { rateLimiter } from "../../middleware/rateLimiter.ts";
import { targetCurrencyQuerySchema } from "./_queryParams.ts";
import { parseInput } from "../../lib/zodInput.ts";
import {
  portfolioSummaryCache,
  PORTFOLIO_SUMMARY_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from "../../services/info/cache.ts";

const router = Router();

router.get(
  "/portfolio-summary",
  rateLimiter({ windowMs: 60_000, maxRequests: 60 }),
  async (req, res) => {
    const { targetCurrency } = parseInput(targetCurrencyQuerySchema, req.query);
    const cacheKey = targetCurrency;

    const data = await resolveCacheWithInflight(
      portfolioSummaryCache,
      cacheKey,
      {
        ttlMs: PORTFOLIO_SUMMARY_CACHE_TTL_MS,
        loader: () => getPortfolioSummary(targetCurrency),
      },
    );
    res.ok(data);
  },
);

export default router;
