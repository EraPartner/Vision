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
 * Mounted in parallel with legacy /api/info/* behind the AGGREGATIONS_V2_ENABLED
 * feature flag during Phase 2–8; legacy routes are removed in Phase 9 after
 * shadow-mode parity is proven.
 */

import { Router } from 'express';
import { computeMonthlySummary } from '../services/calculations/aggregation/monthly.js';
import { computeCategoryBreakdown } from '../services/calculations/aggregation/category.js';
import { computeRecipientInsights } from '../services/calculations/aggregation/recipient.js';
import { computeCashflowComparison } from '../services/calculations/aggregation/cashflow.js';
import { computeAverageVsCurrent } from '../services/calculations/aggregation/averageVsCurrent.js';
import { computeBankBalances } from '../services/calculations/aggregation/bankBalances.js';
import { computeCashflowForecast } from '../services/calculations/aggregation/cashflowForecast.js';
import { computeCashflowForecast as computeCashflowForecastMethods } from '../services/calculations/forecast/index.js';
import { getAllAccuracyHistory } from '../services/calculations/forecast/accuracyStore.js';
import { computeSankeyFlow } from '../services/calculations/aggregation/sankey.js';
import { computeCategoryPivot } from '../services/calculations/aggregation/categoryPivot.js';
import { computeRecipientByYear } from '../services/calculations/aggregation/recipientByYear.js';

const router = Router();

function getTargetCurrency(req) {
  const raw = req.query.currency ?? req.query.target_currency;
  if (raw == null || raw === '') return 'EUR';
  const value = String(raw).toUpperCase().trim();
  return /^[A-Z]{3}$/.test(value) ? value : 'EUR';
}

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
  const rawMonths = parseInt(req.query.months, 10);
  const months = Number.isFinite(rawMonths) && rawMonths > 0 ? Math.min(rawMonths, 24) : 3;
  const { data, meta } = await computeCashflowForecast({ months });
  res.ok({ data, meta: { ...meta, months } });
});

router.get('/cashflow-forecast-methods', async (req, res) => {
  const rawMcPaths = parseInt(req.query.mc_paths, 10);
  const mcPaths = Number.isFinite(rawMcPaths) && rawMcPaths > 0 ? Math.min(rawMcPaths, 5000) : 1000;
  const rawHistory = parseInt(req.query.history_months, 10);
  const historyMonths =
    Number.isFinite(rawHistory) && rawHistory > 0 ? Math.min(rawHistory, 120) : 36;
  const percentiles = parseNumericArrayQueryParam(req.query.mc_percentiles);
  const mcPercentiles = percentiles.length > 0 ? percentiles : [10, 50, 90];
  const includePlanned =
    req.query.include_planned === 'true' || req.query.include_planned === '1';
  const includeBacktest = req.query.include_backtest !== 'false' && req.query.include_backtest !== '0';
  const includeBreakdown =
    req.query.include_breakdown === 'true' || req.query.include_breakdown === '1';

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

router.get('/cashflow-forecast-accuracy', async (req, res) => {
  const userId = req.get('x-actor') || 'anonymous';
  const rawLimit = parseInt(req.query.limit_months, 10);
  const limitMonths = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 48) : 24;

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
  });
  res.ok({ data, meta });
});

export default router;
