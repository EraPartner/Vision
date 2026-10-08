/**
 * Category pivot aggregation.
 *
 * Per-category, per-month spending breakdown. Used by the statistics page
 * to render the category-over-time chart.
 */

import infoRepository from "../../../repositories/infoRepository.ts";
import { buildEnvelope } from "./_envelope.ts";
import { assertNoNaN } from "./_invariants.ts";
import { withStatisticsCache, statsKeyPart } from "./_statisticsCache.ts";
import type { CategoryPivotOptions } from "../../../repositories/infoRepositoryStatistics.ts";

export async function computeCategoryPivot({
  targetCurrency = "EUR",
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  startDate = undefined,
  endDate = undefined,
}: CategoryPivotOptions = {}) {
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
