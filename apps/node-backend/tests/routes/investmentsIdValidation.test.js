/**
 * Id shapes on the investments router: the `:txnId` path param, the
 * `account_id` write-body FK, and the `investment_ids` query param.
 *
 * Three separate parsers, one failure mode — a malformed id named a different,
 * perfectly real record instead of being rejected:
 *
 *  - `:txnId` was `parseInt` + `isNaN`/`<= 0`, and the two routes carrying it
 *    were the only ones in the file with no id middleware at all. `DELETE
 *    /investments/transactions/12abc` answered **204 having hard-deleted
 *    transaction 12**; `1e3` deleted transaction 1; PATCH retargeted the same
 *    way. Irreversible, and reported as success.
 *  - `account_id` was a bare `Number()` with no integer check whatsoever — the
 *    weakest validator in the family. `'1e3'` booked the lot against account
 *    1000, `'0x10'` against 16, `true` against 1, `[7]` against 7, all 201.
 *    PATCH forwarded it raw through the repository allow-list, where Postgres'
 *    hex-literal parsing turned `'0x10'` into account 16 and everything else
 *    into a 500.
 *  - `investment_ids` was `parseInt` + `filter(Number.isInteger)`, so
 *    `?investment_ids=5,12abc` read investments 5 **and 12** with a 200.
 *
 * Own file rather than appended to investments.test.js: these matrices are
 * ~60 requests, and the bulk-transactions cache in investmentController is
 * module-scoped, so a fresh module registry keeps the query-param cases from
 * reading each other's cached payloads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, errEnvelope } from '../helpers/routeApp.js';

vi.mock('../../src/repositories/investmentRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getAllWithCount: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updatePrice: vi.fn(),
    updatePricesBulk: vi.fn(),
    hardDelete: vi.fn(),
  },
  pickInvestmentCreateFields: (body) => body,
}));

vi.mock('../../src/repositories/portfolioTransactionRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getAllByInvestmentIds: vi.fn(),
    getAllWithCount: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
    getSummary: vi.fn(),
  },
}));

vi.mock('../../src/services/priceProviderService.js', () => ({
  fetchLivePricesDetailed: vi.fn(),
  fetchHistoricalPrices: vi.fn(),
  SUPPORTED_PROVIDERS: [{ key: 'manual', name: 'Manual' }],
}));

vi.mock('../../src/services/quoteBackfillService.js', () => ({
  refreshQuotesForInvestment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/portfolio/fxResolve.js', () => ({
  autoResolveFxRateToEur: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/config/logger.js', () => ({ logger: mockLogger() }));

import investmentRepository from '../../src/repositories/investmentRepository.js';
import portfolioTransactionRepository from '../../src/repositories/portfolioTransactionRepository.js';

const { default: investmentsRouter } = await import('../../src/routes/investments.js');

const BASE = '/api/investments';
const api = routeAgent(investmentsRouter, { mountPath: BASE });

// Forms the old parsers resolved to a DIFFERENT, perfectly real record.
const RETARGETING = ['12abc', '12.5', '1e3', '0x10', '+7', ' 7 ', '7.0'];
// Forms that cleared the old guards and reached a repository or Postgres.
const OUT_OF_RANGE = ['-1', '0'];

const createBody = (extra) => ({
  type: 'buy', date: '2026-01-15', amount: 1000, units: 1, price_per_unit: 1000, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'EUR', asset_class: 'stock' });
  portfolioTransactionRepository.getById.mockResolvedValue({ id: 12, investment_id: 1 });
  portfolioTransactionRepository.hardDelete.mockResolvedValue(true);
  portfolioTransactionRepository.create.mockResolvedValue({ id: 1, investment_id: 1 });
  portfolioTransactionRepository.update.mockResolvedValue({ id: 12, investment_id: 1 });
});

describe(':txnId — the two routes that had no id guard at all', () => {
  it('rejects every malformed id on DELETE instead of hard-deleting what it truncates to', async () => {
    for (const id of [...RETARGETING, ...OUT_OF_RANGE, 'abc']) {
      const res = await api.delete(`${BASE}/transactions/${id}`);
      expect(res.status, `expected DELETE /transactions/${id} to be rejected`).toBe(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    }
    expect(portfolioTransactionRepository.getById).not.toHaveBeenCalled();
    expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
  });

  it('rejects every malformed id on PATCH instead of updating what it truncates to', async () => {
    for (const id of [...RETARGETING, ...OUT_OF_RANGE, 'abc']) {
      const res = await api.patch(`${BASE}/transactions/${id}`).send({ note: 'should not apply' });
      expect(res.status, `expected PATCH /transactions/${id} to be rejected`).toBe(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    }
    expect(portfolioTransactionRepository.update).not.toHaveBeenCalled();
  });

  it('still deletes and updates a real id, leading zeros included', async () => {
    await api.delete(`${BASE}/transactions/12`).expect(204);
    await api.delete(`${BASE}/transactions/0012`).expect(204);
    expect(portfolioTransactionRepository.hardDelete.mock.calls).toEqual([[12], [12]]);

    await api.patch(`${BASE}/transactions/12`).send({ note: 'ok' }).expect(200);
    expect(portfolioTransactionRepository.update).toHaveBeenCalledWith(12, { note: 'ok' });
  });

  it('still 404s on a well-formed id that matches no row', async () => {
    portfolioTransactionRepository.getById.mockResolvedValue(null);
    const res = await api.delete(`${BASE}/transactions/999`).expect(404);
    expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
  });
});

describe('account_id on the portfolio-transaction write bodies', () => {
  it('rejects on POST every value the bare Number() booked against another account', async () => {
    for (const account_id of [...RETARGETING, ...OUT_OF_RANGE, 0, -1, true, [7], '', {}]) {
      const res = await api.post(`${BASE}/1/transactions`).send(createBody({ account_id }));
      expect(res.status, `expected account_id ${JSON.stringify(account_id)} to be rejected`).toBe(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    }
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
  });

  it('rejects the same set on PATCH', async () => {
    for (const account_id of [...RETARGETING, ...OUT_OF_RANGE, 0, -1, true, [7], '']) {
      const res = await api.patch(`${BASE}/transactions/12`).send({ account_id });
      expect(res.status, `expected account_id ${JSON.stringify(account_id)} to be rejected`).toBe(400);
    }
    expect(portfolioTransactionRepository.update).not.toHaveBeenCalled();
  });

  // Absent and null mean different things on the two routes and always have:
  // on create both mean "no brokerage account" (undefined, column default), on
  // PATCH absent means "leave alone" and null means unassign. Pinned so the new
  // guard cannot collapse them.
  it('keeps the create route mapping absent AND null to undefined', async () => {
    await api.post(`${BASE}/1/transactions`).send(createBody({})).expect(201);
    await api.post(`${BASE}/1/transactions`).send(createBody({ account_id: null })).expect(201);
    for (const call of portfolioTransactionRepository.create.mock.calls) {
      expect(call[0].account_id).toBeUndefined();
    }
  });

  it('keeps PATCH null unassigning and PATCH absent leaving the column alone', async () => {
    await api.patch(`${BASE}/transactions/12`).send({ account_id: null }).expect(200);
    expect(portfolioTransactionRepository.update).toHaveBeenCalledWith(12, { account_id: null });

    portfolioTransactionRepository.update.mockClear();
    await api.patch(`${BASE}/transactions/12`).send({ note: 'only-this' }).expect(200);
    expect('account_id' in portfolioTransactionRepository.update.mock.calls[0][1]).toBe(false);
  });

  it('still accepts an integer or a digit string on both routes, coerced', async () => {
    await api.post(`${BASE}/1/transactions`).send(createBody({ account_id: 7 })).expect(201);
    await api.post(`${BASE}/1/transactions`).send(createBody({ account_id: '007' })).expect(201);
    expect(portfolioTransactionRepository.create.mock.calls.map((c) => c[0].account_id)).toEqual([7, 7]);

    await api.patch(`${BASE}/transactions/12`).send({ account_id: '007' }).expect(200);
    expect(portfolioTransactionRepository.update).toHaveBeenCalledWith(12, { account_id: 7 });
  });
});

describe('investment_ids query param on GET /transactions', () => {
  it('rejects a list with any malformed element instead of reading what it truncates to', async () => {
    for (const value of [...RETARGETING, ...OUT_OF_RANGE, '5,12abc', '5,', 'abc']) {
      const res = await api.get(`${BASE}/transactions`).query({ investment_ids: value });
      expect(res.status, `expected investment_ids=${value} to be rejected`).toBe(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    }
    expect(portfolioTransactionRepository.getAllByInvestmentIds).not.toHaveBeenCalled();
  });

  // Pre-existing behaviour: the param is REQUIRED here, so absent/empty is a
  // 400 rather than the "no filter" the optional id query params use.
  it('keeps absent and empty as the existing required-field 400', async () => {
    for (const query of [{}, { investment_ids: '' }]) {
      const res = await api.get(`${BASE}/transactions`).query(query).expect(400);
      expect(res.body.error.message).toContain('investment_ids is required');
    }
  });

  it('still accepts a digit-string list, coerced to numbers', async () => {
    portfolioTransactionRepository.getAllByInvestmentIds.mockResolvedValue([]);
    portfolioTransactionRepository.getCount.mockResolvedValue(0);

    await api.get(`${BASE}/transactions`).query({ investment_ids: '5,012' }).expect(200);
    expect(portfolioTransactionRepository.getAllByInvestmentIds).toHaveBeenCalledWith(
      expect.objectContaining({ investmentIds: [5, 12] }),
    );
  });
});
