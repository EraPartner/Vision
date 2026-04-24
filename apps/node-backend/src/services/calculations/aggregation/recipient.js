/**
 * Recipient insights aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getRecipientInsights. Reads
 * from mv_recipient_monthly (Phase 1) with a live current-month overlay to
 * capture today's transactions.
 */

import infoRepository from '../../../repositories/infoRepository.js';
import { buildEnvelope } from './_envelope.js';
import { assertNoNaN } from './_invariants.js';

export async function computeRecipientInsights({
  targetCurrency = 'EUR',
} = {}) {
  const data = await infoRepository.getRecipientInsights(targetCurrency);
  assertNoNaN(data, 'computeRecipientInsights');
  return buildEnvelope(data, { source: 'mv' });
}

export default { computeRecipientInsights };
