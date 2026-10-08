/**
 * Aggregation routes (Phase 2).
 *
 * Single source of truth for Dashboard + Statistics widgets. Each endpoint
 * delegates to a pure calc module in services/calculations/aggregation/.
 * Calc modules return `{ data, meta: { computedAt, source } }`. The route layer
 * nests that full aggregation envelope inside the unified transport envelope
 * via `res.ok({ data, meta })` so the frontend (typed as AggregationEnvelope<T>)
 * can read both `envelope.data.<payload>` and `envelope.meta.source` after
 * unwrapEnvelope strips the outer `{ok, data}` layer.
 * See docs/adr/026-unified-api-response-envelope.md.
 *
 * These are the canonical aggregation routes (ADR-010 Phase 9 cutover complete).
 * The legacy GET /api/info and GET /api/info/transaction-summary they replaced
 * have been removed. There is no AGGREGATIONS_V2_ENABLED runtime flag — the
 * cutover is permanent (the flag was only ever a planning concept).
 */

import { Router } from "express";
import { z } from "zod";
import { computeMonthlySummary } from "../services/calculations/aggregation/monthly.ts";
import { computeCategoryBreakdown } from "../services/calculations/aggregation/category.ts";
import { computeRecipientInsights } from "../services/calculations/aggregation/recipient.ts";
import { computeCashflowComparison } from "../services/calculations/aggregation/cashflow.ts";
import { computeAverageVsCurrent } from "../services/calculations/aggregation/averageVsCurrent.ts";
import { computeBankBalances } from "../services/calculations/aggregation/bankBalances.ts";
import { computeCashflowForecast } from "../services/calculations/aggregation/cashflowForecast.ts";
import {
  computeCashflowForecast as computeCashflowForecastMethods,
  computeCashflowForecastRolling,
} from "../services/calculations/forecast/index.ts";
import { getAllAccuracyHistory } from "../services/calculations/forecast/accuracyStore.ts";
import { computeSankeyFlow } from "../services/calculations/aggregation/sankey.ts";
import { computeCategoryPivot } from "../services/calculations/aggregation/categoryPivot.ts";
import { computeRecipientByYear } from "../services/calculations/aggregation/recipientByYear.ts";
import { computeRecipientPivot } from "../services/calculations/aggregation/recipientPivot.ts";
import { computeTagPivot } from "../services/calculations/aggregation/tagPivot.ts";
import { getTargetCurrency } from "./info/_queryParams.ts";
import { parseInput } from "../lib/zodInput.ts";
import { validateIntArray } from "../lib/validation.ts";
import { parseAggregationDateRange } from "../lib/aggregationDateRange.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import {
  booleanQuery,
  clampedIntQuery,
  idSchema,
  optionalValue,
  singleQueryString,
} from "./_requestSchemas.ts";

const router = Router();

// ── Query schemas ────────────────────────────────────────────────────────────
//
// Each endpoint parses its whole `req.query` once. The id-list, date-range and
// retired-alias checks run in the object-level transform so they report root
// issues: their messages predate ADR-193 and are pinned verbatim.

/** Unknown or non-string values fall back to "monthly". */
const pivotBucketQuery = optionalValue.transform((raw): "monthly" | "yearly" =>
  raw === "yearly" ? "yearly" : "monthly",
);

/**
 * Repeatable *numeric* query param. Only `mc_percentiles` uses it: those are
 * distribution percentiles (0..100), not record ids, so they deliberately do
 * NOT go through the id parser below — a fractional percentile is legitimate,
 * and a bad one costs a band on a chart rather than a wrong row set. An empty
 * result falls back to the default bands.
 */
const percentilesQuery = optionalValue.transform((raw) => {
  const values = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  const percentiles = values
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  return percentiles.length > 0 ? percentiles : [10, 50, 90];
});

