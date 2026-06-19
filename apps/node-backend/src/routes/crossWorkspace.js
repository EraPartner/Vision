/**
 * Cross-workspace routes (ADR-098) — surfaces that compose Budgeting + Portfolio
 * + Research in one place.
 *
 * POST /api/cross-workspace/rebalance     — cash-aware rebalancing: deploy
 *   spendable cash into underweight sleeves toward a target allocation, no sells.
 * GET  /api/cross-workspace/unified-tax   — owner-allocated income + dividends +
 *   realized gains for a tax year (indicative; feeds the marital-quotient view).
 *
 * The math is the pure core in services/crossWorkspaceAnalytics.js; the DB
 * assembly is services/crossWorkspaceDataService.js. Routes only orchestrate.
 */

import { Router } from 'express';
import { ValidationError } from '../middleware/errorHandler.js';
import { rebalanceDeployment, unifiedTax } from '../services/crossWorkspaceAnalytics.js';
import { CLASSIC_PORTFOLIOS, normalizeWeights } from '../services/portfolio/allocationAnalytics.js';
import { assembleRebalanceInputs, assembleUnifiedTaxItems } from '../services/crossWorkspaceDataService.js';

const router = Router();

const OWNERS = new Set(['me', 'partner', 'joint']);

/**
 * Cash-aware rebalancing. Body:
 *   { currency?: string,
 *     model?: 'sixty_forty'|'all_weather'|'three_fund',   // convenience preset
 *     targetWeights?: Record<string, number> }            // explicit, by asset class
 * `targetWeights` wins over `model`; both are normalized to sum to 1.
 */
router.post('/rebalance', async (req, res) => {
  const body = req.body ?? {};
  const currency = typeof body.currency === 'string' ? body.currency.toUpperCase() : 'EUR';

  let rawTarget;
  if (body.targetWeights && typeof body.targetWeights === 'object') {
    rawTarget = {};
    for (const [k, v] of Object.entries(body.targetWeights)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new ValidationError(`targetWeights.${k} must be a non-negative number`);
      rawTarget[k] = n;
    }
  } else if (body.model) {
    rawTarget = CLASSIC_PORTFOLIOS[body.model];
    if (!rawTarget) throw new ValidationError(`Unknown model '${body.model}' (expected one of: ${Object.keys(CLASSIC_PORTFOLIOS).join(', ')})`);
  } else {
    throw new ValidationError('Provide either `model` or `targetWeights`');
  }
  const targetWeights = normalizeWeights(rawTarget);

  const { actualValues, availableCash, cashAccounts } = await assembleRebalanceInputs({ currency });
  const overrideCash = body.availableCash;
  const cash = overrideCash != null && Number.isFinite(Number(overrideCash)) ? Number(overrideCash) : availableCash;

  const deployment = rebalanceDeployment({ actualValues, targetWeights, availableCash: cash });

  res.ok({
    currency,
    targetWeights,
    actualValues,
    availableCash: cash,
    cashAccounts,
    deployment,
    links: [],
  });
});

/**
 * Unified tax view for ?year=YYYY. The caller passes the authoritative earned
 * income (tax-profile gross) it already holds; the server adds owner-allocated
 * portfolio dividends + realized gains.
 *   ?year=YYYY (required) &currency=EUR &earnedIncome=NNN &earnedIncomeOwner=me
 */
router.get('/unified-tax', async (req, res) => {
  const year = parseInt(req.query.year, 10);
  if (!Number.isInteger(year) || year < 1900 || year > 3000) {
    throw new ValidationError('`year` must be a 4-digit year');
  }
  const currency = typeof req.query.currency === 'string' ? req.query.currency.toUpperCase() : 'EUR';
  const earnedIncome = req.query.earnedIncome != null ? Number(req.query.earnedIncome) : 0;
  if (req.query.earnedIncome != null && !Number.isFinite(earnedIncome)) {
    throw new ValidationError('`earnedIncome` must be a number');
  }
  const earnedIncomeOwner = OWNERS.has(req.query.earnedIncomeOwner) ? req.query.earnedIncomeOwner : 'me';

  const items = await assembleUnifiedTaxItems({ year, currency, earnedIncome, earnedIncomeOwner });
  const result = unifiedTax(items);

  res.ok({ year, currency, ...result, items, links: [] });
});

export default router;
