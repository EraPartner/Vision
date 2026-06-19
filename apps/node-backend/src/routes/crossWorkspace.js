/**
 * Cross-workspace routes (ADR-098) — surfaces that compose Budgeting + Portfolio
 * + Research in one place.
 *
 * POST /api/cross-workspace/rebalance     — cash-aware rebalancing: deploy
 *   spendable cash into underweight sleeves toward a target allocation, no sells.
 *
 * The math is the pure core in services/crossWorkspaceAnalytics.js; the DB
 * assembly is services/crossWorkspaceDataService.js. Routes only orchestrate.
 */

import { Router } from 'express';
import { ValidationError } from '../middleware/errorHandler.js';
import { rebalanceDeployment } from '../services/crossWorkspaceAnalytics.js';
import { CLASSIC_PORTFOLIOS, normalizeWeights } from '../services/portfolio/allocationAnalytics.js';
import { assembleRebalanceInputs } from '../services/crossWorkspaceDataService.js';

const router = Router();

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

export default router;
