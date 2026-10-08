import { z } from "zod";
import { ValidationError } from "../../middleware/errorHandler.ts";
import {
  CLASSIC_PORTFOLIOS,
  foldTargetSleeves,
  normalizeWeights,
} from "./allocationAnalytics.ts";

const MODEL_PORTFOLIOS: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = CLASSIC_PORTFOLIOS;

// This computation path coerces numeric strings and lets an empty object reach
// the positive-sum check. The persisted rebalance-plan schema intentionally has
// a different wire contract, so these schemas must not be shared.
const targetWeightsSchema = z.unknown().transform((value, ctx) => {
  const weights: Record<string, number> = {};
  // Callers only parse values already checked to be objects.
  for (const [sleeve, weight] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const number = Number(weight);
    if (!Number.isFinite(number) || number < 0) {
      ctx.addIssue({
        code: "custom",
        message: `targetWeights.${sleeve} must be a non-negative number`,
      });
      return z.NEVER;
    }
    weights[sleeve] = number;
  }
  if (!Object.values(weights).some((number) => number > 0)) {
    ctx.addIssue({
      code: "custom",
      message: "targetWeights must include at least one positive weight",
    });
    return z.NEVER;
  }
  return weights;
});

/**
 * Resolve an explicit target or a canonical model to normalized, representable
 * rebalance sleeves. Explicit object targets take precedence over models.
 * Truthy non-object targets fall through to the model branch for wire compatibility.
 */
export function resolveRebalanceTargetWeights(
  body: Record<string, unknown>,
): Record<string, number> {
  let rawTarget: Readonly<Record<string, number>> | undefined;
  if (body.targetWeights && typeof body.targetWeights === "object") {
    const result = targetWeightsSchema.safeParse(body.targetWeights);
    if (!result.success) {
      throw new ValidationError(
        result.error.issues.map((issue) => issue.message).join("; "),
      );
    }
    rawTarget = result.data;
  } else if (body.model) {
    const model = String(body.model);
    // Own keys only: "toString" or "constructor" would otherwise resolve to
    // Object.prototype members and slip past the unknown-model check.
    rawTarget = Object.hasOwn(MODEL_PORTFOLIOS, model)
      ? MODEL_PORTFOLIOS[model]
      : undefined;
    if (!rawTarget) {
      throw new ValidationError(
        `Unknown model '${body.model}' (expected one of: ${Object.keys(CLASSIC_PORTFOLIOS).join(", ")})`,
      );
    }
  } else {
    throw new ValidationError("Provide either `model` or `targetWeights`");
  }

  return normalizeWeights(foldTargetSleeves(rawTarget));
}
