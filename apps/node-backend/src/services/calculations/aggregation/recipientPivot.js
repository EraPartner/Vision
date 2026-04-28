/**
 * Recipient pivot aggregation.
 *
 * Per-recipient, per-period spending breakdown. Mirrors categoryPivot but
 * grouped by recipient. Used by the custom charts feature for mixed
 * category+recipient series rendering.
 */

import { recipientInsightsRepository } from '../../../repositories/infoRepositoryRecipients.js';
import { buildEnvelope } from './_envelope.js';

export async function computeRecipientPivot({
  targetCurrency = 'EUR',
  excludedRecipientIds = [],
  bucket = 'monthly',
  startDate = null,
  endDate = null,
} = {}) {
  const data = await recipientInsightsRepository.getRecipientPivot(
    excludedRecipientIds,
    targetCurrency,
    { bucket, startDate, endDate }
  );
  return buildEnvelope(data, { source: 'live' });
}

export default { computeRecipientPivot };
