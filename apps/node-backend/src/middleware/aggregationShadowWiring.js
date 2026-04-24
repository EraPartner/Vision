/**
 * Wires the aggregation shadow middleware (Phase 8) for the 6 endpoints that
 * have direct info-route twins. Cashflow-forecast and sankey have no legacy
 * twins and are intentionally excluded.
 *
 * Call `setupAggregationShadow(app, { logger })` before mounting
 * `/api/aggregations` so the shadow intercepts each route's response.
 */

import infoRepository from '../repositories/infoRepository.js';
import { query as dbQuery } from '../database/connection.js';
import { createAggregationShadow } from './aggregationShadow.js';

function getTargetCurrency(req) {
  const raw = req.query.currency ?? req.query.target_currency;
  if (raw == null || raw === '') return 'EUR';
  const value = String(raw).toUpperCase().trim();
  return /^[A-Z]{3}$/.test(value) ? value : 'EUR';
}

function parseIds(raw) {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(Number).filter(Number.isFinite);
}

async function persistDivergence(endpoint, requestParams, divergences) {
  await dbQuery(
    `INSERT INTO agg_shadow_divergences (endpoint, request_params, divergences, divergence_count)
     VALUES ($1, $2, $3, $4)`,
    [endpoint, JSON.stringify(requestParams), JSON.stringify(divergences), divergences.length],
  );
}

const SHADOW_CONFIGS = {
  '/monthly-summary': (req) => infoRepository.getMonthlyFinancialSummary(
    parseIds(req.query.excluded_category_ids),
    getTargetCurrency(req),
    parseIds(req.query.excluded_recipient_ids),
  ),
  '/category-breakdown': (req) => infoRepository.getCategoryBreakdown(getTargetCurrency(req)),
  '/recipient-insights': (req) => infoRepository.getRecipientInsights(getTargetCurrency(req)),
  '/cashflow-comparison': (req) => infoRepository.getCashflowComparison(
    parseIds(req.query.excluded_category_ids),
    parseIds(req.query.excluded_recipient_ids),
    getTargetCurrency(req),
  ),
  '/average-vs-current': (req) => infoRepository.getAverageVsCurrentSpending(getTargetCurrency(req)),
  '/bank-balances': (req) => infoRepository.getBankBalances(getTargetCurrency(req)),
};

/**
 * Mount per-endpoint shadow middleware on `app` before the aggregations router.
 *
 * @param {import('express').Application} app
 * @param {{ logger: { warn: Function, debug?: Function } }} opts
 */
export function setupAggregationShadow(app, { logger }) {
  for (const [path, fetchLegacy] of Object.entries(SHADOW_CONFIGS)) {
    app.use(
      `/api/aggregations${path}`,
      createAggregationShadow({ fetchLegacy, logger, persistDivergence }),
    );
  }
  logger.info(`Aggregation shadow mode enabled for ${Object.keys(SHADOW_CONFIGS).length} endpoints`);
}
