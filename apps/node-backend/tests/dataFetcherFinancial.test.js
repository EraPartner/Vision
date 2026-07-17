import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';
// fetchFinancialData used to fetch all seven data sources regardless of which
// report sections were requested. These tests pin that it now only fetches the
// sources the requested sections render from, and still fetches everything when
// no section filter is passed (default behaviour).

vi.mock('../src/services/calculations/aggregation/monthly.js', () => ({
  computeMonthlySummary: vi.fn().mockResolvedValue({ data: { months: [], summary: {} } }),
}));
vi.mock('../src/services/calculations/aggregation/category.js', () => ({
  computeCategoryBreakdown: vi.fn().mockResolvedValue({ data: { categories: [] } }),
}));
vi.mock('../src/services/calculations/aggregation/recipient.js', () => ({
  computeRecipientInsights: vi.fn().mockResolvedValue({ data: { topMerchants: [], monthOverMonth: [] } }),
}));
vi.mock('../src/services/calculations/aggregation/bankBalances.js', () => ({
  computeBankBalances: vi.fn().mockResolvedValue({ data: { accounts: [] } }),
}));
vi.mock('../src/services/calculations/aggregation/averageVsCurrent.js', () => ({
  computeAverageVsCurrent: vi.fn().mockResolvedValue({ data: {} }),
}));
vi.mock('../src/repositories/infoRepository.js', () => ({
  default: { getPlannedExpensesNextMonth: vi.fn().mockResolvedValue({ summary: {}, daily_data: [] }) },
}));
vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { computeMonthlySummary } from '../src/services/calculations/aggregation/monthly.js';
import { computeCategoryBreakdown } from '../src/services/calculations/aggregation/category.js';
import { computeRecipientInsights } from '../src/services/calculations/aggregation/recipient.js';
import { computeBankBalances } from '../src/services/calculations/aggregation/bankBalances.js';
import { computeAverageVsCurrent } from '../src/services/calculations/aggregation/averageVsCurrent.js';
import infoRepository from '../src/repositories/infoRepository.js';
import { fetchFinancialData } from '../src/services/reports/dataFetcher.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchFinancialData only fetches sources for requested sections', () => {
  it('skips every source not rendered by the requested sections', async () => {
    const data = await fetchFinancialData('EUR', { sections: ['bankBalances'] });

    // Only bank balances is requested.
    expect(computeBankBalances).toHaveBeenCalledTimes(1);
    // Unrequested sources are not fetched.
    expect(computeMonthlySummary).not.toHaveBeenCalled();
    expect(computeCategoryBreakdown).not.toHaveBeenCalled();
    expect(computeRecipientInsights).not.toHaveBeenCalled();
    expect(computeAverageVsCurrent).not.toHaveBeenCalled();
    expect(infoRepository.getPlannedExpensesNextMonth).not.toHaveBeenCalled();

    // Skipped sources resolve to null (renderers handle null).
    expect(data.categories).toBeNull();
    expect(data.banks).toEqual({ accounts: [] });
  });

  it('fetches all sources when no section filter is passed (default)', async () => {
    await fetchFinancialData('EUR');

    expect(computeMonthlySummary).toHaveBeenCalledTimes(1);
    expect(computeCategoryBreakdown).toHaveBeenCalledTimes(1);
    expect(computeRecipientInsights).toHaveBeenCalledTimes(1);
    expect(computeBankBalances).toHaveBeenCalledTimes(1);
    expect(computeAverageVsCurrent).toHaveBeenCalledTimes(1);
    expect(infoRepository.getPlannedExpensesNextMonth).toHaveBeenCalledTimes(1);
  });
});