/**
 * Repeatable *id* query param (`excluded_category_ids`, `excluded_recipient_ids`,
 * `recipient_ids`, `tag_ids`) — one element per occurrence, as the frontend's
 * `qp.append(...)` builders emit.
 *
 * Delegates to `validateIntArray`, so the accepted element shapes are exactly
 * the body arrays' and the `:id` params': a plain base-10 digit string or an
 * integer number, 1..2^31-1. A bad element rejects the whole request.
 *
 * That last part is the point. This used to be `.map(Number).filter(isFinite)`,
 * which *dropped* the bad element instead of rejecting it: `?excluded_category_ids=12abc`
 * silently switched the exclusion off entirely and answered with a different
 * dataset than the caller asked for, while `0x10` decoded to 16 and `1e3` to
 * 1000 — excluding a category nobody named. Nothing surfaced either way, which
 * is strictly worse than the 400 the body path already returns.
 *
 * Absent or empty (`?excluded_category_ids=`) still means "no exclusions" and
 * stays a 200 — the same unset convention `assertOptionalId` uses, and what
 * every current caller sends when its list is empty (the builders skip the
 * param entirely). An empty list and a list with a bad element are different
 * cases and are answered differently.
 */
function idList(raw: unknown, field: string, ctx: z.RefinementCtx): number[] {
  if (raw == null || raw === "") return [];
  const result = validateIntArray(raw, field);
  if (!result.valid) {
    ctx.addIssue({ code: "custom", message: result.error });
    return [];
  }
  return result.value;
}

const currencyFields = {
  currency: optionalValue,
  target_currency: optionalValue,
};

const exclusionFields = {
  excluded_category_ids: optionalValue,
  excluded_recipient_ids: optionalValue,
};

const dateRangeFields = {
  start: optionalValue,
  end: optionalValue,
  start_date: optionalValue,
  end_date: optionalValue,
};

function targetCurrency(query: {
  currency?: unknown;
  target_currency?: unknown;
}) {
  return getTargetCurrency({ query });
}

function exclusions(
  query: { excluded_category_ids?: unknown; excluded_recipient_ids?: unknown },
  ctx: z.RefinementCtx,
) {
  return {
    excludedCategoryIds: idList(
      query.excluded_category_ids,
      "excluded_category_ids",
      ctx,
    ),
    excludedRecipientIds: idList(
      query.excluded_recipient_ids,
      "excluded_recipient_ids",
      ctx,
    ),
  };
}

/** The canonical `start_date`/`end_date` pair (lib/aggregationDateRange.ts). */
function dateRange(
  query: Record<string, unknown>,
  ctx: z.RefinementCtx,
): { startDate: string | undefined; endDate: string | undefined } {
  try {
    return parseAggregationDateRange(query);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    ctx.addIssue({ code: "custom", message: error.message });
    return { startDate: undefined, endDate: undefined };
  }
}

const monthlySummaryQuery = z
  .object({
    ...currencyFields,
    ...exclusionFields,
    ...dateRangeFields,
    all_time: booleanQuery(false),
  })
  .transform((query, ctx) => {
    const { startDate, endDate } = dateRange(query, ctx);
    return {
      targetCurrency: targetCurrency(query),
      ...exclusions(query, ctx),
      allTime: query.all_time,
      startDate: query.all_time ? undefined : startDate,
      endDate: query.all_time ? undefined : endDate,
    };
  });

const categoryBreakdownQuery = z
  .object({ ...currencyFields, ancestor_category_id: idSchema().optional() })
  .transform((query) => ({
    targetCurrency: targetCurrency(query),
    ancestorCategoryId: query.ancestor_category_id,
  }));

/** Currency + exclusions + date range (recipient insights, category pivot, recipient by year). */
const rangedExclusionsQuery = z
  .object({ ...currencyFields, ...exclusionFields, ...dateRangeFields })
  .transform((query, ctx) => ({
    targetCurrency: targetCurrency(query),
    ...exclusions(query, ctx),
    ...dateRange(query, ctx),
  }));

const cashflowComparisonQuery = z
  .object({ ...currencyFields, ...exclusionFields })
  .transform((query, ctx) => ({
    targetCurrency: targetCurrency(query),
    ...exclusions(query, ctx),
  }));

const currencyOnlyQuery = z
  .object(currencyFields)
  .transform((query) => ({ targetCurrency: targetCurrency(query) }));

const cashflowForecastQuery = z.object({
  months: clampedIntQuery({ max: 24, fallback: 3 }),
});

const monteCarloFields = {
  mc_paths: clampedIntQuery({ max: 5000, fallback: 1000 }),
  history_months: clampedIntQuery({ max: 120, fallback: 36 }),
  mc_percentiles: percentilesQuery,
  include_planned: booleanQuery(false),
};

