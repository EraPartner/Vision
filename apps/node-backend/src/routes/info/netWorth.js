/**
 * /api/info/net-worth:
 *   - Returns full snapshot array when no pagination params.
 *   - Returns newest-first slice + pagination meta when limit/offset supplied.
 */

import { Router } from 'express';
// eslint-disable-next-line vision-local/no-repo-direct-from-route
import infoRepository from '../../repositories/infoRepository.js';
import { rateLimiter } from '../../middleware/rateLimiter.js';
import { getTargetCurrency } from './_queryParams.js';
import {
  netWorthResponseCache,
  NET_WORTH_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from './_cache.js';

const router = Router();

router.get(
  '/net-worth',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'net-worth' }),
  async (req, res) => {
    const targetCurrency = getTargetCurrency(req);
    const cacheKey = targetCurrency;

    const data = await resolveCacheWithInflight(netWorthResponseCache, cacheKey, {
      ttlMs: NET_WORTH_CACHE_TTL_MS,
      requireData: true,
      keepPreviousData: true,
      loader: () => infoRepository.getNetWorthFromSnapshots(targetCurrency),
    });

    const hasLimit = Object.prototype.hasOwnProperty.call(req.query, 'limit');
    const hasOffset = Object.prototype.hasOwnProperty.call(req.query, 'offset');

    if (!hasLimit && !hasOffset) {
      res.ok(data);
      return;
    }

    const limitRaw = parseInt(req.query.limit, 10);
    const offsetRaw = parseInt(req.query.offset, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 50;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const allSnapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
    // Page newest-first by indexing from the end — avoids copying and
    // reversing the entire snapshot array on every paginated request.
    const len = allSnapshots.length;
    const pageStart = Math.min(offset, len);
    const pageEnd = Math.min(offset + limit, len);
    const page = [];
    for (let i = pageStart; i < pageEnd; i++) {
      page.push(allSnapshots[len - 1 - i]);
    }

    res.ok(
      { ...data, snapshots: page, snapshotsTotal: allSnapshots.length },
      { pagination: { total: allSnapshots.length, limit, offset } },
    );
  },
);

export default router;
