import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repositories/transactionRepository.js', () => ({
  transactionRepository: {
    getAll: vi.fn(),
  },
}));

vi.mock('../src/repositories/investmentRepository.js', () => ({
  investmentRepository: {
    getAll: vi.fn(),
  },
}));

vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({
  portfolioTransactionRepository: {
    getAllByInvestmentIds: vi.fn(),
  },
}));

vi.mock('../src/repositories/plannedTransactionRepository.js', () => ({
  plannedTransactionRepository: {
    getAll: vi.fn(),
    getById: vi.fn(),
  },
}));

import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { investmentRepository } from '../src/repositories/investmentRepository.js';
import { portfolioTransactionRepository } from '../src/repositories/portfolioTransactionRepository.js';
import { plannedTransactionRepository } from '../src/repositories/plannedTransactionRepository.js';
import {
  getSpendByCategory,
  getMonthlySpend,
  getTopRecipients,
  getTransactionsInRange,
} from '../src/services/aiChat/tools/expenses.js';
import {
  getPortfolioHoldings,
  getReturnsForRange,
  getDividendIncome,
  getAssetAllocation,
} from '../src/services/aiChat/tools/portfolio.js';
import {
  getUpcomingPlanned,
  getSubscriptionTotal,
  getLoanSchedule,
} from '../src/services/aiChat/tools/planned.js';
import {
  getTaxableIncomeSummary,
  getCapitalGainsForYear,
  getDeductibles,
} from '../src/services/aiChat/tools/tax.js';
import { dispatchTool, getToolSchemas, getToolNames } from '../src/services/aiChat/tools/index.js';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getSpendByCategory', () => {
  it('sums negative amounts by category and sorts desc', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-120.50', category_name: 'Groceries', date: '2025-03-01' },
      { amount: '-45.00', category_name: 'Groceries', date: '2025-03-15' },
      { amount: '-300.00', category_name: 'Rent', date: '2025-03-01' },
      { amount: '500.00', category_name: 'Salary', date: '2025-03-28' }, // income, skip
      { amount: '-12.00', category_name: null, date: '2025-03-18' },     // uncategorised
    ]);

    const result = await getSpendByCategory.run({
      from: '2025-03-01',
      to: '2025-03-31',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      { category: 'Rent', total: 300, count: 1 },
      { category: 'Groceries', total: 165.5, count: 2 },
      { category: 'Uncategorised', total: 12, count: 1 },
    ]);
    expect(result.meta.rowsScanned).toBe(5);
    expect(result.meta.categoryCount).toBe(3);
    expect(result.meta.renderAs).toBe('bar');
  });

  it('applies topN limit', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-100', category_name: 'A', date: '2025-01-01' },
      { amount: '-90', category_name: 'B', date: '2025-01-01' },
      { amount: '-80', category_name: 'C', date: '2025-01-01' },
    ]);

    const result = await getSpendByCategory.run({
      from: '2025-01-01',
      to: '2025-01-31',
      topN: 2,
    });

    expect(result.data).toHaveLength(2);
    expect(result.data.map((d) => d.category)).toEqual(['A', 'B']);
  });

  it('rejects invalid date format', async () => {
    await expect(
      getSpendByCategory.run({ from: '03/01/2025', to: '2025-12-31' }),
    ).rejects.toThrow(/from must be an ISO date/);
  });

  it('rejects calendar-invalid date', async () => {
    await expect(
      getSpendByCategory.run({ from: '2025-13-45', to: '2025-12-31' }),
    ).rejects.toThrow(/from is not a valid date/);
  });

  it('rejects reversed date order', async () => {
    await expect(
      getSpendByCategory.run({ from: '2025-12-31', to: '2025-01-01' }),
    ).rejects.toThrow(/from.*must be on or before.*to/);
  });
});

