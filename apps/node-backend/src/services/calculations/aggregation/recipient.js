/**
 * Recipient insights aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getRecipientInsights, which
 * serves a live scan of `transactions` (it does NOT read mv_recipient_monthly).
 * The envelope is tagged accordingly, matching its recipientPivot/recipientByYear
 * siblings.
 */

import infoRepository from '../../../repositories/infoRepository.js';
import { buildEnvelope } from './_envelope.js';
import { assertNoNaN } from './_invariants.js';

export async function computeRecipientInsights({
  targetCurrency = 'EUR',
  excludedCategoryIds = [],
  excludedRecipientIds = [],
} = {}) {
  const data = await infoRepository.getRecipientInsights(targetCurrency, {
    excludedCategoryIds,
    excludedRecipientIds,
  });
  assertNoNaN(data, 'computeRecipientInsights');
  return buildEnvelope(data, { source: 'live' });
}

export default { computeRecipientInsights };
