/**
 * Cashflow comparison aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getCashflowComparison. Current
 * month cumulative vs 24-month rolling average. Source flips to 'live' when
 * either exclusion list is non-empty.
 */

import infoRepository from '../../../repositories/infoRepository.ts';
import { buildEnvelope } from './_envelope.ts';
import { assertNoNaN } from './_invariants.ts';

export async function computeCashflowComparison({
  targetCurrency = 'EUR',
  excludedCategoryIds = [],
  excludedRecipientIds = [],
}: {
  targetCurrency?: string;
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
} = {}) {
  const data = await infoRepository.getCashflowComparison(
    excludedCategoryIds,
    excludedRecipientIds,
    targetCurrency,
  );

  assertNoNaN(data, 'computeCashflowComparison');
  const hasExclusions =
    excludedCategoryIds.length > 0 || excludedRecipientIds.length > 0;
  const source = hasExclusions ? 'live' : 'mv';
  return buildEnvelope(data, { source });
}

export default { computeCashflowComparison };