describe('getMonthlySpend', () => {
  it('buckets by month with income/spend/net', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '1000', date: '2025-01-15' },
      { amount: '-200', date: '2025-01-20' },
      { amount: '-50', date: '2025-01-28' },
      { amount: '2000', date: '2025-02-01' },
      { amount: '-1500', date: '2025-02-25' },
    ]);

    const result = await getMonthlySpend.run({
      from: '2025-01-01',
      to: '2025-02-28',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      { bucket: '2025-01', income: 1000, spend: 250, net: 750, count: 3 },
      { bucket: '2025-02', income: 2000, spend: 1500, net: 500, count: 2 },
    ]);
    expect(result.meta.groupBy).toBe('month');
    expect(result.meta.renderAs).toBe('line');
  });

  it('buckets by quarter when requested', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-100', date: '2025-01-15' },
      { amount: '-200', date: '2025-04-10' },
      { amount: '-300', date: '2025-07-22' },
    ]);

    const result = await getMonthlySpend.run({
      from: '2025-01-01',
      to: '2025-12-31',
      groupBy: 'quarter',
    });

    expect(result.data.map((d) => d.bucket)).toEqual(['2025-Q1', '2025-Q2', '2025-Q3']);
  });

  it('rejects unknown groupBy', async () => {
    await expect(
      getMonthlySpend.run({ from: '2025-01-01', to: '2025-12-31', groupBy: 'weekly' }),
    ).rejects.toThrow(/groupBy must be one of/);
  });
});

describe('getPortfolioHoldings', () => {
  it('computes net units and market value per investment', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'VWCE', symbol: 'VWCE', asset_class: 'etf', currency: 'EUR', current_price: '100.00' },
      { id: 2, name: 'BTC', symbol: 'BTC', asset_class: 'crypto', currency: 'EUR', current_price: '50000.00' },
      { id: 3, name: 'Sold out', symbol: 'SO', asset_class: 'stock', currency: 'EUR', current_price: '10.00' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'buy', units: '10' },
      { investment_id: 1, type: 'buy', units: '5' },
      { investment_id: 1, type: 'sell', units: '3' },
      { investment_id: 2, type: 'buy', units: '0.5' },
      { investment_id: 3, type: 'buy', units: '100' },
      { investment_id: 3, type: 'sell', units: '100' },
    ]);

    const result = await getPortfolioHoldings.run({});

    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(2); // id:3 excluded (zero position)
    expect(result.data[0]).toMatchObject({
      name: 'BTC',
      units: 0.5,
      marketValue: 25000,
    });
    expect(result.data[1]).toMatchObject({
      name: 'VWCE',
      units: 12,
      marketValue: 1200,
    });
    expect(result.meta.renderAs).toBe('pie');
    expect(result.meta.totalPositions).toBe(2);
  });

  it('passes assetClass filter through to repository', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([]);

    await getPortfolioHoldings.run({ assetClass: 'stock' });

    expect(investmentRepository.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ assetClass: 'stock', active: true }),
    );
  });

  it('rejects unknown assetClass', async () => {
    await expect(
      getPortfolioHoldings.run({ assetClass: 'nft' }),
    ).rejects.toThrow(/assetClass must be one of/);
  });

  it('skips portfolio-transaction query when no active investments', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([]);

    const result = await getPortfolioHoldings.run({});

    expect(portfolioTransactionRepository.getAllByInvestmentIds).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
  });
});

describe('getTopRecipients', () => {
  it('sums outflows by recipient and sorts desc', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-50', recipient_name: 'Coffee Shop' },
      { amount: '-25', recipient_name: 'Coffee Shop' },
      { amount: '-400', recipient_name: 'Landlord' },
      { amount: '1000', recipient_name: 'Employer' }, // income skipped
      { amount: '-10', recipient_name: null },        // unknown
    ]);

    const result = await getTopRecipients.run({ from: '2025-01-01', to: '2025-01-31' });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      { recipient: 'Landlord', total: 400, count: 1 },
      { recipient: 'Coffee Shop', total: 75, count: 2 },
      { recipient: 'Unknown', total: 10, count: 1 },
    ]);
    expect(result.meta.recipientCount).toBe(3);
  });

  it('applies topN cap', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-100', recipient_name: 'A' },
      { amount: '-90', recipient_name: 'B' },
      { amount: '-80', recipient_name: 'C' },
    ]);

    const result = await getTopRecipients.run({ from: '2025-01-01', to: '2025-01-31', topN: 2 });

    expect(result.data).toHaveLength(2);
  });

  it('rejects missing from', async () => {
    await expect(
      getTopRecipients.run({ to: '2025-01-31' }),
    ).rejects.toThrow(/from is required/);
  });
});

