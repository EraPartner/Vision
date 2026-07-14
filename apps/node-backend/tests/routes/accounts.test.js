/**
 * Account route tests.
 *
 * Focus: every account mutation must bust the portfolio response caches
 * (net-worth + bank-balances) via invalidatePortfolioCaches, otherwise the
 * 5-min netWorthResponseCache keeps serving a stale net worth after an account
 * is renamed / toggled in_net_worth / archived / merged / reconciled, etc.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/services/accountService.js', () => ({
  default: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../src/services/accountMergeService.js', () => ({
  mergeAccounts: vi.fn(),
}));

vi.mock('../../src/services/openingBalanceService.js', () => ({
  setOpeningBalance: vi.fn(),
}));

vi.mock('../../src/services/reconcileService.js', () => ({
  reconcileAccount: vi.fn(),
}));

vi.mock('../../src/services/aggregationRefresh.js', () => ({
  scheduleAggregationRefresh: vi.fn(),
}));

vi.mock('../../src/routes/info/_cache.js', () => ({
  invalidatePortfolioCaches: vi.fn(),
}));

vi.mock('../../src/middleware/validation.js', () => ({
  validateIdParam: (req, res, next) => next(),
}));

import accountService from '../../src/services/accountService.js';
import { mergeAccounts } from '../../src/services/accountMergeService.js';
import { setOpeningBalance } from '../../src/services/openingBalanceService.js';
import { reconcileAccount } from '../../src/services/reconcileService.js';
import { scheduleAggregationRefresh } from '../../src/services/aggregationRefresh.js';
import { invalidatePortfolioCaches } from '../../src/routes/info/_cache.js';
await import('../../src/routes/accounts.js');

describe('Account Routes — portfolio cache invalidation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create busts the portfolio caches', async () => {
    accountService.create.mockResolvedValue({ id: 1, name: 'Cash' });
    const res = createMockResponse();
    await routeHandlers['post:/']({ body: { name: 'Cash' } }, res);
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('update busts the portfolio caches (rename / in_net_worth / is_active / statement_balance)', async () => {
    accountService.update.mockResolvedValue({ id: 1, name: 'Renamed' });
    const res = createMockResponse();
    await routeHandlers['patch:/:id']({ params: { id: '1' }, body: { name: 'Renamed' } }, res);
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
  });

  it('delete busts the portfolio caches', async () => {
    accountService.remove.mockResolvedValue(undefined);
    const res = createMockResponse();
    await routeHandlers['delete:/:id']({ params: { id: '1' } }, res);
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
  });

  it('merge busts the portfolio caches', async () => {
    mergeAccounts.mockResolvedValue({ survivor_id: 1, merged: [2] });
    const res = createMockResponse();
    await routeHandlers['post:/:id/merge']({ params: { id: '1' }, body: { source_ids: [2] } }, res);
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
  });

  it('opening-balance busts the portfolio caches and still refreshes aggregations', async () => {
    setOpeningBalance.mockResolvedValue({ id: 1 });
    const res = createMockResponse();
    await routeHandlers['post:/:id/opening-balance'](
      { params: { id: '1' }, body: { balance: 100, date: '2026-01-01' } },
      res,
    );
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
    expect(scheduleAggregationRefresh).toHaveBeenCalledTimes(1);
  });

  it('reconcile busts the portfolio caches and still refreshes aggregations', async () => {
    reconcileAccount.mockResolvedValue({ id: 1 });
    const res = createMockResponse();
    await routeHandlers['post:/:id/reconcile']({ params: { id: '1' }, body: { mode: 'accept' } }, res);
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
    expect(scheduleAggregationRefresh).toHaveBeenCalledTimes(1);
  });
});
