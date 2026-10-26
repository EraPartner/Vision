import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockLogger } from './helpers/mockLogger.ts';
// fetchFinancialData used to fetch all seven data sources regardless of which
// report sections were requested. These tests pin that it now only fetches the
// sources the requested sections render from, and still fetches everything when
// no section filter is passed (default behaviour).

vi.mock('../src/services/calculations/aggregation/monthly.ts', () => ({
  computeMonthlySummary: vi.fn().mockResolvedValue({ data: { months: [], summary: {} } }),
}));
vi.mock('../src/services/calculations/aggregation/category.ts', () => ({
  computeCategoryBreakdown: vi.fn().mockResolvedValue({ data: { categories: [] } }),
}));
vi.mock('../src/services/calculations/aggregation/recipient.ts', () => ({
  computeRecipientInsights: vi.fn().mockResolvedValue({ data: { topMerchants: [], monthOverMonth: [] } }),
}));
vi.mock('../src/services/calculations/aggregation/bankBalances.ts', () => ({
  computeBankBalances: vi.fn().mockResolvedValue({ data: { accounts: [] } }),
}));
vi.mock('../src/services/calculations/aggregation/averageVsCurrent.ts', () => ({
  computeAverageVsCurrent: vi.fn().mockResolvedValue({ data: {} }),
}));
vi.mock('../src/repositories/infoRepository.ts', () => ({
  default: { getPlannedExpensesNextMonth: vi.fn().mockResolvedValue({ summary: {}, daily_data: [] }) },
}));
vi.mock('../src/config/logger.ts', () => ({
  logger: mockLogger(),
}));

import { computeMonthlySummary } from '../src/services/calculations/aggregation/monthly.ts';
import { computeCategoryBreakdown } from '../src/services/calculations/aggregation/category.ts';
import { computeRecipientInsights } from '../src/services/calculations/aggregation/recipient.ts';
import { computeBankBalances } from '../src/services/calculations/aggregation/bankBalances.ts';
import { computeAverageVsCurrent } from '../src/services/calculations/aggregation/averageVsCurrent.ts';
import infoRepository from '../src/repositories/infoRepository.ts';
import { fetchFinancialData } from '../src/services/reports/dataFetcher.ts';
import { RowContractError } from '../src/database/rowContracts.ts';
import { loose } from "./helpers/partial.ts";
import type { Mock } from "vitest";

/** The given methods of `T`, typed as the spies a `vi.mock` factory installed. */
type Spies<T, K extends keyof T> = Record<
  K,
  Mock<Extract<T[K], (...args: never[]) => unknown>>
>;

const infoRepositoryMock = loose<Spies<typeof infoRepository, "getPlannedExpensesNextMonth">>(infoRepository);

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
    expect(infoRepositoryMock.getPlannedExpensesNextMonth).not.toHaveBeenCalled();

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
    expect(infoRepositoryMock.getPlannedExpensesNextMonth).toHaveBeenCalledTimes(1);
  });
});

describe('fetchFinancialData source failures', () => {
  it('fails the export when a requested source is unavailable', async () => {
    vi.mocked(computeBankBalances).mockRejectedValueOnce(new Error('offline'));
    await expect(fetchFinancialData('EUR', { sections: ['bankBalances'] })).rejects.toThrow('offline');
  });

  it('surfaces a row contract mismatch instead of skipping the section', async () => {
    vi.mocked(computeBankBalances).mockRejectedValueOnce(
      new RowContractError('Row contract violated (bank balance row)', ['balance: expected string']),
    );
    await expect(fetchFinancialData('EUR', { sections: ['bankBalances'] })).rejects.toBeInstanceOf(
      RowContractError,
    );
  });
});

it('applies exact dates and both exclusions before category and recipient aggregation', async () => {
  await fetchFinancialData('EUR', { period: { kind: 'custom', from: '2025-02-12', to: '2025-03-08' }, excludedCategoryIds: [10], excludedRecipientIds: [20], sections: ['executiveSummary', 'categoryBreakdown', 'topRecipients'] });
  const dates = { startDate: '2025-02-12', endDate: '2025-03-08' };
  for (const source of [computeMonthlySummary, computeCategoryBreakdown, computeRecipientInsights]) {
    expect(source).toHaveBeenCalledWith(expect.objectContaining(dates));
    expect(source).toHaveBeenCalledWith(expect.objectContaining({ ...dates, excludedCategoryIds: [10], excludedRecipientIds: [20] }));
  }
});
it('does not turn a failed monthly aggregate into zero income', async () => {
  vi.mocked(computeMonthlySummary).mockRejectedValueOnce(new Error('query failed'));
  await expect(fetchFinancialData('EUR', { sections: ['executiveSummary'] })).rejects.toThrow('query failed');
});
