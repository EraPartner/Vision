/**
 * Tag pivot aggregation.
 *
 * Per-tag, per-period spending breakdown. Mirrors recipientPivot but grouped
 * by tag. Used by the custom charts feature for per-tag series rendering.
 */

import { tagInsightsRepository } from '../../../repositories/infoRepositoryTags.ts';
import type { TagPivotOptions } from '../../../repositories/infoRepositoryTags.ts';
import { buildEnvelope } from './_envelope.ts';
import { assertNoNaN } from './_invariants.ts';
import { withStatisticsCache, statsKeyPart } from './_statisticsCache.ts';

export async function computeTagPivot({
  targetCurrency = 'EUR',
  bucket = 'monthly',
  startDate = undefined,
  endDate = undefined,
  tagIds = undefined,
  allTags = false,
}: TagPivotOptions = {}) {
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
