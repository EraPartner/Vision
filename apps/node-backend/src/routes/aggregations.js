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
import { computeMonthlySummary } from "../services/calculations/aggregation/monthly.js";
import { computeCategoryBreakdown } from "../services/calculations/aggregation/category.js";
import { computeRecipientInsights } from "../services/calculations/aggregation/recipient.js";
import { computeCashflowComparison } from "../services/calculations/aggregation/cashflow.js";
import { computeAverageVsCurrent } from "../services/calculations/aggregation/averageVsCurrent.js";
import { computeBankBalances } from "../services/calculations/aggregation/bankBalances.js";
import { computeCashflowForecast } from "../services/calculations/aggregation/cashflowForecast.js";
import {
  computeCashflowForecast as computeCashflowForecastMethods,
  computeCashflowForecastRolling,
} from "../services/calculations/forecast/index.js";
import { getAllAccuracyHistory } from "../services/calculations/forecast/accuracyStore.js";
import { computeSankeyFlow } from "../services/calculations/aggregation/sankey.js";
import { computeCategoryPivot } from "../services/calculations/aggregation/categoryPivot.js";
import { computeRecipientByYear } from "../services/calculations/aggregation/recipientByYear.js";
import { computeRecipientPivot } from "../services/calculations/aggregation/recipientPivot.js";
import { computeTagPivot } from "../services/calculations/aggregation/tagPivot.js";
import { getTargetCurrency } from "./info/_queryParams.js";
import { parseBooleanQueryParam } from "../lib/httpParams.js";
import { parseIntClamped } from "../lib/pagination.js";
import { assertYmd } from "../lib/validation.js";
import { ValidationError } from "../middleware/errorHandler.js";
import { validateIntArray } from "../middleware/validation.js";

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

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
 * @param {any} raw
 * @param {string} field
 * @returns {number[]}
 */
