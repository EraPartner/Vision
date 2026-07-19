/**
 * Recipient-by-year aggregation.
 *
 * Top recipients keyed by year. Used by the statistics page
 * to render year-over-year recipient spending charts.
 */

import infoRepository from '../../../repositories/infoRepository.js';
import { buildEnvelope } from './_envelope.js';
import { assertNoNaN } from './_invariants.js';
import { withStatisticsCache, statsKeyPart } from './_statisticsCache.js';

export async function computeRecipientByYear({
  targetCurrency = 'EUR',
  excludedRecipientIds = [],
  excludedCategoryIds = [],
} = {}) {
  const key = `rby|${targetCurrency}|r:${statsKeyPart(excludedRecipientIds)}|c:${statsKeyPart(excludedCategoryIds)}`;
  return withStatisticsCache(key, async () => {
    const data = await infoRepository.getRecipientByYear(targetCurrency, excludedRecipientIds, excludedCategoryIds);
    assertNoNaN(data, 'computeRecipientByYear');
    return buildEnvelope(data, { source: 'live' });
  });
}

export default { computeRecipientByYear };
