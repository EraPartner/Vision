/**
 * Aggregation routes (Phase 2).
 *
 * Single source of truth for Dashboard + Statistics widgets. Each endpoint
 * delegates to a pure calc module in services/calculations/aggregation/.
 * Calc modules return `{ data, meta: { computedAt, source } }`; the route layer
 * forwards both into the unified envelope via `res.ok(data, meta)`
 * (see docs/adr/026-unified-api-response-envelope.md).
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
  const { data, meta } = await computeMonthlySummary({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
  });
  res.ok(data, meta);
});

router.get('/category-breakdown', async (req, res) => {
  const { data, meta } = await computeCategoryBreakdown({
    targetCurrency: getTargetCurrency(req),
  });
  res.ok(data, meta);
});

router.get('/recipient-insights', async (req, res) => {
  const { data, meta } = await computeRecipientInsights({
    targetCurrency: getTargetCurrency(req),
  });
  res.ok(data, meta);
});

router.get('/cashflow-comparison', async (req, res) => {
  const { data, meta } = await computeCashflowComparison({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
  });
  res.ok(data, meta);
});

router.get('/average-vs-current', async (req, res) => {
  const { data, meta } = await computeAverageVsCurrent({
    targetCurrency: getTargetCurrency(req),
  });
  res.ok(data, meta);
});

router.get('/bank-balances', async (req, res) => {
  const { data, meta } = await computeBankBalances({
    targetCurrency: getTargetCurrency(req),
  });
  res.ok(data, meta);
});

export default router;
