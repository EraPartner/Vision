/**
 * Account route tests.
 *
 * Focus: every account mutation must bust the portfolio response caches
 * (net-worth + bank-balances) via invalidatePortfolioCaches, otherwise the
 * 5-min netWorthResponseCache keeps serving a stale net worth after an account
 * is renamed / toggled in_net_worth / archived / merged / reconciled, etc.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js) — validateIdParam is no longer stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeAgent, okEnvelope, errEnvelope } from '../helpers/routeApp.js';

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
  MAX_ACCOUNT_MERGE_SOURCES: 500,
  mergeAccounts: vi.fn(),
  previewMerge: vi.fn(),
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

import accountService from '../../src/services/accountService.js';
import { mergeAccounts, previewMerge } from '../../src/services/accountMergeService.js';
import { setOpeningBalance } from '../../src/services/openingBalanceService.js';
import { reconcileAccount } from '../../src/services/reconcileService.js';
import { scheduleAggregationRefresh } from '../../src/services/aggregationRefresh.js';
import { invalidatePortfolioCaches } from '../../src/services/info/cache.js';

const { default: accountsRouter } = await import('../../src/routes/accounts.js');

const api = routeAgent(accountsRouter, { mountPath: '/api/accounts' });
const BASE = '/api/accounts';

function mergeRouteHandler() {
  const layer = accountsRouter.stack.find((entry) => entry.route?.path === '/:id/merge' && entry.route.methods.post);
  return layer.route.stack.at(-1).handle;
}

describe('POST /:id/merge — listener-free boundary guards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a mixed self-reference before calling the service', async () => {
    const handler = mergeRouteHandler();
    await expect(handler(
      /** @type {any} */ ({ params: { id: '1' }, body: { source_ids: [2, 1] } }),
      /** @type {any} */ ({}),
    )).rejects.toThrow(/must not include the survivor/);
    expect(mergeAccounts).not.toHaveBeenCalled();
  });

  it('rejects more than 500 sources before validating or calling the service', async () => {
    const handler = mergeRouteHandler();
    const sourceIds = Array.from({ length: 501 }, (_, index) => index + 2);
    await expect(handler(
      /** @type {any} */ ({ params: { id: '1' }, body: { source_ids: sourceIds } }),
      /** @type {any} */ ({}),
    )).rejects.toThrow(/at most 500/);
    expect(mergeAccounts).not.toHaveBeenCalled();
  });

  it('accepts and forwards exactly 500 sources', async () => {
    const handler = mergeRouteHandler();
    const sourceIds = Array.from({ length: 500 }, (_, index) => index + 2);
    mergeAccounts.mockResolvedValue({ into: 1, merged: sourceIds });
    const res = { ok: vi.fn() };
    await handler(
      /** @type {any} */ ({ params: { id: '1' }, body: { source_ids: sourceIds } }),
      /** @type {any} */ (res),
    );
    expect(mergeAccounts).toHaveBeenCalledWith(1, sourceIds);
    expect(res.ok).toHaveBeenCalledOnce();
  });
});