const forecastMethodsQuery = z
  .object({
    ...currencyFields,
    ...exclusionFields,
    ...monteCarloFields,
    // Methods forecast defaults include_backtest ON: the backtest diagnostics
    // are core to comparing methods (computeCashflowForecast defaults it true,
    // and the cache-freshness check requires diagnostics). The sibling -rolling
    // endpoint defaults it OFF (see below) — the differing default is
    // intentional; only the parser is shared so the accepted spellings can't
    // drift per endpoint.
    include_backtest: booleanQuery(true),
    include_breakdown: booleanQuery(false),
  })
  .transform((query, ctx) => ({
    targetCurrency: targetCurrency(query),
    ...exclusions(query, ctx),
    includePlanned: query.include_planned,
    historyMonths: query.history_months,
    mcPaths: query.mc_paths,
    mcPercentiles: query.mc_percentiles,
    includeBacktest: query.include_backtest,
    includeBreakdown: query.include_breakdown,
  }));

const forecastRollingQuery = z
  .object({
    ...currencyFields,
    ...exclusionFields,
    ...monteCarloFields,
    days_back: clampedIntQuery({ max: 365, fallback: 90 }),
    days_forward: clampedIntQuery({ max: 365, fallback: 90 }),
    // Rolling forecast defaults include_backtest OFF: with default MC params and
    // no backtest, computeCashflowForecastRolling takes a fast cached path. Kept
    // OFF by default on purpose (see the methods endpoint above).
    include_backtest: booleanQuery(false),
  })
  .refine((query) => query.days_back + query.days_forward <= 730, {
    message: "days_back + days_forward must be <= 730",
  })
  .transform((query, ctx) => ({
    targetCurrency: targetCurrency(query),
    ...exclusions(query, ctx),
    includePlanned: query.include_planned,
    historyMonths: query.history_months,
    daysBack: query.days_back,
    daysForward: query.days_forward,
    mcPaths: query.mc_paths,
    mcPercentiles: query.mc_percentiles,
    includeBacktest: query.include_backtest,
  }));

const forecastAccuracyQuery = z.object({
  limit_months: clampedIntQuery({ max: 48, fallback: 24 }),
});

const sankeyQuery = z
  .object({
    ...currencyFields,
    ...exclusionFields,
    // Years up to 2000 and unparseable values mean "no year filter".
    year: singleQueryString.transform((raw) => {
      const year = parseInt(raw ?? "", 10);
      return Number.isFinite(year) && year > 2000 ? year : undefined;
    }),
  })
  .transform((query, ctx) => ({
    targetCurrency: targetCurrency(query),
    year: query.year,
    ...exclusions(query, ctx),
  }));

const recipientPivotQuery = z
  .object({
    ...currencyFields,
    ...dateRangeFields,
    excluded_recipient_ids: optionalValue,
    recipient_ids: optionalValue,
    bucket: pivotBucketQuery,
  })
  .transform((query, ctx) => {
    const recipientIds = idList(query.recipient_ids, "recipient_ids", ctx);
    return {
      targetCurrency: targetCurrency(query),
      excludedRecipientIds: idList(
        query.excluded_recipient_ids,
        "excluded_recipient_ids",
        ctx,
      ),
      bucket: query.bucket,
      ...dateRange(query, ctx),
      recipientIds: recipientIds.length > 0 ? recipientIds : undefined,
    };
  });

const tagPivotQuery = z
  .object({
    ...currencyFields,
    ...dateRangeFields,
    tag_ids: optionalValue,
    all_tags: optionalValue,
    all: booleanQuery(false),
    bucket: pivotBucketQuery,
  })
  .transform((query, ctx) => {
    if (query.all_tags !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          'Use "all"; the "all_tags" query parameter is no longer supported',
      });
    }
    const tagIds = idList(query.tag_ids, "tag_ids", ctx);
    return {
      targetCurrency: targetCurrency(query),
      bucket: query.bucket,
      ...dateRange(query, ctx),
      tagIds: tagIds.length > 0 ? tagIds : undefined,
      allTags: query.all,
    };
  });

// ── Routes ───────────────────────────────────────────────────────────────────

