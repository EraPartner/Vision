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
import { z } from 'zod';
import { ValidationError } from '../middleware/errorHandler.js';
import { rebalanceDeployment, resolveDeployableCash } from '../services/crossWorkspaceAnalytics.js';
import { CLASSIC_PORTFOLIOS, normalizeWeights, foldTargetSleeves } from '../services/portfolio/allocationAnalytics.js';
import { assembleRebalanceInputs } from '../services/crossWorkspaceDataService.js';

const router = Router();

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

// Explicit target weights: per-sleeve Number() coercion (the pure core does
// arithmetic on them) + all-zero-sum rejection. Deliberately NOT shared with
// settings.js's rebalancePlanSchema.targetWeights even though the rules read
// alike: that schema STORES weights as sent (numeric strings preserved for the
// settings blob) and rejects an empty record with its own "at least one
// sleeve" message, while this request path coerces for computation and lets {}
// fall through to the zero-sum rejection. Sharing one schema would change one
// side's wire behavior.
const targetWeightsSchema = z.unknown().transform((value, ctx) => {
  /** @type {Record<string, number>} */
  const weights = {};
  for (const [sleeve, weight] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const n = Number(weight);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({ code: 'custom', message: `targetWeights.${sleeve} must be a non-negative number` });
      return z.NEVER;
    }
    weights[sleeve] = n;
  }
  // All-zero weights (an empty record included) would otherwise normalize to
  // themselves and silently "deploy nothing" with no explanation.
  if (!Object.values(weights).some((n) => n > 0)) {
    ctx.addIssue({ code: 'custom', message: 'targetWeights must include at least one positive weight' });
    return z.NEVER;
  }
  return weights;
});

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
function parseRebalanceInput(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((issue) => issue.message).join('; '));
  }
  return result.data;
}

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

  // Dispatch stays imperative on purpose: a truthy NON-object targetWeights is
  // ignored (falls through to the model branch), matching the pre-zod branch
  // condition — a record schema would reject it instead. The classic presets
  // are static positive-weight maps, so the schema's zero-sum rejection only
  // ever concerns explicit targetWeights, exactly as before.
  let rawTarget;
  if (body.targetWeights && typeof body.targetWeights === 'object') {
    rawTarget = parseRebalanceInput(targetWeightsSchema, body.targetWeights);
  } else if (body.model) {
    rawTarget = CLASSIC_PORTFOLIOS[body.model];
    if (!rawTarget) throw new ValidationError(`Unknown model '${body.model}' (expected one of: ${Object.keys(CLASSIC_PORTFOLIOS).join(', ')})`);
  } else {
    throw new ValidationError('Provide either `model` or `targetWeights`');
  }

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
