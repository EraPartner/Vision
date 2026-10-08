/**
 * Recipient-by-year aggregation.
 *
 * Top recipients keyed by year. Used by the statistics page
 * to render year-over-year recipient spending charts.
 */

import infoRepository from "../../../repositories/infoRepository.ts";
import { buildEnvelope } from "./_envelope.ts";
import { assertNoNaN } from "./_invariants.ts";
import { withStatisticsCache, statsKeyPart } from "./_statisticsCache.ts";
import type { RecipientByYearOptions } from "../../../repositories/infoRepositoryRecipients.ts";

export async function computeRecipientByYear({
  targetCurrency = "EUR",
  excludedRecipientIds = [],
  excludedCategoryIds = [],
  startDate = undefined,
  endDate = undefined,
}: RecipientByYearOptions = {}) {
  const key = `rby|${targetCurrency}|r:${statsKeyPart(excludedRecipientIds)}|c:${statsKeyPart(excludedCategoryIds)}|s:${startDate || ""}|e:${endDate || ""}`;
  return withStatisticsCache(key, async () => {
    const data = await infoRepository.getRecipientByYear({
      targetCurrency,
      excludedRecipientIds,
      excludedCategoryIds,
      startDate,
      endDate,
    });
    assertNoNaN(data, "computeRecipientByYear");
    return buildEnvelope(data, { source: "live" });
  });
}

export default { computeRecipientByYear };
