/**
 * Recipient insights aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getRecipientInsights, which
 * serves a live scan of `transactions` (it does NOT read mv_recipient_monthly).
 * The envelope is tagged accordingly, matching its recipientPivot/recipientByYear
 * siblings.
 */

import infoRepository from "../../../repositories/infoRepository.ts";
import { buildEnvelope } from "./_envelope.ts";
import { assertNoNaN } from "./_invariants.ts";
import type { RecipientByYearOptions } from "../../../repositories/infoRepositoryRecipients.ts";

export async function computeRecipientInsights({
  targetCurrency = "EUR",
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  startDate = undefined,
  endDate = undefined,
}: RecipientByYearOptions = {}) {
  const data = await infoRepository.getRecipientInsights(targetCurrency, {
    excludedCategoryIds,
    excludedRecipientIds,
    startDate,
    endDate,
  });
  assertNoNaN(data, "computeRecipientInsights");
  return buildEnvelope(data, { source: "live" });
}

export default { computeRecipientInsights };