describe('getTransactionsInRange', () => {
  it('shapes rows with date slice and fallback labels', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      {
        id: 1,
        date: '2025-03-10',
        amount: '-12.34',
        recipient_name: 'Store',
        category_name: 'Groceries',
        memo: 'eggs',
      },
      {
        id: 2,
        date: new Date('2025-03-11T00:00:00Z'),
        amount: '50',
        recipient_name: null,
        category_name: null,
        memo: null,
      },
    ]);

    const result = await getTransactionsInRange.run({ from: '2025-03-01', to: '2025-03-31' });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      { id: 1, date: '2025-03-10', amount: -12.34, recipient: 'Store', category: 'Groceries', memo: 'eggs' },
      { id: 2, date: '2025-03-11', amount: 50, recipient: 'Unknown', category: 'Uncategorised', memo: '' },
    ]);
    expect(result.meta.renderAs).toBe('table');
  });

  it('passes categoryId and recipientId through to repo', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);

    await getTransactionsInRange.run({
      from: '2025-01-01',
      to: '2025-01-31',
      categoryId: 7,
      recipientId: 42,
      limit: 20,
    });

    expect(transactionRepository.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: 7, recipientId: 42, limit: 20 }),
    );
  });

  it('rejects limit above 500', async () => {
    await expect(
      getTransactionsInRange.run({ from: '2025-01-01', to: '2025-01-31', limit: 1000 }),
    ).rejects.toThrow(/limit must be an integer between 1 and 500/);
  });
});

describe('getReturnsForRange', () => {
  it('aggregates income minus costs per investment, sorts by net desc', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'VWCE', symbol: 'VWCE', asset_class: 'etf', currency: 'EUR' },
      { id: 2, name: 'REIT', symbol: 'REIT', asset_class: 'real_estate', currency: 'EUR' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'dividend', amount: '20', fees: '0', taxes: '0', date: '2025-03-15' },
      { investment_id: 1, type: 'fee', amount: '5', fees: '0', taxes: '0', date: '2025-04-01' },
      { investment_id: 2, type: 'rent_income', amount: '500', fees: '0', taxes: '50', date: '2025-05-01' },
      { investment_id: 2, type: 'rent_income', amount: '500', fees: '0', taxes: '0', date: '2026-01-01' }, // out of range
    ]);

    const result = await getReturnsForRange.run({ from: '2025-01-01', to: '2025-12-31' });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({ name: 'REIT', income: 500, costs: 50, net: 450 }),
      expect.objectContaining({ name: 'VWCE', income: 20, costs: 5, net: 15 }),
    ]);
    expect(result.meta.renderAs).toBe('bar');
  });

  it('rejects unknown assetClass', async () => {
    await expect(
      getReturnsForRange.run({ from: '2025-01-01', to: '2025-12-31', assetClass: 'nft' }),
    ).rejects.toThrow(/assetClass must be one of/);
  });
});

describe('getDividendIncome', () => {
  it('sums dividend payments per investment and totals', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'VWCE', symbol: 'VWCE', asset_class: 'etf', currency: 'EUR' },
      { id: 2, name: 'NoDiv', symbol: 'X', asset_class: 'etf', currency: 'EUR' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, amount: '12.50', date: '2025-03-01' },
      { investment_id: 1, amount: '7.50', date: '2025-06-01' },
      { investment_id: 1, amount: '99', date: '2024-12-31' }, // out of range
    ]);

    const result = await getDividendIncome.run({ from: '2025-01-01', to: '2025-12-31' });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({ name: 'VWCE', total: 20, payments: 2 }),
    ]);
    expect(result.meta.grandTotal).toBe(20);
    expect(result.meta.payingPositions).toBe(1);
  });

  it('queries portfolio repo with type=dividend', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([{ id: 1 }]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([]);

    await getDividendIncome.run({ from: '2025-01-01', to: '2025-12-31' });

    expect(portfolioTransactionRepository.getAllByInvestmentIds).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dividend' }),
    );
  });
});

