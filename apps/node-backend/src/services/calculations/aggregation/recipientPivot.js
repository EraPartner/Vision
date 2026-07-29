/**
 * Recipient pivot aggregation.
 *
 * Per-recipient, per-period spending breakdown. Mirrors categoryPivot but
 * grouped by recipient. Used by the custom charts feature for mixed
 * category+recipient series rendering.
 */

import { recipientInsightsRepository } from '../../../repositories/infoRepositoryRecipients.js';
import { buildEnvelope } from './_envelope.js';
import { assertNoNaN } from './_invariants.js';
import { withStatisticsCache, statsKeyPart } from './_statisticsCache.js';

/**
 * @param {{ targetCurrency?: string, excludedRecipientIds?: number[], bucket?: string, startDate?: string|null, endDate?: string|null, recipientIds?: number[]|null }} [opts]
 */
export async function computeRecipientPivot({
  targetCurrency = 'EUR',
  excludedRecipientIds = [],
  bucket = 'monthly',
  startDate = undefined,
  endDate = undefined,
  recipientIds = undefined,
} = {}) {
  const key = `rpv|${targetCurrency}|b:${bucket}|s:${startDate || ''}|e:${endDate || ''}`
    + `|ri:${statsKeyPart(recipientIds)}|xr:${statsKeyPart(excludedRecipientIds)}`;
  return withStatisticsCache(key, async () => {
    const data = await recipientInsightsRepository.getRecipientPivot(
      excludedRecipientIds,
      targetCurrency,
      { bucket, startDate, endDate, recipientIds }
    );
    assertNoNaN(data, 'computeRecipientPivot');
    return buildEnvelope(data, { source: 'live' });
  });
}

export default { computeRecipientPivot };
