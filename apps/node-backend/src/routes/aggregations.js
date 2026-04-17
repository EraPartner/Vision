/**
 * Aggregation routes (Phase 2).
 *
 * Single source of truth for Dashboard + Statistics widgets. Each endpoint
 * delegates to a pure calc module in services/calculations/aggregation/ and
 * returns the standard `{ data, meta: { computedAt, source } }` envelope.
 *
 * Mounted in parallel with legacy /api/info/* behind the AGGREGATIONS_V2_ENABLED
 * feature flag during Phase 2–8; legacy routes are removed in Phase 9 after
 * shadow-mode parity is proven.
 */

import { Router } from 'express';
import { logger } from '../config/logger.js';
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

function respondError(res, label, err) {
  logger.error(`Error computing aggregation: ${label}`, { error: err.message, stack: err.stack });
  res.status(500).json({ detail: `Error computing aggregation: ${label}` });
}

// GET /api/aggregations/monthly-summary?currency&excluded_category_ids[]&excluded_recipient_ids[]
router.get('/monthly-summary', async (req, res) => {
  try {
    const envelope = await computeMonthlySummary({
      targetCurrency: getTargetCurrency(req),
      excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
      excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
    });
    res.json(envelope);
  } catch (err) {
    respondError(res, 'monthly-summary', err);
  }
});

// GET /api/aggregations/category-breakdown?currency
router.get('/category-breakdown', async (req, res) => {
  try {
    const envelope = await computeCategoryBreakdown({
      targetCurrency: getTargetCurrency(req),
    });
    res.json(envelope);
  } catch (err) {
    respondError(res, 'category-breakdown', err);
  }
});

// GET /api/aggregations/recipient-insights?currency
router.get('/recipient-insights', async (req, res) => {
  try {
    const envelope = await computeRecipientInsights({
      targetCurrency: getTargetCurrency(req),
    });
    res.json(envelope);
  } catch (err) {
    respondError(res, 'recipient-insights', err);
  }
});

// GET /api/aggregations/cashflow-comparison?currency&excluded_category_ids[]&excluded_recipient_ids[]
router.get('/cashflow-comparison', async (req, res) => {
  try {
    const envelope = await computeCashflowComparison({
      targetCurrency: getTargetCurrency(req),
      excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
      excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
    });
    res.json(envelope);
  } catch (err) {
    respondError(res, 'cashflow-comparison', err);
  }
});

// GET /api/aggregations/average-vs-current?currency
router.get('/average-vs-current', async (req, res) => {
  try {
    const envelope = await computeAverageVsCurrent({
      targetCurrency: getTargetCurrency(req),
    });
    res.json(envelope);
  } catch (err) {
    respondError(res, 'average-vs-current', err);
  }
});

// GET /api/aggregations/bank-balances?currency
router.get('/bank-balances', async (req, res) => {
  try {
    const envelope = await computeBankBalances({
      targetCurrency: getTargetCurrency(req),
    });
    res.json(envelope);
  } catch (err) {
    respondError(res, 'bank-balances', err);
  }
});

export default router;
