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
import { rebalanceDeployment, resolveDeployableCash } from '../services/crossWorkspaceAnalytics.js';
import { assembleRebalanceInputs } from '../services/crossWorkspaceDataService.js';
import { resolveRebalanceTargetWeights } from '../services/portfolio/rebalanceTargets.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

/**
 * Cash-aware rebalancing. Body:
 *   { currency?: string,
 *     model?: 'sixty_forty'|'all_weather'|'three_fund',   // convenience preset
 *     targetWeights?: Record<string, number> }            // explicit, by asset class
 * `targetWeights` wins over `model`; both are normalized to sum to 1.
 */
router.post('/rebalance', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const body = req.body ?? {};
  const currency = typeof body.currency === 'string' ? body.currency.toUpperCase() : 'EUR';

  const targetWeights = resolveRebalanceTargetWeights(body);

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