describe('Account Routes — portfolio cache invalidation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create busts the portfolio caches', async () => {
    accountService.create.mockResolvedValue({ id: 1, name: 'Cash' });
    const res = await api.post(BASE).send({ name: 'Cash' }).expect(201);
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual(okEnvelope({ id: 1, name: 'Cash', links: [] }));
  });

  it('update busts the portfolio caches (rename / in_net_worth / is_active / statement_balance)', async () => {
    accountService.update.mockResolvedValue({ id: 1, name: 'Renamed' });
    await api.patch(`${BASE}/1`).send({ name: 'Renamed' }).expect(200);
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
  });

  it('delete busts the portfolio caches and answers 204 with no body', async () => {
    accountService.remove.mockResolvedValue(undefined);
    const res = await api.delete(`${BASE}/1`).expect(204);
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
    expect(res.text).toBe('');
  });

  it('merge busts the portfolio caches', async () => {
    mergeAccounts.mockResolvedValue({ survivor_id: 1, merged: [2] });
    await api.post(`${BASE}/1/merge`).send({ source_ids: [2] }).expect(200);
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
  });

  it('opening-balance busts the portfolio caches and still refreshes aggregations', async () => {
    setOpeningBalance.mockResolvedValue({ id: 1 });
    await api.post(`${BASE}/1/opening-balance`).send({ balance: 100, date: '2026-01-01' }).expect(200);
    expect(invalidatePortfolioCaches).toHaveBeenCalledTimes(1);
    expect(scheduleAggregationRefresh).toHaveBeenCalledTimes(1);
  });

  it('reconcile busts the portfolio caches and still refreshes aggregations', async () => {
    reconcileAccount.mockResolvedValue({ id: 1 });
    await api.post(`${BASE}/1/reconcile`).send({ mode: 'accept' }).expect(200);
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
    const res = await api.post(`${BASE}/1/merge`).send({ source_ids: [2, '3'] }).expect(200);
    expect(mergeAccounts).toHaveBeenCalledWith(1, [2, 3]);
    expect(res.body).toEqual(okEnvelope({ into: 1, merged: [2, 3], links: [] }));
  });

  it('rejects with 400 when one source id of several is not an integer, merging nothing', async () => {
    const res = await api.post(`${BASE}/1/merge`).send({ source_ids: [2, 'abc', 3] }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mergeAccounts).not.toHaveBeenCalled();
    expect(invalidatePortfolioCaches).not.toHaveBeenCalled();
  });

  it('rejects a mixed self-reference instead of silently merging the other sources', async () => {
    const res = await api.post(`${BASE}/1/merge`).send({ source_ids: [2, 1] }).expect(400);
    expect(res.body.error.message).toMatch(/must not include the survivor/);
    expect(mergeAccounts).not.toHaveBeenCalled();
    expect(invalidatePortfolioCaches).not.toHaveBeenCalled();
  });

  it('rejects more than 500 sources before calling the merge service', async () => {
    const sourceIds = Array.from({ length: 501 }, (_, index) => index + 2);
    const res = await api.post(`${BASE}/1/merge`).send({ source_ids: sourceIds }).expect(400);
    expect(res.body.error.message).toMatch(/at most 500/);
    expect(mergeAccounts).not.toHaveBeenCalled();
    expect(invalidatePortfolioCaches).not.toHaveBeenCalled();
  });

  it('names each offending entry (index and raw value) in the 400', async () => {
    const res = await api.post(`${BASE}/1/merge`).send({ source_ids: [2, 'abc', null] }).expect(400);
    expect(res.body.error.message).toMatch(/source_ids\[1\] \("abc"\).*source_ids\[2\] \(null\)/s);
    expect(mergeAccounts).not.toHaveBeenCalled();
  });

  it('rejects non-integer forms that parseInt cannot coerce (null, objects, empty string)', async () => {
    for (const bad of [null, {}, '', [], undefined]) {
      await api.post(`${BASE}/1/merge`).send({ source_ids: [bad] }).expect(400);
    }
    expect(mergeAccounts).not.toHaveBeenCalled();
  });

  it('leaves the non-array / missing source_ids path to the service (empty list)', async () => {
    mergeAccounts.mockResolvedValue({ into: 1, merged: [] });
    await api.post(`${BASE}/1/merge`).send({}).expect(200);
    expect(mergeAccounts).toHaveBeenCalledWith(1, []);
  });

  // The rejection list above was built on `parseInt(x, 10)` + Number.isInteger,
  // which catches an entry parseInt cannot parse at all but NOT one it parses
  // partially: '12abc' became the integer 12, passed the guard, and merged
  // account 12 — deleting it and repointing its rows onto the survivor. Same
  // retarget the bulk id lists carried (00f8281d) and the transfers body
  // carried (ae79ec1f), on an equally irreversible write.
  it('rejects an entry parseInt would have retargeted to a different account', async () => {
    for (const bad of ['12abc', '1e3', '0x10', '12.5', '5.0', ' 5 ', '-4', '0', '2147483648', true, [7]]) {
      const res = await api.post(`${BASE}/1/merge`).send({ source_ids: [2, bad] }).expect(400);
      expect(res.body.error.message).toMatch(/source_ids\[1\]/);
    }
    expect(mergeAccounts).not.toHaveBeenCalled();
  });
});

