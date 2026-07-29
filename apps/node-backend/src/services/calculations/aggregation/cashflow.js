/**
 * Cashflow comparison aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getCashflowComparison. Current
 * month cumulative vs 24-month rolling average. Source flips to 'live' when
 * either exclusion list is non-empty.
 */

import infoRepository from '../../../repositories/infoRepository.js';
import { buildEnvelope } from './_envelope.js';
import { assertNoNaN } from './_invariants.js';

/**
 * @param {{ targetCurrency?: string, excludedCategoryIds?: number[], excludedRecipientIds?: number[] }} [opts]
 */
export async function computeCashflowComparison({
  targetCurrency = 'EUR',
  excludedCategoryIds = [],
  excludedRecipientIds = [],
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
