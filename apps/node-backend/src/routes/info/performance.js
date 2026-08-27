/**
 * /api/info/portfolio-performance:
 *   - Pre-computed portfolio performance snapshots with period filtering at full daily resolution.
 */

import { Router } from 'express';
import { getSnapshots } from '../../services/portfolioPerformanceSnapshotService.js';
import { rateLimiter } from '../../middleware/rateLimiter.js';
import { getTargetCurrency, getCurrentDateString } from './_queryParams.js';
import {
  perfResponseCache,
  PERF_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from '../../services/info/cache.js';
import { buildPortfolioPerformancePayload } from '../../services/info/performanceHelpers.js';

/**
 * @typedef {import('../../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

router.get('/portfolio-performance', rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'portfolio-performance' }), /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const period = req.query.period || 'all';
  const startDate = '2000-01-01';
  const endDate = getCurrentDateString();
  const cacheKey = `${targetCurrency}:${period}`;

  const data = await resolveCacheWithInflight(perfResponseCache, cacheKey, {
    ttlMs: PERF_CACHE_TTL_MS,
    loader: async () => {
      const snapshots = await getSnapshots(startDate, endDate, targetCurrency);
      return buildPortfolioPerformancePayload(targetCurrency, startDate, endDate, snapshots, period);
    },
  });
  res.ok(data);
});

export default router;