// Read-only sibling of the merge body above: `?into=` was parsed with
// `Number(...)` and previewMerge only checks that what it receives is a
// positive integer, so `?into=1e3` arrived as a well-formed 1000 and previewed
// a merge into an account nobody named.
describe('GET /:id/merge-preview — ?into= is a strict id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a coercible non-id rather than previewing a different account', async () => {
    for (const raw of ['1e3', '0x10', '12abc', '12.5', ' 5 ', '0', '-4', 'abc', '', '2147483648']) {
      const res = await api.get(`${BASE}/1/merge-preview?into=${encodeURIComponent(raw)}`).expect(400);
      expect(res.body.error.message).toBe('into must be a positive integer account id');
    }
    await api.get(`${BASE}/1/merge-preview`).expect(400);
    expect(previewMerge).not.toHaveBeenCalled();
  });

  it('passes a well-formed ?into= through unchanged', async () => {
    previewMerge.mockResolvedValue({ into: 2 });
    await api.get(`${BASE}/1/merge-preview?into=2`).expect(200);
    expect(previewMerge).toHaveBeenCalledWith(1, 2);
  });
});

describe('Account Routes — GET / pagination is opt-in', () => {
  beforeEach(() => vi.clearAllMocks());

  // The accounts hub has no paging UI and asks for no limit/offset; the route
  // must keep answering the complete list (and must not echo limit/offset).
  it('returns the full list and no limit/offset when neither param is sent', async () => {
    accountService.list.mockResolvedValue({ items: [{ id: 1 }, { id: 2 }], total: 2 });
    const res = await api.get(BASE).expect(200);

    expect(accountService.list).toHaveBeenCalledWith({ active: true });
    expect(res.body).toEqual(okEnvelope({ items: [{ id: 1 }, { id: 2 }], total: 2, links: [] }));
  });

  it('treats an empty limit param as absent', async () => {
    accountService.list.mockResolvedValue({ items: [{ id: 1 }], total: 1 });
    const res = await api.get(`${BASE}?limit=`).expect(200);

    expect(accountService.list).toHaveBeenCalledWith({ active: true });
    expect(res.body.data.limit).toBeUndefined();
  });

  it('pages and reports the full total when limit/offset are supplied', async () => {
    accountService.list.mockResolvedValue({ items: [{ id: 3 }], total: 12 });
    const res = await api.get(`${BASE}?active=all&limit=1&offset=2`).expect(200);

    expect(accountService.list).toHaveBeenCalledWith({ active: null, limit: 1, offset: 2 });
    expect(res.body).toEqual(okEnvelope({ items: [{ id: 3 }], total: 12, limit: 1, offset: 2, links: [] }));
  });

  it('clamps limit to the per-resource cap', async () => {
    accountService.list.mockResolvedValue({ items: [], total: 0 });
    await api.get(`${BASE}?limit=99999`).expect(200);

    expect(accountService.list).toHaveBeenCalledWith({ active: true, limit: 1000, offset: 0 });
  });
});

describe('GET /:id — real validateIdParam guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a non-integer :id with a 400 VALIDATION_ERROR envelope', async () => {
    // Previously `vi.mock('.../middleware/validation.js')` replaced
    // validateIdParam with a pass-through, so this guard was never tested.
    const res = await api.get(`${BASE}/abc`).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    expect(accountService.get).not.toHaveBeenCalled();
  });
});
