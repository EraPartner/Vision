/**
 * Category breakdown aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getCategoryBreakdown. Backed
 * by mv_category_totals in the repository; when exclusions land in Phase 6
 * the wrapper will pass them through.
 */

import infoRepository from "../../../repositories/infoRepository.ts";
import { buildEnvelope } from "./_envelope.ts";
import { assertCategoryInvariants } from "./_invariants.ts";

export async function computeCategoryBreakdown({
  targetCurrency = "EUR",
  ancestorCategoryId = undefined,
}: { targetCurrency?: string; ancestorCategoryId?: number } = {}) {
  const categories =
    ancestorCategoryId === undefined
      ? await infoRepository.getCategoryBreakdown(targetCurrency)
      : await infoRepository.getCategoryBreakdown(
          targetCurrency,
          ancestorCategoryId,
        );
  assertCategoryInvariants(categories);
  return buildEnvelope(
    { categories },
    { source: ancestorCategoryId === undefined ? "mv" : "live" },
  );
}

export default { computeCategoryBreakdown };
