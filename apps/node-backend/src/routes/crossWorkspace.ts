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

import { Router } from "express";
import { z } from "zod";
import {
  rebalanceDeployment,
  resolveDeployableCash,
} from "../services/crossWorkspaceAnalytics.ts";
import { assembleRebalanceInputs } from "../services/crossWorkspaceDataService.ts";
import { resolveRebalanceTargetWeights } from "../services/portfolio/rebalanceTargets.ts";
import { computeCommitmentAwareCash } from "../services/commitmentAwareCashService.ts";
import { parseInput } from "../lib/zodInput.ts";

const router = Router();

const commitmentAwareCashBodySchema = z.object({
  reserveFloor: z
    .number({ error: "must be a non-negative finite number" })
    .nonnegative("must be a non-negative finite number")
    .nullish()
    .transform((value) => value ?? 0),
  currency: z
    .string({ error: "must be a three-letter code" })
    .regex(/^[A-Z]{3}$/i, "must be a three-letter code")
    .optional(),
});

/**
 * The rebalance wire contract is deliberately lenient (pinned by the route
 * tests): a non-string currency means EUR, a truthy non-object `targetWeights`
 * falls through to `model`, and a non-numeric cash cap is ignored.
 * `resolveRebalanceTargetWeights` validates the target itself.
 */
const rebalanceBodySchema = z.looseObject({
  currency: z
    .unknown()
    .optional()
    .transform((value) =>
      typeof value === "string" ? value.toUpperCase() : "EUR",
    ),
  availableCash: z
    .unknown()
    .optional()
    .transform((value) => {
      const cap = Number(value);
      return value == null || !Number.isFinite(cap) ? undefined : cap;
    }),
});

router.post("/commitment-aware-cash", async (req, res) => {
  const { reserveFloor, currency } = parseInput(
    commitmentAwareCashBodySchema,
    req.body ?? {},
  );
  res.ok(
    await computeCommitmentAwareCash({
      currency: currency ?? "EUR",
      reserveFloor,
    }),
  );
});

/**
 * Cash-aware rebalancing. Body:
 *   { currency?: string,
 *     model?: 'sixty_forty'|'all_weather'|'three_fund'|'awesome',   // convenience preset
 *     targetWeights?: Record<string, number> }            // explicit, by asset class
 * `targetWeights` wins over `model`; both are normalized to sum to 1.
 */
router.post("/rebalance", async (req, res) => {
  const body = parseInput(rebalanceBodySchema, req.body ?? {});
  const { currency } = body;

  const targetWeights = resolveRebalanceTargetWeights(body);

  const { actualValues, availableCash, cashAccounts } =
    await assembleRebalanceInputs({ currency });
  // Clamp any user cash cap to [0, availableCash] in the pure core so an API
  // caller can never deploy more than actually exists.
  const cash = resolveDeployableCash({
    availableCash,
    cap: body.availableCash,
  });

  const deployment = rebalanceDeployment({
    actualValues,
    targetWeights,
    availableCash: cash,
  });

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
