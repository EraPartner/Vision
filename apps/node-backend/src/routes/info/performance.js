/**
 * /api/info/portfolio-performance:
 *   - Pre-computed portfolio performance snapshots with period filtering at full daily resolution.
 */

import { Router } from "express";
import {
  getSnapshots,
  getBrokerSnapshots,
} from "../../services/portfolioPerformanceSnapshotService.js";
import { rateLimiter } from "../../middleware/rateLimiter.js";
import { getTargetCurrency, getCurrentDateString } from "./_queryParams.js";
import {
  perfResponseCache,
  PERF_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from "../../services/info/cache.js";
import { buildPortfolioPerformancePayload } from "../../services/info/performanceHelpers.js";

/**
 * @typedef {import('../../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

router.get(
  "/portfolio-performance/by-broker",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "portfolio-broker-performance",
  }),
  async (req, res) => {
    const targetCurrency = getTargetCurrency(req);
    const startDate =
      typeof req.query.from === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
        ? req.query.from
        : "2000-01-01";
    const endDate =
      typeof req.query.to === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
        ? req.query.to
        : getCurrentDateString();
    const rows = await getBrokerSnapshots(startDate, endDate, targetCurrency);
    const dates = [...new Set(rows.map((row) => row.date))];
    const series = [
      ...new Map(
        rows.map((row) => [
          row.accountKey,
          {
            accountKey: row.accountKey,
            accountId: row.accountId,
            accountName: row.accountName,
            assignment: row.assignment,
          },
        ]),
      ).values(),
    ];
    res.ok({
      currency: targetCurrency,
      startDate,
      endDate,
      dates,
      series,
      rows,
    });
  },
);

router.get(
  "/portfolio-performance",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "portfolio-performance",
  }),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const targetCurrency = getTargetCurrency(req);
    const period = req.query.period || "all";
    const startDate = "2000-01-01";
    const endDate = getCurrentDateString();
    const cacheKey = `${targetCurrency}:${period}`;

    const data = await resolveCacheWithInflight(perfResponseCache, cacheKey, {
      ttlMs: PERF_CACHE_TTL_MS,
      loader: async () => {
        const snapshots = await getSnapshots(
          startDate,
          endDate,
          targetCurrency,
        );
        return buildPortfolioPerformancePayload(
          targetCurrency,
          startDate,
          endDate,
          snapshots,
          period,
        );
      },
    });
    res.ok(data);
  },
);

export default router;
