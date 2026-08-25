import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repositories/investmentRepository.js', () => ({
  investmentRepository: { getAll: vi.fn() },
}));

vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({
  portfolioTransactionRepository: { getAllByInvestmentIds: vi.fn() },
}));

vi.mock('../src/repositories/plannedTransactionRepository.js', () => ({
  plannedTransactionRepository: { getAll: vi.fn(), getById: vi.fn() },
}));

vi.mock('../src/repositories/infoRepository.js', () => ({
  infoRepository: { getBankBalances: vi.fn() },
}));

import { investmentRepository } from '../src/repositories/investmentRepository.js';
import { portfolioTransactionRepository } from '../src/repositories/portfolioTransactionRepository.js';
import { plannedTransactionRepository } from '../src/repositories/plannedTransactionRepository.js';
import { infoRepository } from '../src/repositories/infoRepository.js';
import {
  getUnrealizedGains,
  getBestWorstPerformers,
} from '../src/services/aiChat/tools/portfolio.js';
import { getProjectedBalance } from '../src/services/aiChat/tools/planned.js';

beforeEach(() => vi.resetAllMocks());

describe('getUnrealizedGains', () => {
  it('computes cost basis, market value, and gain percent per investment', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'Apple', symbol: 'AAPL', asset_class: 'stock', currency: 'USD', current_price: '200' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'buy', units: '5', price_per_unit: '100', amount: '-500' },
      { investment_id: 1, type: 'buy', units: '5', price_per_unit: '120', amount: '-600' },
    ]);

    const r = await getUnrealizedGains.run({});
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({
      id: 1,
      name: 'Apple',
      assetClass: 'stock',
      units: 10,
      costBasis: 1100,
      marketValue: 2000,
      unrealizedGain: 900,
      gainPercent: 81.82,
    });
  });

  it('skips investments with zero or negative net units', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'Sold', asset_class: 'stock', current_price: '100' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'buy', units: '5', price_per_unit: '50' },
      { investment_id: 1, type: 'sell', units: '5', price_per_unit: '80' },
    ]);

    const r = await getUnrealizedGains.run({});
    expect(r.data).toEqual([]);
  });

  it('returns null gainPercent when cost basis is zero (gifted shares)', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'Gift', asset_class: 'stock', current_price: '50' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'buy', units: '10', price_per_unit: '0' },
    ]);
    const r = await getUnrealizedGains.run({});
    expect(r.data[0].gainPercent).toBeNull();
  });

  it('ignores an impossible amount_per_unit fallback when price_per_unit is absent', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'Gift', asset_class: 'stock', current_price: '50' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'buy', units: '2', price_per_unit: null, amount_per_unit: '999' },
    ]);

    const r = await getUnrealizedGains.run({});

    expect(r.data[0]).toMatchObject({ costBasis: 0, marketValue: 100, unrealizedGain: 100, gainPercent: null });
  });

  it('passes assetClass filter through to the repository', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([]);
    await getUnrealizedGains.run({ assetClass: 'crypto' });
    expect(investmentRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({ assetClass: 'crypto' }));
  });

  it('returns empty when no investments active', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([]);
    const r = await getUnrealizedGains.run({});
    expect(r.data).toEqual([]);
    expect(portfolioTransactionRepository.getAllByInvestmentIds).not.toHaveBeenCalled();
  });

  it('rejects unknown asset class', async () => {
    await expect(getUnrealizedGains.run({ assetClass: 'magic' })).rejects.toThrow(/assetClass/);
  });

  it('sorts results by unrealizedGain descending', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'A', asset_class: 'stock', current_price: '100' },
      { id: 2, name: 'B', asset_class: 'stock', current_price: '300' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'buy', units: '1', price_per_unit: '50' },
      { investment_id: 2, type: 'buy', units: '1', price_per_unit: '100' },
    ]);

    const r = await getUnrealizedGains.run({});
    expect(r.data[0].id).toBe(2); // gain 200 > 50
  });
});

