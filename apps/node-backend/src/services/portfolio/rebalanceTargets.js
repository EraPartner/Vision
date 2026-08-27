import { z } from 'zod';
import { ValidationError } from '../../middleware/errorHandler.js';
import { CLASSIC_PORTFOLIOS, foldTargetSleeves, normalizeWeights } from './allocationAnalytics.js';

// This computation path coerces numeric strings and lets an empty object reach
// the positive-sum check. The persisted rebalance-plan schema intentionally has
// a different wire contract, so these schemas must not be shared.
const targetWeightsSchema = z.unknown().transform((value, ctx) => {
  /** @type {Record<string, number>} */
  const weights = {};
  for (const [sleeve, weight] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const number = Number(weight);
    if (!Number.isFinite(number) || number < 0) {
      ctx.addIssue({ code: 'custom', message: `targetWeights.${sleeve} must be a non-negative number` });
      return z.NEVER;
    }
    weights[sleeve] = number;
  }
  if (!Object.values(weights).some((number) => number > 0)) {
    ctx.addIssue({ code: 'custom', message: 'targetWeights must include at least one positive weight' });
    return z.NEVER;
  }
  return weights;
});

/**
 * Resolve an explicit target or a canonical model to normalized, representable
 * rebalance sleeves. Explicit object targets take precedence over models.
 * Truthy non-object targets fall through to the model branch for wire compatibility.
 *
 * @param {Record<string, unknown>} body
 * @returns {Record<string, number>}
 */
export function resolveRebalanceTargetWeights(body) {
  let rawTarget;
  if (body.targetWeights && typeof body.targetWeights === 'object') {
    const result = targetWeightsSchema.safeParse(body.targetWeights);
    if (!result.success) {
      throw new ValidationError(result.error.issues.map((issue) => issue.message).join('; '));
    }
    rawTarget = result.data;
  } else if (body.model) {
    rawTarget = CLASSIC_PORTFOLIOS[/** @type {keyof typeof CLASSIC_PORTFOLIOS} */ (body.model)];
    if (!rawTarget) {
      throw new ValidationError(`Unknown model '${body.model}' (expected one of: ${Object.keys(CLASSIC_PORTFOLIOS).join(', ')})`);
    }
  } else {
    throw new ValidationError('Provide either `model` or `targetWeights`');
  }

  return normalizeWeights(foldTargetSleeves(rawTarget));
}
