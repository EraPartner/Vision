/**
 * Monthly summary aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getMonthlyFinancialSummary.
 * Keeps the aggregation envelope shape decoupled from the repository so
 * future phases can split the repo-bound SQL out without touching callers.
 *
 * Source heuristic: MV-backed when no category exclusions are applied
 * (repository serves from mv_monthly_summary); falls back to live SQL when
 * exclusions force a filtered scan.
 */

import infoRepository from "../../../repositories/infoRepository.ts";
import { buildEnvelope } from "./_envelope.ts";
import { assertNoNaN, assertMonthlyInvariants } from "./_invariants.ts";

export async function computeMonthlySummary({
  targetCurrency = "EUR",
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  allTime = false,
  startDate = undefined,
  endDate = undefined,
}: {
  targetCurrency?: string;
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
  allTime?: boolean;
  startDate?: string;
  endDate?: string;
} = {}) {
  const data = await infoRepository.getMonthlyFinancialSummary(
    excludedCategoryIds,
    targetCurrency,
    excludedRecipientIds,
    allTime,
    startDate,
    endDate,
  );

  assertNoNaN(data, "computeMonthlySummary");
  assertMonthlyInvariants(Array.isArray(data) ? data : data?.months);

  const hasExclusions =
    excludedCategoryIds.length > 0 || excludedRecipientIds.length > 0;
  const source =
    hasExclusions || allTime || startDate || endDate ? "live" : "mv";
  return buildEnvelope(data, { source });
}

export default { computeMonthlySummary };
