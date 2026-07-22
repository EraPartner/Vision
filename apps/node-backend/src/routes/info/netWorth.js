/**
 * /api/info/net-worth:
 *   - Returns full snapshot array when no pagination params.
 *   - Returns newest-first slice + pagination meta when limit/offset supplied.
 */

import { Router } from 'express';
import infoRepository from '../../services/infoService.js';
import { rateLimiter } from '../../middleware/rateLimiter.js';
import { getTargetCurrency } from './_queryParams.js';
import {
  netWorthResponseCache,
  NET_WORTH_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from '../../services/info/cache.js';
import { resolveLivePortfolioValue } from '../../services/info/liveSummary.js';
import { parsePagination } from '../../lib/pagination.js';

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
      loader: async () => {
        const liveInvestments = await resolveLivePortfolioValue(targetCurrency);
        return infoRepository.getNetWorthFromSnapshots(targetCurrency, { liveInvestments });
      },
    });

    const hasLimit = Object.prototype.hasOwnProperty.call(req.query, 'limit');
    const hasOffset = Object.prototype.hasOwnProperty.call(req.query, 'offset');

    if (!hasLimit && !hasOffset) {
      res.ok(data);
      return;
    }

    const { limit, offset } = parsePagination(req.query, { maxLimit: 5000 });

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

// Net worth as Σ accounts (ADR-100): per-account current cash + holdings and the
// rebuilt daily holdings history. Only the HOLDINGS side is "Σ == aggregate by
// construction" (the snapshot builder's per-account split). The cash side is
// per-account computed balances — since WP-A1 the same anchor+delta definition
// the /net-worth headline uses, but converted at current rates per account, so
// Σ cash can differ from the headline's Liquid by FX-conversion granularity
// (not by population or balance definition).
router.get(
  '/net-worth/by-account',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'net-worth-by-account' }),
  async (req, res) => {
    const targetCurrency = getTargetCurrency(req);
    const data = await resolveCacheWithInflight(netWorthResponseCache, `by-account:${targetCurrency}`, {
      ttlMs: NET_WORTH_CACHE_TTL_MS,
      requireData: true,
      keepPreviousData: true,
      loader: () => infoRepository.getNetWorthByAccount(targetCurrency),
    });
    res.ok(data);
  },
);

export default router;