describe('getAssetAllocation', () => {
  it('groups holdings by asset class with percentages', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'A', asset_class: 'etf', current_price: '100' },
      { id: 2, name: 'B', asset_class: 'crypto', current_price: '50000' },
      { id: 3, name: 'C', asset_class: 'etf', current_price: '10' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'buy', units: '10' },   // 1000
      { investment_id: 2, type: 'buy', units: '0.5' },  // 25000
      { investment_id: 3, type: 'buy', units: '50' },   // 500 → etf bucket 1500
    ]);

    const result = await getAssetAllocation.run({});

    expect(result.ok).toBe(true);
    expect(result.data[0]).toMatchObject({ assetClass: 'crypto', marketValue: 25000, positions: 1 });
    expect(result.data[1]).toMatchObject({ assetClass: 'etf', marketValue: 1500, positions: 2 });
    const cryptoPct = result.data[0].percent;
    const etfPct = result.data[1].percent;
    expect(cryptoPct + etfPct).toBeCloseTo(100, 1);
    expect(result.meta.renderAs).toBe('pie');
  });

  it('returns empty when no holdings', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([]);

    const result = await getAssetAllocation.run({});

    expect(result.data).toEqual([]);
    expect(result.meta.grandTotal).toBe(0);
  });
});

describe('getUpcomingPlanned', () => {
  it('shapes repo items, sorts by date', async () => {
    plannedTransactionRepository.getAll.mockResolvedValueOnce({
      items: [
        {
          id: 2,
          planned_date: '2025-04-15',
          amount: '-50',
          recipient_name: 'Netflix',
          category_name: 'subscriptions',
          memo: '',
          is_recurring: true,
          recurrence_pattern: 'monthly',
          is_loan: false,
        },
        {
          id: 1,
          planned_date: '2025-04-10',
          amount: '-800',
          recipient_name: 'Landlord',
          category_name: 'housing',
          memo: 'rent',
          is_recurring: true,
          recurrence_pattern: 'monthly',
          is_loan: false,
        },
      ],
    });

    const result = await getUpcomingPlanned.run({ horizonDays: 60 });

    expect(result.ok).toBe(true);
    expect(result.data.map((d) => d.id)).toEqual([1, 2]);
    expect(result.meta.horizonDays).toBe(60);
    expect(result.meta.count).toBe(2);
  });

  it('rejects horizonDays above 365', async () => {
    await expect(
      getUpcomingPlanned.run({ horizonDays: 1000 }),
    ).rejects.toThrow(/horizonDays must be an integer between 1 and 365/);
  });
});

describe('getSubscriptionTotal', () => {
  it('normalizes negative recurring outflows to monthly', async () => {
    plannedTransactionRepository.getAll.mockResolvedValueOnce({
      items: [
        { id: 1, amount: '-10', recurrence_pattern: 'monthly', recipient_name: 'Spotify' },
        { id: 2, amount: '-120', recurrence_pattern: 'yearly', recipient_name: 'Domain' }, // /12 = 10
        { id: 3, amount: '500', recurrence_pattern: 'monthly', recipient_name: 'Salary' }, // income skipped
        { id: 4, amount: '-5', recurrence_pattern: 'unknown', recipient_name: 'Odd' },     // pattern skipped
      ],
    });

    const result = await getSubscriptionTotal.run({});

    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({ recipient: 'Spotify', normalizedAmount: 10 });
    expect(result.data[1]).toMatchObject({ recipient: 'Domain', normalizedAmount: 10 });
    expect(result.meta.total).toBe(20);
    expect(result.meta.period).toBe('monthly');
  });

  it('multiplies by 12 when period is yearly', async () => {
    plannedTransactionRepository.getAll.mockResolvedValueOnce({
      items: [
        { id: 1, amount: '-10', recurrence_pattern: 'monthly', recipient_name: 'Sub' },
      ],
    });

    const result = await getSubscriptionTotal.run({ period: 'yearly' });

    expect(result.data[0].normalizedAmount).toBe(120);
    expect(result.meta.period).toBe('yearly');
  });

  it('rejects unknown period', async () => {
    await expect(
      getSubscriptionTotal.run({ period: 'daily' }),
    ).rejects.toThrow(/period must be one of/);
  });
});

