/**
 * Recipient pivot aggregation.
 *
 * Per-recipient, per-period spending breakdown. Mirrors categoryPivot but
 * grouped by recipient. Used by the custom charts feature for mixed
 * category+recipient series rendering.
 */

import { recipientInsightsRepository } from '../../../repositories/infoRepositoryRecipients.ts';
import type { RecipientPivotOptions } from '../../../repositories/infoRepositoryRecipients.ts';
import { buildEnvelope } from './_envelope.ts';
import { assertNoNaN } from './_invariants.ts';
import { withStatisticsCache, statsKeyPart } from './_statisticsCache.ts';

export async function computeRecipientPivot({
  targetCurrency = 'EUR',
  excludedRecipientIds = [],
  bucket = 'monthly',
  startDate = undefined,
  endDate = undefined,
  recipientIds = undefined,
}: RecipientPivotOptions = {}) {
  const key = `rpv|${targetCurrency}|b:${bucket}|s:${startDate || ''}|e:${endDate || ''}`
    + `|ri:${statsKeyPart(recipientIds)}|xr:${statsKeyPart(excludedRecipientIds)}`;
  return withStatisticsCache(key, async () => {
    const data = await recipientInsightsRepository.getRecipientPivot({
      excludedRecipientIds,
      targetCurrency,
      bucket,
      startDate,
      endDate,
      recipientIds,
    });
    assertNoNaN(data, 'computeRecipientPivot');
    return buildEnvelope(data, { source: 'live' });
  });
}

export default { computeRecipientPivot };
