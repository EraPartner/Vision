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

vi.mock('../../src/services/info/cache.js', () => ({
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
import { invalidatePortfolioCaches } from '../../src/services/info/cache.js';
import { ValidationError } from '../../src/middleware/errorHandler.js';
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

// A merge deletes the source accounts, so a partially-applied merge is an
// irreversible write the client never asked for. Bulk requests are
// all-or-nothing (the transactions.js bulk-{tag,update} pattern): a malformed
// source id rejects the request with a 400 naming it, instead of being
// filtered out while the remaining sources merge anyway.
describe('POST /:id/merge — source_ids are rejected, not filtered', () => {
  beforeEach(() => vi.clearAllMocks());

  it('merges a fully-valid body unchanged (parseInt coercion preserved)', async () => {
    mergeAccounts.mockResolvedValue({ into: 1, merged: [2, 3] });
    const res = createMockResponse();
    await routeHandlers['post:/:id/merge']({ params: { id: '1' }, body: { source_ids: [2, '3'] } }, res);
    expect(mergeAccounts).toHaveBeenCalledWith(1, [2, 3]);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { into: 1, merged: [2, 3], links: [] },
    });
  });

  it('rejects with 400 when one source id of several is not an integer, merging nothing', async () => {
    const res = createMockResponse();
    await expect(
      routeHandlers['post:/:id/merge']({ params: { id: '1' }, body: { source_ids: [2, 'abc', 3] } }, res),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mergeAccounts).not.toHaveBeenCalled();
    expect(invalidatePortfolioCaches).not.toHaveBeenCalled();
  });

  it('names each offending entry (index and raw value) in the 400', async () => {
    const res = createMockResponse();
    await expect(
      routeHandlers['post:/:id/merge']({ params: { id: '1' }, body: { source_ids: [2, 'abc', null] } }, res),
    ).rejects.toThrow(/source_ids\[1\] \("abc"\).*source_ids\[2\] \(null\)/s);
    expect(mergeAccounts).not.toHaveBeenCalled();
  });

  it('rejects non-integer forms that parseInt cannot coerce (null, objects, empty string)', async () => {
    for (const bad of [null, {}, '', [], undefined]) {
      const res = createMockResponse();
      await expect(
        routeHandlers['post:/:id/merge']({ params: { id: '1' }, body: { source_ids: [bad] } }, res),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(mergeAccounts).not.toHaveBeenCalled();
  });

  it('leaves the non-array / missing source_ids path to the service (empty list)', async () => {
    mergeAccounts.mockResolvedValue({ into: 1, merged: [] });
    const res = createMockResponse();
    await routeHandlers['post:/:id/merge']({ params: { id: '1' }, body: {} }, res);
    expect(mergeAccounts).toHaveBeenCalledWith(1, []);
  });
});
