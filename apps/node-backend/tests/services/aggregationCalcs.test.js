/**
 * Phase 2 aggregation calc module contract tests.
 *
 * Locks the public surface of services/calculations/aggregation/*:
 *   - Each compute* function returns the standard envelope.
 *   - meta.computedAt is a valid ISO timestamp.
 *   - meta.source follows the plan's heuristic (mv when unfiltered, live when
 *     exclusions force a dynamic scan, always-live for average-vs-current).
 *   - Each wrapper forwards arguments to infoRepository in the expected shape.
 *
 * DB is not required: infoRepository is mocked per test. Shadow-mode parity
 * against real data is a Phase 8 concern, not a Phase 2 regression harness.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/repositories/infoRepository.js', () => {
  const api = {
    getMonthlyFinancialSummary: vi.fn(),
    getCategoryBreakdown: vi.fn(),
    getRecipientInsights: vi.fn(),
    getCashflowComparison: vi.fn(),
    getAverageVsCurrentSpending: vi.fn(),
    getBankBalances: vi.fn(),
  };
  return { default: api };
});

import infoRepository from '../../src/repositories/infoRepository.js';
import { buildEnvelope } from '../../src/services/calculations/aggregation/_envelope.js';
import { computeMonthlySummary } from '../../src/services/calculations/aggregation/monthly.js';
import { computeCategoryBreakdown } from '../../src/services/calculations/aggregation/category.js';
import { computeRecipientInsights } from '../../src/services/calculations/aggregation/recipient.js';
import { computeCashflowComparison } from '../../src/services/calculations/aggregation/cashflow.js';
import { computeAverageVsCurrent } from '../../src/services/calculations/aggregation/averageVsCurrent.js';
import { computeBankBalances } from '../../src/services/calculations/aggregation/bankBalances.js';
import { bankBalancesResponseCache, invalidatePortfolioCaches } from '../../src/routes/info/_cache.js';

beforeEach(() => {
  vi.clearAllMocks();
  // bankBalances now shares a module-scoped inflight cache — reset it so each
  // test starts cold.
  bankBalancesResponseCache.clear();
});

function expectEnvelope(envelope, { source }) {
  expect(envelope).toHaveProperty('data');
  expect(envelope).toHaveProperty('meta');
  expect(envelope.meta).toHaveProperty('computedAt');
  expect(envelope.meta.source).toBe(source);
  expect(new Date(envelope.meta.computedAt).toString()).not.toBe('Invalid Date');
}

describe('buildEnvelope', () => {
  it('wraps data with defaulted meta fields', () => {
    const env = buildEnvelope({ x: 1 });
    expect(env.data).toEqual({ x: 1 });
    expect(env.meta.source).toBe('live');
    expect(typeof env.meta.computedAt).toBe('string');
  });

  it('preserves explicit computedAt and source', () => {
    const env = buildEnvelope([1, 2], { source: 'mv', computedAt: '2026-01-01T00:00:00.000Z' });
    expect(env.data).toEqual([1, 2]);
    expect(env.meta).toEqual({ source: 'mv', computedAt: '2026-01-01T00:00:00.000Z' });
  });
});

describe('computeMonthlySummary', () => {
  it('forwards currency + exclusions to the repository and tags source=mv when unfiltered', async () => {
    infoRepository.getMonthlyFinancialSummary.mockResolvedValue({ monthly_data: [] });
    const env = await computeMonthlySummary({ targetCurrency: 'EUR', excludedCategoryIds: [] });
    expect(infoRepository.getMonthlyFinancialSummary).toHaveBeenCalledWith([], 'EUR', [], false);
    expectEnvelope(env, { source: 'mv' });
    expect(env.data).toEqual({ monthly_data: [] });
  });

  it('tags source=live when category exclusions are present', async () => {
    infoRepository.getMonthlyFinancialSummary.mockResolvedValue({ monthly_data: [] });
    const env = await computeMonthlySummary({ targetCurrency: 'USD', excludedCategoryIds: [1, 2] });
    expect(infoRepository.getMonthlyFinancialSummary).toHaveBeenCalledWith([1, 2], 'USD', [], false);
    expectEnvelope(env, { source: 'live' });
  });

  it('tags source=live when recipient exclusions are present', async () => {
    infoRepository.getMonthlyFinancialSummary.mockResolvedValue({ monthly_data: [] });
    const env = await computeMonthlySummary({
      targetCurrency: 'EUR',
      excludedCategoryIds: [],
      excludedRecipientIds: [42],
    });
    expect(infoRepository.getMonthlyFinancialSummary).toHaveBeenCalledWith([], 'EUR', [42], false);
    expectEnvelope(env, { source: 'live' });
  });

  it('defaults to EUR + empty exclusions when called with no args', async () => {
    infoRepository.getMonthlyFinancialSummary.mockResolvedValue({});
    await computeMonthlySummary();
    expect(infoRepository.getMonthlyFinancialSummary).toHaveBeenCalledWith([], 'EUR', [], false);
  });
});

describe('computeCategoryBreakdown', () => {
  it('returns mv-sourced envelope', async () => {
    infoRepository.getCategoryBreakdown.mockResolvedValue([{ id: 1 }]);
    const env = await computeCategoryBreakdown({ targetCurrency: 'EUR' });
    expect(infoRepository.getCategoryBreakdown).toHaveBeenCalledWith('EUR');
    expectEnvelope(env, { source: 'mv' });
    expect(env.data).toEqual({ categories: [{ id: 1 }] });
  });
});

describe('computeRecipientInsights', () => {
  it('returns a live-sourced envelope (getRecipientInsights is a live scan)', async () => {
    infoRepository.getRecipientInsights.mockResolvedValue({ top_recipients: [] });
    const env = await computeRecipientInsights({ targetCurrency: 'EUR' });
    expect(infoRepository.getRecipientInsights).toHaveBeenCalledWith('EUR', {
      excludedCategoryIds: [],
      excludedRecipientIds: [],
    });
    expectEnvelope(env, { source: 'live' });
  });
});

describe('computeCashflowComparison', () => {
  it('tags source=mv when both exclusion lists are empty', async () => {
    infoRepository.getCashflowComparison.mockResolvedValue({ current: [], average: [] });
    const env = await computeCashflowComparison({ targetCurrency: 'EUR' });
    expect(infoRepository.getCashflowComparison).toHaveBeenCalledWith([], [], 'EUR');
    expectEnvelope(env, { source: 'mv' });
  });

  it('tags source=live when category exclusions are present', async () => {
    infoRepository.getCashflowComparison.mockResolvedValue({});
    const env = await computeCashflowComparison({
      targetCurrency: 'EUR',
      excludedCategoryIds: [5],
      excludedRecipientIds: [],
    });
    expect(infoRepository.getCashflowComparison).toHaveBeenCalledWith([5], [], 'EUR');
    expectEnvelope(env, { source: 'live' });
  });

  it('tags source=live when recipient exclusions are present', async () => {
    infoRepository.getCashflowComparison.mockResolvedValue({});
    const env = await computeCashflowComparison({
      targetCurrency: 'EUR',
      excludedCategoryIds: [],
      excludedRecipientIds: [42],
    });
    expect(infoRepository.getCashflowComparison).toHaveBeenCalledWith([], [42], 'EUR');
    expectEnvelope(env, { source: 'live' });
  });
});

describe('computeAverageVsCurrent', () => {
  it('always tags source=live (no MV backing in Phase 2)', async () => {
    infoRepository.getAverageVsCurrentSpending.mockResolvedValue({ average: 0, current: 0 });
    const env = await computeAverageVsCurrent({ targetCurrency: 'EUR' });
    expect(infoRepository.getAverageVsCurrentSpending).toHaveBeenCalledWith('EUR');
    expectEnvelope(env, { source: 'live' });
  });
});

describe('computeBankBalances', () => {
  it('returns a live-sourced envelope (runs live SQL, not an MV read)', async () => {
    infoRepository.getBankBalances.mockResolvedValue([{ account: 'A', balance: 100 }]);
    const env = await computeBankBalances({ targetCurrency: 'EUR' });
    expect(infoRepository.getBankBalances).toHaveBeenCalledWith('EUR');
    expectEnvelope(env, { source: 'live' });
    expect(env.data).toEqual([{ account: 'A', balance: 100 }]);
  });

  it('caches: two calls hit the DB once, second is served from cache', async () => {
    infoRepository.getBankBalances.mockResolvedValue([{ account: 'A', balance: 100 }]);
    const first = await computeBankBalances({ targetCurrency: 'EUR' });
    const second = await computeBankBalances({ targetCurrency: 'EUR' });
    expect(infoRepository.getBankBalances).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.data).toEqual([{ account: 'A', balance: 100 }]);
  });

  it('cache is busted by invalidatePortfolioCaches (shared net-worth seam)', async () => {
    infoRepository.getBankBalances.mockResolvedValue([{ account: 'A', balance: 100 }]);
    await computeBankBalances({ targetCurrency: 'EUR' });
    invalidatePortfolioCaches();
    await computeBankBalances({ targetCurrency: 'EUR' });
    expect(infoRepository.getBankBalances).toHaveBeenCalledTimes(2);
  });
});
