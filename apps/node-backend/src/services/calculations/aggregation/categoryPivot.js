/**
 * Category pivot aggregation.
 *
 * Per-category, per-month spending breakdown. Used by the statistics page
 * to render the category-over-time chart.
 */

import infoRepository from "../../../repositories/infoRepository.js";
import { buildEnvelope } from "./_envelope.js";
import { assertNoNaN } from "./_invariants.js";
import { withStatisticsCache, statsKeyPart } from "./_statisticsCache.js";

/**
 * @param {{ targetCurrency?: string, excludedCategoryIds?: number[], excludedRecipientIds?: number[], startDate?: string, endDate?: string }} [opts]
 */
export async function computeCategoryPivot({
  targetCurrency = "EUR",
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  startDate = undefined,
  endDate = undefined,
} = {}) {
  const key = `cat|${targetCurrency}|c:${statsKeyPart(excludedCategoryIds)}|r:${statsKeyPart(excludedRecipientIds)}|s:${startDate || ""}|e:${endDate || ""}`;
  return withStatisticsCache(key, async () => {
    const data = await infoRepository.getCategoryPivot({
      excludedCategoryIds,
      targetCurrency,
      excludedRecipientIds,
      startDate,
      endDate,
    });
    assertNoNaN(data, "computeCategoryPivot");
    return buildEnvelope(data, { source: "live" });
  });
}

export default { computeCategoryPivot };