describe('getLoanSchedule', () => {
  it('shapes loan_schedule for a loan row', async () => {
    plannedTransactionRepository.getById.mockResolvedValueOnce({
      id: 9,
      is_loan: true,
      loan_type: 'mortgage',
      loan_principal: '100000',
      loan_annual_interest_rate: 3.5,
      loan_term_months: 240,
      loan_schedule: [
        {
          installment_number: 1,
          due_date: '2025-04-01',
          payment_amount: '580',
          principal_amount: '291.67',
          interest_amount: '288.33',
          remaining_principal: '99708.33',
        },
      ],
    });

    const result = await getLoanSchedule.run({ plannedId: 9 });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      {
        installment: 1,
        dueDate: '2025-04-01',
        payment: 580,
        principal: 291.67,
        interest: 288.33,
        remainingPrincipal: 99708.33,
      },
    ]);
    expect(result.meta.loanType).toBe('mortgage');
    expect(result.meta.renderAs).toBe('table');
  });

  it('returns ok:false when planned transaction is not a loan', async () => {
    plannedTransactionRepository.getById.mockResolvedValueOnce({ id: 5, is_loan: false });

    const result = await getLoanSchedule.run({ plannedId: 5 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a loan/);
  });

  it('returns ok:false when planned transaction is missing', async () => {
    plannedTransactionRepository.getById.mockResolvedValueOnce(null);

    const result = await getLoanSchedule.run({ plannedId: 999 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('rejects non-positive plannedId', async () => {
    await expect(
      getLoanSchedule.run({ plannedId: 0 }),
    ).rejects.toThrow(/plannedId must be an integer/);
  });
});

describe('getTaxableIncomeSummary', () => {
  it('sums transaction income + portfolio income buckets by year', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '1000', date: '2025-02-01' },  // income
      { amount: '-200', date: '2025-02-05' },  // outflow, ignored
      { amount: '500', date: '2025-11-15' },   // income
    ]);
    investmentRepository.getAll.mockResolvedValueOnce([{ id: 1 }]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'dividend', amount: '30', date: '2025-03-01' },
      { investment_id: 1, type: 'interest', amount: '10', date: '2025-06-01' },
      { investment_id: 1, type: 'rent_income', amount: '200', date: '2025-09-01' },
      { investment_id: 1, type: 'appreciation', amount: '50', date: '2025-12-31' },
      { investment_id: 1, type: 'sell', amount: '999', date: '2025-06-01' }, // not an income bucket, ignored
      { investment_id: 1, type: 'dividend', amount: '999', date: '2024-12-31' }, // out of range
    ]);

    const result = await getTaxableIncomeSummary.run({ year: 2025 });

    expect(result.ok).toBe(true);
    const byLabel = Object.fromEntries(result.data.map((r) => [r.source, r.amount]));
    expect(byLabel['Transaction income (gross)']).toBe(1500);
    expect(byLabel['Dividends']).toBe(30);
    expect(byLabel['Interest']).toBe(10);
    expect(byLabel['Rent income']).toBe(200);
    expect(byLabel['Appreciation (realized)']).toBe(50);
    expect(result.meta.grossTotal).toBe(1790);
    expect(result.meta.disclaimer).toMatch(/Approximation only/);
  });

  it('rejects year out of range', async () => {
    await expect(getTaxableIncomeSummary.run({ year: 999 })).rejects.toThrow(/year must be an integer/);
  });
});

describe('getCapitalGainsForYear', () => {
  it('groups sell proceeds by investment and totals taxes', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'VWCE', symbol: 'VWCE', asset_class: 'etf', currency: 'EUR' },
      { id: 2, name: 'BTC', symbol: 'BTC', asset_class: 'crypto', currency: 'EUR' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'sell', amount: '2000', taxes: '50', fees: '5', date: '2025-05-01' },
      { investment_id: 1, type: 'sell', amount: '1000', taxes: '25', fees: '2', date: '2025-09-01' },
      { investment_id: 2, type: 'sell', amount: '500', taxes: '0', fees: '1', date: '2025-11-11' },
      { investment_id: 2, type: 'sell', amount: '999', taxes: '0', fees: '0', date: '2024-12-31' }, // out of range
    ]);

    const result = await getCapitalGainsForYear.run({ year: 2025 });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({ name: 'VWCE', proceeds: 3000, taxesPaid: 75, feesPaid: 7, sellCount: 2 }),
      expect.objectContaining({ name: 'BTC', proceeds: 500, taxesPaid: 0, feesPaid: 1, sellCount: 1 }),
    ]);
    expect(result.meta.totalProceeds).toBe(3500);
    expect(result.meta.totalTaxesPaid).toBe(75);
    expect(result.meta.disclaimer).toMatch(/not a realized gain/);
  });

  it('filters portfolio repo to sell type', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([{ id: 1 }]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([]);

    await getCapitalGainsForYear.run({ year: 2025 });

    expect(portfolioTransactionRepository.getAllByInvestmentIds).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sell' }),
    );
  });
});

