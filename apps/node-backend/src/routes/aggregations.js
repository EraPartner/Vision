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

import { Router } from 'express';
import { computeMonthlySummary } from '../services/calculations/aggregation/monthly.js';
import { computeCategoryBreakdown } from '../services/calculations/aggregation/category.js';
import { computeRecipientInsights } from '../services/calculations/aggregation/recipient.js';
import { computeCashflowComparison } from '../services/calculations/aggregation/cashflow.js';
import { computeAverageVsCurrent } from '../services/calculations/aggregation/averageVsCurrent.js';
import { computeBankBalances } from '../services/calculations/aggregation/bankBalances.js';
import { computeCashflowForecast } from '../services/calculations/aggregation/cashflowForecast.js';
import {
  computeCashflowForecast as computeCashflowForecastMethods,
  computeCashflowForecastRolling,
} from '../services/calculations/forecast/index.js';
import { getAllAccuracyHistory } from '../services/calculations/forecast/accuracyStore.js';
import { computeSankeyFlow } from '../services/calculations/aggregation/sankey.js';
import { computeCategoryPivot } from '../services/calculations/aggregation/categoryPivot.js';
import { computeRecipientByYear } from '../services/calculations/aggregation/recipientByYear.js';
import { computeRecipientPivot } from '../services/calculations/aggregation/recipientPivot.js';
import { computeTagPivot } from '../services/calculations/aggregation/tagPivot.js';
import { getTargetCurrency, parseBoolQueryParam } from './info/_queryParams.js';
import { parseIntClamped } from '../lib/pagination.js';
import { ValidationError } from '../middleware/errorHandler.js';

const router = Router();

function parseNumericArrayQueryParam(raw) {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
}

router.get('/monthly-summary', async (req, res) => {
  const allTime = req.query.all_time === 'true' || req.query.all_time === '1';
  const { data, meta } = await computeMonthlySummary({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
    allTime,
  });
  res.ok({ data, meta });
});

router.get('/category-breakdown', async (req, res) => {
  const { data, meta } = await computeCategoryBreakdown({
    targetCurrency: getTargetCurrency(req),
  });
  res.ok({ data, meta });
});

router.get('/recipient-insights', async (req, res) => {
  const { data, meta } = await computeRecipientInsights({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
  });
  res.ok({ data, meta });
});

router.get('/cashflow-comparison', async (req, res) => {
  const { data, meta } = await computeCashflowComparison({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
  });
  res.ok({ data, meta });
});

router.get('/average-vs-current', async (req, res) => {
  const { data, meta } = await computeAverageVsCurrent({
    targetCurrency: getTargetCurrency(req),
  });
  res.ok({ data, meta });
});

router.get('/bank-balances', async (req, res) => {
  const { data, meta } = await computeBankBalances({
    targetCurrency: getTargetCurrency(req),
  });
  res.ok({ data, meta });
});

router.get('/cashflow-forecast', async (req, res) => {
  const months = parseIntClamped(req.query.months, { max: 24, fallback: 3 });
  const { data, meta } = await computeCashflowForecast({ months });
  res.ok({ data, meta: { ...meta, months } });
});

router.get('/cashflow-forecast-methods', async (req, res) => {
  const mcPaths = parseIntClamped(req.query.mc_paths, { max: 5000, fallback: 1000 });
  const historyMonths = parseIntClamped(req.query.history_months, { max: 120, fallback: 36 });
  const percentiles = parseNumericArrayQueryParam(req.query.mc_percentiles);
  const mcPercentiles = percentiles.length > 0 ? percentiles : [10, 50, 90];
  const includePlanned = parseBoolQueryParam(req.query.include_planned, false);
  // Methods forecast defaults include_backtest ON: the backtest diagnostics are
  // core to comparing methods (computeCashflowForecast defaults it true, and the
  // cache-freshness check requires diagnostics). The sibling -rolling endpoint
  // defaults it OFF (see below) — the differing default is intentional; only the
  // parser is now shared so the accepted spellings can't drift per endpoint.
  const includeBacktest = parseBoolQueryParam(req.query.include_backtest, true);
  const includeBreakdown = parseBoolQueryParam(req.query.include_breakdown, false);

  const { data, meta } = await computeCashflowForecastMethods({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
    includePlanned,
    historyMonths,
    mcPaths,
    mcPercentiles,
    includeBacktest,
    includeBreakdown,
  });
  res.ok({ data, meta });
});