function parseIdArrayQueryParam(raw, field) {
  if (raw == null || raw === "") return [];
  const result = validateIntArray(raw, field);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

/**
 * Repeatable *numeric* query param. Only `mc_percentiles` uses it: those are
 * distribution percentiles (0..100), not record ids, so they deliberately do
 * NOT go through the id parser above — a fractional percentile is legitimate,
 * and a bad one costs a band on a chart rather than a wrong row set.
 * @param {any} raw
 * @returns {number[]}
 */
function parseNumericArrayQueryParam(raw) {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
}

/**
 * Normalize the pivots' legacy `start`/`end` aliases onto the API-wide
 * `start_date`/`end_date` contract. The canonical spelling wins when callers
 * send both, including when its value is empty (which means no bound).
 * @param {ExpressRequest['query']} query
 */
function parsePivotDateRange(query) {
  const start = query.start_date !== undefined ? query.start_date : query.start;
  const end = query.end_date !== undefined ? query.end_date : query.end;
  return {
    startDate: assertYmd(start, "start_date"),
    endDate: assertYmd(end, "end_date"),
  };
}

router.get(
  "/monthly-summary",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const allTime = parseBooleanQueryParam(req.query.all_time);
    const { data, meta } = await computeMonthlySummary({
      targetCurrency: getTargetCurrency(req),
      excludedCategoryIds: parseIdArrayQueryParam(
        req.query.excluded_category_ids,
        "excluded_category_ids",
      ),
      excludedRecipientIds: parseIdArrayQueryParam(
        req.query.excluded_recipient_ids,
        "excluded_recipient_ids",
      ),
      allTime,
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/category-breakdown",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { data, meta } = await computeCategoryBreakdown({
      targetCurrency: getTargetCurrency(req),
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/recipient-insights",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { data, meta } = await computeRecipientInsights({
      targetCurrency: getTargetCurrency(req),
      excludedCategoryIds: parseIdArrayQueryParam(
        req.query.excluded_category_ids,
        "excluded_category_ids",
      ),
      excludedRecipientIds: parseIdArrayQueryParam(
        req.query.excluded_recipient_ids,
        "excluded_recipient_ids",
      ),
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/cashflow-comparison",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { data, meta } = await computeCashflowComparison({
      targetCurrency: getTargetCurrency(req),
      excludedCategoryIds: parseIdArrayQueryParam(
        req.query.excluded_category_ids,
        "excluded_category_ids",
      ),
      excludedRecipientIds: parseIdArrayQueryParam(
        req.query.excluded_recipient_ids,
        "excluded_recipient_ids",
      ),
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/average-vs-current",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { data, meta } = await computeAverageVsCurrent({
      targetCurrency: getTargetCurrency(req),
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/bank-balances",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { data, meta } = await computeBankBalances({
      targetCurrency: getTargetCurrency(req),
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/cashflow-forecast",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const months = parseIntClamped(req.query.months, { max: 24, fallback: 3 });
    const { data, meta } = await computeCashflowForecast({ months });
    res.ok({ data, meta: { ...meta, months } });
  },
);

router.get(
  "/cashflow-forecast-methods",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const mcPaths = parseIntClamped(req.query.mc_paths, {
      max: 5000,
      fallback: 1000,
    });
    const historyMonths = parseIntClamped(req.query.history_months, {
      max: 120,
      fallback: 36,
    });
    const percentiles = parseNumericArrayQueryParam(req.query.mc_percentiles);
    const mcPercentiles = percentiles.length > 0 ? percentiles : [10, 50, 90];
    const includePlanned = parseBooleanQueryParam(
      req.query.include_planned,
      false,
    );
    // Methods forecast defaults include_backtest ON: the backtest diagnostics are
    // core to comparing methods (computeCashflowForecast defaults it true, and the
    // cache-freshness check requires diagnostics). The sibling -rolling endpoint
    // defaults it OFF (see below) — the differing default is intentional; only the
    // parser is now shared so the accepted spellings can't drift per endpoint.
    const includeBacktest = parseBooleanQueryParam(
      req.query.include_backtest,
      true,
    );
    const includeBreakdown = parseBooleanQueryParam(
      req.query.include_breakdown,
      false,
    );

    const { data, meta } = await computeCashflowForecastMethods({
      targetCurrency: getTargetCurrency(req),
      excludedCategoryIds: parseIdArrayQueryParam(
        req.query.excluded_category_ids,
        "excluded_category_ids",
      ),
      excludedRecipientIds: parseIdArrayQueryParam(
        req.query.excluded_recipient_ids,
        "excluded_recipient_ids",
      ),
      includePlanned,
      historyMonths,
      mcPaths,
      mcPercentiles,
      includeBacktest,
      includeBreakdown,
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/cashflow-forecast-rolling",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const daysBack = parseIntClamped(req.query.days_back, {
      max: 365,
      fallback: 90,
    });
    const daysForward = parseIntClamped(req.query.days_forward, {
      max: 365,
      fallback: 90,
    });
    if (daysBack + daysForward > 730) {
      throw new ValidationError("days_back + days_forward must be <= 730");
    }
    const mcPaths = parseIntClamped(req.query.mc_paths, {
      max: 5000,
      fallback: 1000,
    });
    const historyMonths = parseIntClamped(req.query.history_months, {
      max: 120,
      fallback: 36,
    });
    const percentiles = parseNumericArrayQueryParam(req.query.mc_percentiles);
    const mcPercentiles = percentiles.length > 0 ? percentiles : [10, 50, 90];
    const includePlanned = parseBooleanQueryParam(
      req.query.include_planned,
      false,
    );
    // Rolling forecast defaults include_backtest OFF: with default MC params and no
    // backtest, computeCashflowForecastRolling takes a fast cached path. Kept OFF by
    // default on purpose (see the methods endpoint above for the shared-parser note).
    const includeBacktest = parseBooleanQueryParam(
      req.query.include_backtest,
      false,
    );

    const { data, meta } = await computeCashflowForecastRolling({
      targetCurrency: getTargetCurrency(req),
      excludedCategoryIds: parseIdArrayQueryParam(
        req.query.excluded_category_ids,
        "excluded_category_ids",
      ),
      excludedRecipientIds: parseIdArrayQueryParam(
        req.query.excluded_recipient_ids,
        "excluded_recipient_ids",
      ),
      includePlanned,
      historyMonths,
      daysBack,
      daysForward,
      mcPaths,
      mcPercentiles,
      includeBacktest,
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/cashflow-forecast-accuracy",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const userId = req.get("x-actor") || "anonymous";
    const limitMonths = parseIntClamped(req.query.limit_months, {
      max: 48,
      fallback: 24,
    });

    const rows = await getAllAccuracyHistory({ userId, limitMonths });

    const byMethod = new Map();
    for (const row of rows) {
      if (!byMethod.has(row.methodId)) byMethod.set(row.methodId, []);
      byMethod.get(row.methodId).push(row);
    }

    const methods = Array.from(byMethod.entries()).map(
      ([methodId, history]) => {
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
      },
    );

    res.ok({
      data: { methods, limit_months: limitMonths },
      meta: { source: "db", userId },
    });
  },
);

router.get(
  "/sankey",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const targetCurrency = getTargetCurrency(req);
    const rawYear = parseInt(req.query.year, 10);
    const year =
      Number.isFinite(rawYear) && rawYear > 2000 ? rawYear : undefined;
    const { data, meta } = await computeSankeyFlow({
      targetCurrency,
      year,
      excludedCategoryIds: parseIdArrayQueryParam(
        req.query.excluded_category_ids,
        "excluded_category_ids",
      ),
      excludedRecipientIds: parseIdArrayQueryParam(
        req.query.excluded_recipient_ids,
        "excluded_recipient_ids",
      ),
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/category-pivot",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { data, meta } = await computeCategoryPivot({
      targetCurrency: getTargetCurrency(req),
      excludedCategoryIds: parseIdArrayQueryParam(
        req.query.excluded_category_ids,
        "excluded_category_ids",
      ),
      excludedRecipientIds: parseIdArrayQueryParam(
        req.query.excluded_recipient_ids,
        "excluded_recipient_ids",
      ),
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/recipient-by-year",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { data, meta } = await computeRecipientByYear({
      targetCurrency: getTargetCurrency(req),
      excludedRecipientIds: parseIdArrayQueryParam(
        req.query.excluded_recipient_ids,
        "excluded_recipient_ids",
      ),
      excludedCategoryIds: parseIdArrayQueryParam(
        req.query.excluded_category_ids,
        "excluded_category_ids",
      ),
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/recipient-pivot",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const bucket = ["monthly", "yearly"].includes(req.query.bucket)
      ? req.query.bucket
      : "monthly";
    const { startDate, endDate } = parsePivotDateRange(req.query);
    const recipientIds = parseIdArrayQueryParam(
      req.query.recipient_ids,
      "recipient_ids",
    );
    const { data, meta } = await computeRecipientPivot({
      targetCurrency: getTargetCurrency(req),
      excludedRecipientIds: parseIdArrayQueryParam(
        req.query.excluded_recipient_ids,
        "excluded_recipient_ids",
      ),
      bucket,
      startDate,
      endDate,
      recipientIds: recipientIds.length > 0 ? recipientIds : null,
    });
    res.ok({ data, meta });
  },
);

router.get(
  "/tag-pivot",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const bucket = ["monthly", "yearly"].includes(req.query.bucket)
      ? req.query.bucket
      : "monthly";
    const { startDate, endDate } = parsePivotDateRange(req.query);
    const tagIds = parseIdArrayQueryParam(req.query.tag_ids, "tag_ids");
    const allTags =
      parseBooleanQueryParam(req.query.all) ||
      parseBooleanQueryParam(req.query.all_tags);
    const { data, meta } = await computeTagPivot({
      targetCurrency: getTargetCurrency(req),
      bucket,
      startDate,
      endDate,
      tagIds: tagIds.length > 0 ? tagIds : null,
      allTags,
    });
    res.ok({ data, meta });
  },
);

export default router;
