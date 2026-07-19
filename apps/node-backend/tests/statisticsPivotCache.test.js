import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/repositories/infoRepository.js', () => ({
  default: {
    getCategoryPivot: vi.fn(),
    getRecipientByYear: vi.fn(),
  },
}));

import infoRepository from '../src/repositories/infoRepository.js';
import { computeCategoryPivot } from '../src/services/calculations/aggregation/categoryPivot.js';
import { computeRecipientByYear } from '../src/services/calculations/aggregation/recipientByYear.js';
import { statsKeyPart } from '../src/services/calculations/aggregation/_statisticsCache.js';
import { invalidateStatisticsCaches } from '../src/routes/info/_cache.js';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateStatisticsCaches(); // module-scoped cache is shared across tests
  infoRepository.getCategoryPivot.mockResolvedValue([{ category_id: 1, total: 10 }]);
  infoRepository.getRecipientByYear.mockResolvedValue([{ recipient_id: 1, total: 10 }]);
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
