/**
 * Category breakdown aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getCategoryBreakdown. Backed
 * by mv_category_totals for unfiltered requests and a live aggregate for
 * exact date ranges, exclusions, or ancestor rollups.
 */

import type { CategoryPivotOptions } from "../../../repositories/infoRepositoryStatistics.ts";
import infoRepository from "../../../repositories/infoRepository.ts";
import { buildEnvelope } from "./_envelope.ts";
import { assertCategoryInvariants } from "./_invariants.ts";
import {
  createUnconvertedTally,
  unconvertedFields,
} from "../../../lib/unconvertedTally.ts";

export async function computeCategoryBreakdown({
  targetCurrency = "EUR",
  ancestorCategoryId,
  ...filters
}: CategoryPivotOptions & {
  targetCurrency?: string | undefined;
  ancestorCategoryId?: number | undefined;
} = {}) {
  // Rows without a stored rate are left out of the categories and counted.
  const unconverted = createUnconvertedTally();
  const categories = await infoRepository.getCategoryBreakdown(
    targetCurrency,
    ancestorCategoryId,
    filters,
    unconverted,
  );
  assertCategoryInvariants(categories);
  return buildEnvelope(
    { categories, ...unconvertedFields(unconverted) },
    {
      source:
        ancestorCategoryId === undefined && Object.keys(filters).length === 0
          ? "mv"
          : "live",
    },
  );
}
