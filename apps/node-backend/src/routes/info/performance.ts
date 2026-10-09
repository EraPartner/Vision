/**
 * /api/info/portfolio-performance:
 *   - Pre-computed portfolio performance snapshots with period filtering at full daily resolution.
 */

import { Router } from "express";
import { z } from "zod";
import {
  getSnapshots,
  getBrokerSnapshots,
} from "../../services/portfolioPerformanceSnapshotService.ts";
import { rateLimiter } from "../../middleware/rateLimiter.ts";
import {
  getCurrentDateString,
  targetCurrencyQuerySchema,
} from "./_queryParams.ts";
import {
  perfResponseCache,
  PERF_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from "../../services/info/cache.ts";
import {
  buildPortfolioPerformancePayload,
  PERFORMANCE_PERIODS,
} from "../../services/info/performanceHelpers.ts";
import { bareMessages, parseInput } from "../../lib/zodInput.ts";
import { singleQueryValue } from "../_inputBridges.ts";

// The fields of a getBrokerSnapshots row this route reads; the JS service's
// inferred return type (`[] | row[]`) is too loose to map over strictly.
interface BrokerSnapshotRow {
  date: string;
  accountKey: string;
  accountId: number | null;
  accountName: string | null;
  assignment: string;
}

const router = Router();

// from/to land in SQL date parameters: absent or empty uses the default
// window; anything else must be a real calendar date (a malformed value used
// to be swapped for the default silently, and `2026-02-31` reached Postgres).
const optionalDateQuery = (name: string) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.iso.date({ error: `${name} must be a YYYY-MM-DD date` }).optional(),
  );

const brokerDateQuerySchema = bareMessages(
  z.object({
    from: optionalDateQuery("from"),
    to: optionalDateQuery("to"),
  }),
);

// An empty period means "all". Other values must be known: each one is its
// own cache entry, so arbitrary strings would grow the cache without bound.
const performanceQuerySchema = bareMessages(
  z.object({
    period: singleQueryValue("period").refine(
      (period) => !period || PERFORMANCE_PERIODS.includes(period),
      `period must be one of ${PERFORMANCE_PERIODS.join(", ")}`,
    ),
  }),
);

router.get(
  "/portfolio-performance/by-broker",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "portfolio-broker-performance",
  }),
  async (req, res) => {
    const { targetCurrency } = parseInput(targetCurrencyQuerySchema, req.query);
    const query = parseInput(brokerDateQuerySchema, req.query);
    const startDate = query.from ?? "2000-01-01";
    const endDate = query.to ?? getCurrentDateString();
    const rows: BrokerSnapshotRow[] = await getBrokerSnapshots(
      startDate,
      endDate,
      targetCurrency,
    );
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
  async (req, res) => {
    const { targetCurrency } = parseInput(targetCurrencyQuerySchema, req.query);
    const period =
      parseInput(performanceQuerySchema, req.query).period || "all";
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
