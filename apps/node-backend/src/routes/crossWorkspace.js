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
import { rebalanceDeployment, resolveDeployableCash } from '../services/crossWorkspaceAnalytics.js';
import { CLASSIC_PORTFOLIOS, normalizeWeights, foldTargetSleeves } from '../services/portfolio/allocationAnalytics.js';
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

  // All-zero weights would otherwise normalize to themselves and silently
  // "deploy nothing" with no explanation. Reject up front.
  const targetSum = Object.values(rawTarget).reduce((s, v) => s + (Number(v) || 0), 0);
  if (!(targetSum > 0)) throw new ValidationError('targetWeights must include at least one positive weight');

  // Fold unrepresentable preset sleeves (commodities, intl_stocks) into the
  // sleeves the user can actually hold, then normalize to sum to 1.
  const targetWeights = normalizeWeights(foldTargetSleeves(rawTarget));

  const { actualValues, availableCash, cashAccounts } = await assembleRebalanceInputs({ currency });
  // Clamp any user cash cap to [0, availableCash] in the pure core so an API
  // caller can never deploy more than actually exists.
  const cash = resolveDeployableCash({ availableCash, cap: body.availableCash });

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
