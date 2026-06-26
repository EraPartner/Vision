/**
 * Tag pivot aggregation.
 *
 * Per-tag, per-period spending breakdown. Mirrors recipientPivot but grouped
 * by tag. Used by the custom charts feature for per-tag series rendering.
 */

import { tagInsightsRepository } from '../../../repositories/infoRepositoryTags.js';
import { buildEnvelope } from './_envelope.js';

export async function computeTagPivot({
  targetCurrency = 'EUR',
  bucket = 'monthly',
  startDate = null,
  endDate = null,
  tagIds = null,
} = {}) {
  const data = await tagInsightsRepository.getTagPivot(targetCurrency, {
    bucket,
    startDate,
    endDate,
    tagIds,
  });
  return buildEnvelope(data, { source: 'live' });
}

export default { computeTagPivot };
