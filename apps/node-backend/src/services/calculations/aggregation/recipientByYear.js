/**
 * Recipient-by-year aggregation.
 *
 * Top recipients keyed by year. Used by the statistics page
 * to render year-over-year recipient spending charts.
 */

import infoRepository from '../../../repositories/infoRepository.js';
import { buildEnvelope } from './_envelope.js';
import { assertNoNaN } from './_invariants.js';

export async function computeRecipientByYear({
  targetCurrency = 'EUR',
  excludedRecipientIds = [],
  excludedCategoryIds = [],
} = {}) {
  const data = await infoRepository.getRecipientByYear(targetCurrency, excludedRecipientIds, excludedCategoryIds);
  assertNoNaN(data, 'computeRecipientByYear');
  return buildEnvelope(data, { source: 'live' });
}

export default { computeRecipientByYear };