describe('getDeductibles', () => {
  it('keeps outflows whose category matches a deductible keyword', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-100', category_name: 'health:medical' },
      { amount: '-50', category_name: 'health:medical' },
      { amount: '-200', category_name: 'giving:donation' },
      { amount: '-30', category_name: 'food:lunch' },         // no keyword, skip
      { amount: '100', category_name: 'giving:donation' },    // inflow, skip
      { amount: '-60', category_name: null },                 // no label, skip
    ]);

    const result = await getDeductibles.run({ year: 2025 });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      { category: 'giving:donation', total: 200, count: 1 },
      { category: 'health:medical', total: 150, count: 2 },
    ]);
    expect(result.meta.grandTotal).toBe(350);
    expect(result.meta.matchedKeywords).toContain('medical');
    expect(result.meta.disclaimer).toMatch(/keyword heuristic/);
  });

  it('returns empty list when nothing matches', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-10', category_name: 'food:coffee' },
    ]);

    const result = await getDeductibles.run({ year: 2025 });

    expect(result.data).toEqual([]);
    expect(result.meta.grandTotal).toBe(0);
  });
});

describe('dispatchTool', () => {
  it('returns UNKNOWN_TOOL for unregistered name', async () => {
    const result = await dispatchTool('doesNotExist', {});
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNKNOWN_TOOL');
    expect(result.error.availableTools).toContain('getSpendByCategory');
  });

  it('returns VALIDATION_ERROR when args fail validation', async () => {
    const result = await dispatchTool('getSpendByCategory', { from: 'bad' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('from');
  });

  it('parses arguments from a JSON string', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);

    const result = await dispatchTool(
      'getSpendByCategory',
      JSON.stringify({ from: '2025-01-01', to: '2025-01-31' }),
    );

    expect(result.ok).toBe(true);
    expect(transactionRepository.getAll).toHaveBeenCalled();
  });

  it('rejects malformed JSON argument string', async () => {
    const result = await dispatchTool('getSpendByCategory', '{not valid json');
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('treats null arguments as empty object', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([]);

    const result = await dispatchTool('getPortfolioHoldings', null);

    expect(result.ok).toBe(true);
  });

  it('getToolSchemas returns OpenAI-compatible function definitions', () => {
    const schemas = getToolSchemas();
    expect(schemas.length).toBeGreaterThanOrEqual(3);
    for (const s of schemas) {
      expect(s.type).toBe('function');
      expect(s.function.name).toBeTruthy();
      expect(s.function.parameters).toBeTruthy();
    }
  });

  it('getToolNames lists registered tools', () => {
    const names = getToolNames();
    expect(names).toEqual(expect.arrayContaining([
      'getSpendByCategory',
      'getMonthlySpend',
      'getPortfolioHoldings',
    ]));
  });
});

describe('tool write-method denylist', () => {
  const toolsDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../src/services/aiChat/tools',
  );
  const toolFiles = ['expenses.js', 'portfolio.js', 'planned.js', 'tax.js', 'insights.js'];

  const BANNED_CALL_PATTERNS = [
    /\bcreate\s*\(/,
    /\bupdate\s*\(/,
    /\bdelete\s*\(/,
    /\bbulk\s*\(/,
    /\bupsert\s*\(/,
    /\binsert\s*\(/,
  ];

  const BANNED_IMPORT_PATTERN = /database\/connection/;

  for (const file of toolFiles) {
    it(`${file} contains no write-method calls`, () => {
      const source = readFileSync(resolve(toolsDir, file), 'utf8');
      for (const pattern of BANNED_CALL_PATTERNS) {
        expect(
          pattern.test(source),
          `${file} matched banned pattern ${pattern}`,
        ).toBe(false);
      }
    });

    it(`${file} does not import pg pool directly`, () => {
      const source = readFileSync(resolve(toolsDir, file), 'utf8');
      expect(
        BANNED_IMPORT_PATTERN.test(source),
        `${file} imports directly from database/connection`,
      ).toBe(false);
    });
  }
});