describe('getBestWorstPerformers', () => {
  it('ranks investments by net cashflow returns', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'Apple', symbol: 'AAPL', asset_class: 'stock' },
      { id: 2, name: 'Tesla', symbol: 'TSLA', asset_class: 'stock' },
      { id: 3, name: 'BTC', symbol: 'BTC', asset_class: 'crypto' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'dividend', amount: '100', date: '2025-04-01', fees: 0, taxes: 0 },
      { investment_id: 2, type: 'fee', amount: '50', date: '2025-04-01', fees: 0, taxes: 0 },
      { investment_id: 3, type: 'interest', amount: '20', date: '2025-04-01', fees: '5', taxes: 0 },
    ]);

    const r = await getBestWorstPerformers.run({ from: '2025-04-01', to: '2025-04-30', topN: 1 });
    expect(r.data).toHaveLength(2);
    expect(r.data[0]).toMatchObject({ id: 1, rank: 'best', net: 100 });
    expect(r.data[1]).toMatchObject({ id: 2, rank: 'worst', net: -50 });
  });

  it('filters transactions by date range', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'X', asset_class: 'stock' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'dividend', amount: '100', date: '2024-12-15' }, // outside
      { investment_id: 1, type: 'dividend', amount: '50', date: '2025-04-15' }, // inside
    ]);
    const r = await getBestWorstPerformers.run({ from: '2025-01-01', to: '2025-12-31' });
    expect(r.data[0].net).toBe(50);
  });

  it('does not double-list same investment as best and worst', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([
      { id: 1, name: 'Only', asset_class: 'stock' },
    ]);
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValueOnce([
      { investment_id: 1, type: 'dividend', amount: '50', date: '2025-04-15' },
    ]);
    const r = await getBestWorstPerformers.run({ from: '2025-01-01', to: '2025-12-31', topN: 5 });
    expect(r.data).toHaveLength(1);
    expect(r.data[0].rank).toBe('best');
  });

  it('rejects unknown assetClass', async () => {
    await expect(getBestWorstPerformers.run({ from: '2025-01-01', to: '2025-12-31', assetClass: 'unicorn' })).rejects.toThrow(/assetClass/);
  });

  it('rejects reversed date order', async () => {
    await expect(getBestWorstPerformers.run({ from: '2025-12-31', to: '2025-01-01' })).rejects.toThrow();
  });

  it('returns empty when no investments', async () => {
    investmentRepository.getAll.mockResolvedValueOnce([]);
    const r = await getBestWorstPerformers.run({ from: '2025-01-01', to: '2025-12-31' });
    expect(r.data).toEqual([]);
  });
});

describe('getProjectedBalance', () => {
  it('combines current bank balance with planned net change', async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({ total_net_position: 5000 });
    plannedTransactionRepository.getAll.mockResolvedValueOnce({
      items: [
        { amount: '-100', planned_date: '2025-05-01', is_recurring: false, recipient_name: 'Bills', category_name: 'Utilities', memo: '' },
        { amount: '500', planned_date: '2025-05-15', is_recurring: false, recipient_name: 'Salary', category_name: 'Income', memo: '' },
      ],
    });

    const r = await getProjectedBalance.run({ horizonDays: 30 });
    expect(r.meta.currentBalance).toBe(5000);
    expect(r.meta.plannedNetChange).toBe(400);
    expect(r.meta.projectedBalance).toBe(5400);
    expect(r.data).toHaveLength(2);
  });

  it('expands recurring planned transactions across the horizon', async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({ total_net_position: 0 });
    plannedTransactionRepository.getAll.mockResolvedValueOnce({
      items: [
        {
          amount: '-12',
          planned_date: new Date('2025-05-01T00:00:00Z'),
          is_recurring: true,
          recurrence_pattern: 'monthly',
          recipient_name: 'Sub',
          category_name: 'Subs',
          memo: '',
        },
      ],
    });
    const r = await getProjectedBalance.run({ horizonDays: 90 });
    // Base + ~3 recurring fires (May, Jun, Jul) — pattern emits next-from-base
    expect(r.data.length).toBeGreaterThanOrEqual(3);
    expect(r.meta.plannedNetChange).toBeLessThan(-12);
  });

  it('rejects horizonDays out of bounds', async () => {
    await expect(getProjectedBalance.run({ horizonDays: 0 })).rejects.toThrow(/horizonDays/);
    await expect(getProjectedBalance.run({ horizonDays: 999 })).rejects.toThrow(/horizonDays/);
  });

  it('uses 30-day default when horizonDays missing', async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({ total_net_position: 100 });
    plannedTransactionRepository.getAll.mockResolvedValueOnce({ items: [] });
    const r = await getProjectedBalance.run({});
    expect(r.meta.horizonDays).toBe(30);
  });

  it('coerces string total_net_position to number', async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({ total_net_position: '1234.567' });
    plannedTransactionRepository.getAll.mockResolvedValueOnce({ items: [] });
    const r = await getProjectedBalance.run({});
    expect(r.meta.currentBalance).toBe(1234.57);
  });

  it('sorts entries chronologically', async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({ total_net_position: 0 });
    plannedTransactionRepository.getAll.mockResolvedValueOnce({
      items: [
        { amount: '-50', planned_date: '2025-05-15', is_recurring: false, recipient_name: 'B', category_name: '', memo: '' },
        { amount: '-30', planned_date: '2025-05-01', is_recurring: false, recipient_name: 'A', category_name: '', memo: '' },
      ],
    });
    const r = await getProjectedBalance.run({ horizonDays: 30 });
    expect(r.data.map((d) => d.date)).toEqual(['2025-05-01', '2025-05-15']);
  });
});