router.get("/monthly-summary", async (req, res) => {
  const options = parseInput(monthlySummaryQuery, req.query);
  const { data, meta } = await computeMonthlySummary(options);
  res.ok({ data, meta });
});

router.get("/category-breakdown", async (req, res) => {
  const options = parseInput(categoryBreakdownQuery, req.query);
  const { data, meta } = await computeCategoryBreakdown(options);
  res.ok({ data, meta });
});

router.get("/recipient-insights", async (req, res) => {
  const options = parseInput(rangedExclusionsQuery, req.query);
  const { data, meta } = await computeRecipientInsights(options);
  res.ok({ data, meta });
});

router.get("/cashflow-comparison", async (req, res) => {
  const options = parseInput(cashflowComparisonQuery, req.query);
  const { data, meta } = await computeCashflowComparison(options);
  res.ok({ data, meta });
});

router.get("/average-vs-current", async (req, res) => {
  const options = parseInput(currencyOnlyQuery, req.query);
  const { data, meta } = await computeAverageVsCurrent(options);
  res.ok({ data, meta });
});

router.get("/bank-balances", async (req, res) => {
  const options = parseInput(currencyOnlyQuery, req.query);
  const { data, meta } = await computeBankBalances(options);
  res.ok({ data, meta });
});

router.get("/cashflow-forecast", async (req, res) => {
  const { months } = parseInput(cashflowForecastQuery, req.query);
  const { data, meta } = await computeCashflowForecast({ months });
  res.ok({ data, meta: { ...meta, months } });
});

router.get("/cashflow-forecast-methods", async (req, res) => {
  const options = parseInput(forecastMethodsQuery, req.query);
  const { data, meta } = await computeCashflowForecastMethods(options);
  res.ok({ data, meta });
});

router.get("/cashflow-forecast-rolling", async (req, res) => {
  const options = parseInput(forecastRollingQuery, req.query);
  const { data, meta } = await computeCashflowForecastRolling(options);
  res.ok({ data, meta });
});

router.get("/cashflow-forecast-accuracy", async (req, res) => {
  const userId = req.get("x-actor") || "anonymous";
  const { limit_months: limitMonths } = parseInput(
    forecastAccuracyQuery,
    req.query,
  );

  const rows = await getAllAccuracyHistory({ userId, limitMonths });

  const byMethod = new Map();
  for (const row of rows) {
    if (!byMethod.has(row.methodId)) byMethod.set(row.methodId, []);
    byMethod.get(row.methodId).push(row);
  }

  const methods = Array.from(byMethod.entries()).map(([methodId, history]) => {
    const sorted = [...history].sort((a, b) =>
      b.asOfMonth.localeCompare(a.asOfMonth),
    );
    const latest = sorted[0];
    return {
      method_id: methodId,
      as_of_month: latest.asOfMonth,
      mae: latest.mae,
      rmse: latest.rmse,
      mape: latest.mape,
      sample_days: latest.sampleDays,
      history: sorted.map(({ asOfMonth, mae, rmse, mape, sampleDays }) => ({
        month: asOfMonth,
        mae,
        rmse,
        mape,
        sample_days: sampleDays,
      })),
    };
  });

  res.ok({
    data: { methods, limit_months: limitMonths },
    meta: { source: "db", userId },
  });
});

router.get("/sankey", async (req, res) => {
  const options = parseInput(sankeyQuery, req.query);
  const { data, meta } = await computeSankeyFlow(options);
  res.ok({ data, meta });
});

router.get("/category-pivot", async (req, res) => {
  const options = parseInput(rangedExclusionsQuery, req.query);
  const { data, meta } = await computeCategoryPivot(options);
  res.ok({ data, meta });
});

router.get("/recipient-by-year", async (req, res) => {
  const options = parseInput(rangedExclusionsQuery, req.query);
  const { data, meta } = await computeRecipientByYear(options);
  res.ok({ data, meta });
});

router.get("/recipient-pivot", async (req, res) => {
  const options = parseInput(recipientPivotQuery, req.query);
  const { data, meta } = await computeRecipientPivot(options);
  res.ok({ data, meta });
});

router.get("/tag-pivot", async (req, res) => {
  const options = parseInput(tagPivotQuery, req.query);
  const { data, meta } = await computeTagPivot(options);
  res.ok({ data, meta });
});

export default router;
