/**
 * /api/info statistics + metadata endpoints:
 *   - GET /
 *   - GET /banks
 *   - GET /supported-adapters
 *   - GET /transaction-count
 *   - GET /transaction-summary
 *   - GET /planned-expenses-next-month
 *   - GET /recurring-patterns
 *   - GET /insights-digest
 *   - GET /deduction-candidates
 */

import { Router } from "express";
import { z } from "zod";
import infoService from "../../services/infoService.ts";
import { detectRecurringPatterns } from "../../services/recurringDetectionService.ts";
import {
  getInsightsCount,
  getInsightsDigest,
} from "../../services/insightsDigestService.ts";
import { dismissInsight } from "../../services/insightDismissalService.ts";
import { computeDeductionCandidates } from "../../services/tax/deductionCandidatesService.ts";
import { listAdapters } from "../../services/importPipeline/adapters/index.ts";
import { logger } from "../../config/logger.ts";
import { getTargetCurrency } from "./_queryParams.ts";
import { assertOptionalId } from "../../middleware/validation.ts";
import { ValidationError } from "../../middleware/errorHandler.ts";

const router = Router();

const insightDismissalSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["subscription_new", "subscription_price_change"]),
    recipient_id: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("category_outlier"),
    category_id: z.number().int().positive(),
    month_key: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  }),
]);

function parseInsightDismissal(body: unknown) {
  const result = insightDismissalSchema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return result.data;
}

// (Removed legacy GET /api/info and GET /api/info/transaction-summary — Phase 9
// cutover (ADR-010): the aggregations.js routes superseded them and they had
// zero production callers. The category breakdown lives on via getCategoryBreakdown.)

// Both metadata lists use the canonical `{items, total}` collection shape
// (unpaginated — `total` is the row count, present so pagination could land
// without breaking the shape).
router.get("/banks", async (req, res) => {
  const banks = await infoService.getBanks();
  res.ok({ items: banks, total: banks.length });
});

router.get("/insights-count", async (_req, res) => {
  res.ok(await getInsightsCount());
});

router.put("/insight-dismissals", async (req, res) => {
  res.ok(await dismissInsight(parseInsightDismissal(req.body)));
});

router.get("/supported-adapters", async (req, res) => {
  // Derived from the adapter registry (single source of truth) so a newly
  // registered adapter appears in the import card + onboarding wizard without a
  // second hardcoded list to update. (The old list also referenced
  // *Adapter-class names that don't exist anywhere in the codebase.)
  const adapters = listAdapters();
  res.ok({ items: adapters, total: adapters.length });
});

router.get("/transaction-count", async (req, res) => {
  const accountId = assertOptionalId(req.query.account_id, "account_id");
  const count = await infoService.getTransactionCount({ accountId });
  res.ok({ total_transactions: count });
});

router.get("/planned-expenses-next-month", async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const data = await infoService.getPlannedExpensesNextMonth(targetCurrency);
  res.ok({ ...data, links: [] });
});

// Intentional graceful degradation: on failure emit empty envelope rather than 500.
router.get("/recurring-patterns", async (req, res) => {
  try {
    const data = await detectRecurringPatterns();
    res.ok(data);
  } catch (err) {
    logger.error("Error detecting recurring patterns; returning empty result", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.ok({ patterns: [], total: 0 });
  }
});

// Pre-computed insight findings for the Statistics-page panel (no LLM) — same
// graceful degradation as /recurring-patterns: empty digest instead of a 500.
router.get("/insights-digest", async (req, res) => {
  try {
    const digest = await getInsightsDigest();
    res.ok(digest);
  } catch (err) {
    logger.error("Error building insights digest; returning empty result", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.ok({
      subscriptionCreep: { new: [], priceChanges: [] },
      categoryOutliers: [],
      cashForecast: null,
    });
  }
});

/**
 * Optional `year` query param → validated integer, or undefined when absent.
 * Bounds match the AI-chat tax tools; malformed input (including trailing
 * garbage parseInt would swallow, e.g. `2025abc`) is a 400, not a silent guess.
 */
function assertOptionalYear(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const year = Number.parseInt(String(value), 10);
  if (
    !Number.isInteger(year) ||
    String(year) !== String(value).trim() ||
    year < 1970 ||
    year > 3000
  ) {
    throw new ValidationError("year must be an integer between 1970 and 3000");
  }
  return year;
}

// Transaction-derived Belgian deduction-type candidates for the Tax Overview
// review card. `year` defaults to the current calendar year. Same graceful
// degradation as the siblings above — an empty candidate list instead of a 500
// (a malformed `year` still 400s: it is validated before the try).
router.get("/deduction-candidates", async (req, res) => {
  const year = assertOptionalYear(req.query.year) ?? new Date().getFullYear();
  try {
    const data = await computeDeductionCandidates({ year });
    res.ok(data);
  } catch (err) {
    logger.error(
      "Error computing deduction candidates; returning empty result",
      { error: err instanceof Error ? err.message : String(err) },
    );
    res.ok({
      year,
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      currency: "EUR",
      byDeductionType: [],
    });
  }
});

export default router;
