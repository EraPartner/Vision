import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/repositories/infoRepository.js', () => ({
  default: {
    getCategoryPivot: vi.fn(),
    getRecipientByYear: vi.fn(),
  },
}));

vi.mock('../src/repositories/infoRepositoryRecipients.js', () => ({
  recipientInsightsRepository: { getRecipientPivot: vi.fn() },
}));

vi.mock('../src/repositories/infoRepositoryTags.js', () => ({
  tagInsightsRepository: { getTagPivot: vi.fn() },
}));

import infoRepository from '../src/repositories/infoRepository.js';
import { recipientInsightsRepository } from '../src/repositories/infoRepositoryRecipients.js';
import { tagInsightsRepository } from '../src/repositories/infoRepositoryTags.js';
import { computeCategoryPivot } from '../src/services/calculations/aggregation/categoryPivot.js';
import { computeRecipientByYear } from '../src/services/calculations/aggregation/recipientByYear.js';
import { computeRecipientPivot } from '../src/services/calculations/aggregation/recipientPivot.js';
import { computeTagPivot } from '../src/services/calculations/aggregation/tagPivot.js';
import { statsKeyPart } from '../src/services/calculations/aggregation/_statisticsCache.js';
import { invalidateStatisticsCaches } from '../src/routes/info/_cache.js';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateStatisticsCaches(); // module-scoped cache is shared across tests
  infoRepository.getCategoryPivot.mockResolvedValue([{ category_id: 1, total: 10 }]);
  infoRepository.getRecipientByYear.mockResolvedValue([{ recipient_id: 1, total: 10 }]);
  recipientInsightsRepository.getRecipientPivot.mockResolvedValue([{ recipient_id: 1, m: '2026-01', total: 10 }]);
  tagInsightsRepository.getTagPivot.mockResolvedValue([{ tag_id: 1, m: '2026-01', total: 10 }]);
});

describe('statistics pivot cache', () => {
  it('serves a repeat call from cache without re-hitting the repository', async () => {
    const a = await computeCategoryPivot({ targetCurrency: 'EUR' });
    const b = await computeCategoryPivot({ targetCurrency: 'EUR' });
    expect(a).toEqual(b);
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(1);
  });

  it('keys on the arguments — different exclusions recompute', async () => {
    await computeCategoryPivot({ targetCurrency: 'EUR', excludedCategoryIds: [1] });
    await computeCategoryPivot({ targetCurrency: 'EUR', excludedCategoryIds: [2] });
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(2);
  });

  it('keys on currency — a different target currency recomputes', async () => {
    await computeCategoryPivot({ targetCurrency: 'EUR' });
    await computeCategoryPivot({ targetCurrency: 'USD' });
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(2);
  });

  it('invalidateStatisticsCaches() forces the next call to recompute', async () => {
    await computeCategoryPivot({ targetCurrency: 'EUR' });
    invalidateStatisticsCaches();
    await computeCategoryPivot({ targetCurrency: 'EUR' });
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(2);
  });

  it('recipient pivot caches, and keys on bucket/date/id params', async () => {
    const base = { targetCurrency: 'EUR', bucket: 'monthly', startDate: '2026-01-01', endDate: '2026-06-30' };
    await computeRecipientPivot(base);
    await computeRecipientPivot(base); // cache hit
    expect(recipientInsightsRepository.getRecipientPivot).toHaveBeenCalledTimes(1);
    await computeRecipientPivot({ ...base, bucket: 'yearly' }); // different bucket → miss
    await computeRecipientPivot({ ...base, recipientIds: [5] }); // different ids → miss
    expect(recipientInsightsRepository.getRecipientPivot).toHaveBeenCalledTimes(3);
  });

  it('tag pivot caches, and keys on allTags/date params', async () => {
    const base = { targetCurrency: 'EUR', bucket: 'monthly', startDate: '2026-01-01' };
    await computeTagPivot(base);
    await computeTagPivot(base); // cache hit
    expect(tagInsightsRepository.getTagPivot).toHaveBeenCalledTimes(1);
    await computeTagPivot({ ...base, allTags: true }); // different allTags → miss
    expect(tagInsightsRepository.getTagPivot).toHaveBeenCalledTimes(2);
  });

  it('does not collide across endpoints sharing the cache map', async () => {
    await computeCategoryPivot({ targetCurrency: 'EUR' });
    await computeRecipientByYear({ targetCurrency: 'EUR' });
    // Distinct key prefixes → both compute despite the shared Map.
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(1);
    expect(infoRepository.getRecipientByYear).toHaveBeenCalledTimes(1);
  });

  it('an in-flight call is deduped (concurrent identical requests share one load)', async () => {
    let resolveLoad;
    infoRepository.getCategoryPivot.mockReturnValue(new Promise((r) => { resolveLoad = r; }));
    const p1 = computeCategoryPivot({ targetCurrency: 'EUR' });
    const p2 = computeCategoryPivot({ targetCurrency: 'EUR' });
    resolveLoad([{ category_id: 1, total: 10 }]);
    await Promise.all([p1, p2]);
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(1);
  });
});

describe('statsKeyPart', () => {
  it('is order-independent and treats empty/null/undefined alike', () => {
    expect(statsKeyPart([2, 1, 3])).toBe('1,2,3');
    expect(statsKeyPart([])).toBe('');
    expect(statsKeyPart(null)).toBe('');
    expect(statsKeyPart(undefined)).toBe('');
  });
});
