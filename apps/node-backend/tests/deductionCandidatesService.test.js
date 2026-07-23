import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repositories/transactionRepository.js', () => ({
  transactionRepository: {
    getAll: vi.fn(),
  },
}));

import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { computeDeductionCandidates } from '../src/services/tax/deductionCandidatesService.js';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('computeDeductionCandidates', () => {
  it('queries the year window for active transactions', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);

    await computeDeductionCandidates({ year: 2025 });

    expect(transactionRepository.getAll).toHaveBeenCalledWith({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      limit: 100_000,
      offset: 0,
      active: true,
    });
  });

  it('classifies outflows, nests categories under types and rolls up totals', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-90', category_name: 'PENSION:SAVINGS' },
      { amount: '-30', category_name: 'PENSION:SAVINGS' },
      { amount: '-200', category_name: 'GIVING:DONATION' },
      { amount: '-75', category_name: 'INSURANCE:LIFE' },
      { amount: '-25', category_name: 'PENSIOENSPAREN' }, // NL, same type other category
    ]);

    const result = await computeDeductionCandidates({ year: 2025 });

    expect(result).toEqual({
      year: 2025,
      from: '2025-01-01',
      to: '2025-12-31',
      currency: 'EUR',
      byDeductionType: [
        {
          deductionType: 'charitableDonations',
          total: 200,
          categoryCount: 1,
          categories: [{ category: 'GIVING:DONATION', total: 200, count: 1 }],
        },
        {
          deductionType: 'pensionSavings',
          total: 145,
          categoryCount: 2,
          // Nested contributors sorted by total desc.
          categories: [
            { category: 'PENSION:SAVINGS', total: 120, count: 2 },
            { category: 'PENSIOENSPAREN', total: 25, count: 1 },
          ],
        },
        {
          deductionType: 'lifeInsurance',
          total: 75,
          categoryCount: 1,
          categories: [{ category: 'INSURANCE:LIFE', total: 75, count: 1 }],
        },
      ],
    });
  });

  it('excludes non-deductible categories, inflows and unlabeled rows', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-40', category_name: 'GIVING:DONATION' },
      { amount: '-500', category_name: 'INSURANCE:CAR' },  // not deductible, skip
      { amount: '-100', category_name: 'health:medical' }, // not deductible, skip
      { amount: '-40', category_name: 'GIFTS:BIRTHDAY' },  // present, not donation, skip
      { amount: '100', category_name: 'GIVING:DONATION' }, // inflow, skip
      { amount: '-60', category_name: null },              // no label, skip
    ]);

    const result = await computeDeductionCandidates({ year: 2025 });

    expect(result.byDeductionType).toEqual([
      {
        deductionType: 'charitableDonations',
        total: 40,
        categoryCount: 1,
        categories: [{ category: 'GIVING:DONATION', total: 40, count: 1 }],
      },
    ]);
  });

  it('returns an empty byDeductionType when nothing classifies', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-10', category_name: 'food:coffee' },
      { amount: '-300', category_name: 'INSURANCE:CAR' },
    ]);

    const result = await computeDeductionCandidates({ year: 2024 });

    expect(result).toEqual({
      year: 2024,
      from: '2024-01-01',
      to: '2024-12-31',
      currency: 'EUR',
      byDeductionType: [],
    });
  });
});
