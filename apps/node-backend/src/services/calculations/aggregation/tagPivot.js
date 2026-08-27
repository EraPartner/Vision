/**
 * Tag pivot aggregation.
 *
 * Per-tag, per-period spending breakdown. Mirrors recipientPivot but grouped
 * by tag. Used by the custom charts feature for per-tag series rendering.
 */

import { tagInsightsRepository } from '../../../repositories/infoRepositoryTags.js';
import { buildEnvelope } from './_envelope.js';
import { assertNoNaN } from './_invariants.js';
import { withStatisticsCache, statsKeyPart } from './_statisticsCache.js';

/**
 * @param {{ targetCurrency?: string, bucket?: string, startDate?: string|null, endDate?: string|null, tagIds?: number[]|null, allTags?: boolean }} [opts]
 */
export async function computeTagPivot({
  targetCurrency = 'EUR',
  bucket = 'monthly',
  startDate = undefined,
  endDate = undefined,
  tagIds = undefined,
  allTags = false,
} = {}) {
  const key = `tag|${targetCurrency}|b:${bucket}|s:${startDate || ''}|e:${endDate || ''}`
    + `|ti:${statsKeyPart(tagIds)}|all:${allTags ? 1 : 0}`;
  return withStatisticsCache(key, async () => {
    const data = await tagInsightsRepository.getTagPivot({
      targetCurrency,
      bucket,
      startDate,
      endDate,
      tagIds,
      allTags,
    });
    assertNoNaN(data, 'computeTagPivot');
    return buildEnvelope(data, { source: 'live' });
  });
}

export default { computeTagPivot };
