/**
 * /api/info/net-worth:
 *   - Returns full snapshot array when no pagination params.
 *   - Returns a newest-first slice when limit/offset are supplied.
 *
 * Pagination facts travel in the response BODY (snapshotsTotal / snapshotsLimit
 * / snapshotsOffset), the one convention the API uses — this endpoint was the
 * last emitter of the parallel `meta.pagination` shape, which is now retired
 * (packages/types/src/api.ts). The body is a composite (current totals + the
 * snapshot series), not a bare collection, so the list fields are prefixed with
 * the list they describe rather than being the bare `total/limit/offset` a
 * `{items, total}` collection body uses.
 */

import { Router } from "express";
import infoService from "../../services/infoService.ts";
import { rateLimiter } from "../../middleware/rateLimiter.ts";
import { targetCurrencyQuerySchema } from "./_queryParams.ts";
import {
  netWorthResponseCache,
  NET_WORTH_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from "../../services/info/cache.ts";
import { resolveLivePortfolioValue } from "../../services/info/liveSummary.ts";
import { parseInput } from "../../lib/zodInput.ts";
import { optionalPaginationQuery } from "../_inputBridges.ts";

const router = Router();

const pageQuerySchema = optionalPaginationQuery({
  defaultLimit: 50,
  maxLimit: 5000,
});

router.get(
  "/net-worth",
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: "net-worth" }),
  async (req, res) => {
    const { targetCurrency } = parseInput(targetCurrencyQuerySchema, req.query);
    const page = parseInput(pageQuerySchema, req.query);
    const cacheKey = targetCurrency;

    const data = await resolveCacheWithInflight(
      netWorthResponseCache,
      cacheKey,
      {
        ttlMs: NET_WORTH_CACHE_TTL_MS,
        requireData: true,
        keepPreviousData: true,
        loader: async () => {
          const liveInvestments =
            await resolveLivePortfolioValue(targetCurrency);
          return infoService.getNetWorthFromSnapshots(targetCurrency, {
            liveInvestments,
          });
        },
      },
    );

    if (!page) {
      res.ok(data);
      return;
    }

    const { limit, offset } = page;

    const allSnapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
    // Page newest-first by indexing from the end — avoids copying and
    // reversing the entire snapshot array on every paginated request.
    const len = allSnapshots.length;
    const pageStart = Math.min(offset, len);
    const pageEnd = Math.min(offset + limit, len);
    const pageSnapshots = [];
    for (let i = pageStart; i < pageEnd; i++) {
      pageSnapshots.push(allSnapshots[len - 1 - i]);
    }

    res.ok({
      ...data,
      snapshots: pageSnapshots,
      snapshotsTotal: allSnapshots.length,
      snapshotsLimit: limit,
      snapshotsOffset: offset,
    });
  },
);

export default router;