router.get('/cashflow-forecast-rolling', async (req, res) => {
  const daysBack = parseIntClamped(req.query.days_back, { max: 365, fallback: 90 });
  const daysForward = parseIntClamped(req.query.days_forward, { max: 365, fallback: 90 });
  if (daysBack + daysForward > 730) {
    throw new ValidationError('days_back + days_forward must be <= 730');
  }
  const mcPaths = parseIntClamped(req.query.mc_paths, { max: 5000, fallback: 1000 });
  const historyMonths = parseIntClamped(req.query.history_months, { max: 120, fallback: 36 });
  const percentiles = parseNumericArrayQueryParam(req.query.mc_percentiles);
  const mcPercentiles = percentiles.length > 0 ? percentiles : [10, 50, 90];
  const includePlanned = parseBoolQueryParam(req.query.include_planned, false);
  // Rolling forecast defaults include_backtest OFF: with default MC params and no
  // backtest, computeCashflowForecastRolling takes a fast cached path. Kept OFF by
  // default on purpose (see the methods endpoint above for the shared-parser note).
  const includeBacktest = parseBoolQueryParam(req.query.include_backtest, false);

  const { data, meta } = await computeCashflowForecastRolling({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
    includePlanned,
    historyMonths,
    daysBack,
    daysForward,
    mcPaths,
    mcPercentiles,
    includeBacktest,
  });
  res.ok({ data, meta });
});

router.get('/cashflow-forecast-accuracy', async (req, res) => {
  const userId = req.get('x-actor') || 'anonymous';
  const limitMonths = parseIntClamped(req.query.limit_months, { max: 48, fallback: 24 });

  const rows = await getAllAccuracyHistory({ userId, limitMonths });

  const byMethod = new Map();
  for (const row of rows) {
    if (!byMethod.has(row.method_id)) byMethod.set(row.method_id, []);
    byMethod.get(row.method_id).push(row);
  }

  const methods = Array.from(byMethod.entries()).map(([methodId, history]) => {
    const sorted = [...history].sort((a, b) => b.as_of_month.localeCompare(a.as_of_month));
    const latest = sorted[0];
    return {
      method_id: methodId,
      as_of_month: latest.as_of_month,
      mae: latest.mae,
      rmse: latest.rmse,
      mape: latest.mape,
      sample_days: latest.sample_days,
      history: sorted.map(({ as_of_month, mae, rmse, mape, sample_days }) => ({
        month: as_of_month, mae, rmse, mape, sample_days,
      })),
    };
  });

  res.ok({ data: { methods, limit_months: limitMonths }, meta: { source: 'db', userId } });
});

router.get('/sankey', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const rawYear = parseInt(req.query.year, 10);
  const year = Number.isFinite(rawYear) && rawYear > 2000 ? rawYear : undefined;
  const { data, meta } = await computeSankeyFlow({
    targetCurrency,
    year,
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
  });
  res.ok({ data, meta });
});

router.get('/category-pivot', async (req, res) => {
  const { data, meta } = await computeCategoryPivot({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
  });
  res.ok({ data, meta });
});

router.get('/recipient-by-year', async (req, res) => {
  const { data, meta } = await computeRecipientByYear({
    targetCurrency: getTargetCurrency(req),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
  });
  res.ok({ data, meta });
});

router.get('/recipient-pivot', async (req, res) => {
  const bucket = ['monthly', 'yearly'].includes(req.query.bucket) ? req.query.bucket : 'monthly';
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  const recipientIds = parseNumericArrayQueryParam(req.query.recipient_ids);
  const { data, meta } = await computeRecipientPivot({
    targetCurrency: getTargetCurrency(req),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
    bucket,
    startDate,
    endDate,
    recipientIds: recipientIds.length > 0 ? recipientIds : null,
  });
  res.ok({ data, meta });
});

router.get('/tag-pivot', async (req, res) => {
  const bucket = ['monthly', 'yearly'].includes(req.query.bucket) ? req.query.bucket : 'monthly';
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  const tagIds = parseNumericArrayQueryParam(req.query.tag_ids);
  const allTags = req.query.all === 'true' || req.query.all_tags === 'true';
  const { data, meta } = await computeTagPivot({
    targetCurrency: getTargetCurrency(req),
    bucket,
    startDate,
    endDate,
    tagIds: tagIds.length > 0 ? tagIds : null,
    allTags,
  });
  res.ok({ data, meta });
});

export default router;
