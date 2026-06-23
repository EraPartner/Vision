/**
 * POST /bulk-delete — id-mode, filter-mode, validation, atomicity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...handlers) => { routeHandlers[`get:${path}`] = handlers[handlers.length - 1]; }),
  post: vi.fn((path, ...handlers) => { routeHandlers[`post:${path}`] = handlers[handlers.length - 1]; }),
  patch: vi.fn((path, ...handlers) => { routeHandlers[`patch:${path}`] = handlers[handlers.length - 1]; }),
  delete: vi.fn((path, ...handlers) => { routeHandlers[`delete:${path}`] = handlers[handlers.length - 1]; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/repositories/transactionRepository.js', () => ({
  default: {
    getAllWithCount: vi.fn(),
    getUncategorisedWithCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
  },
}));

vi.mock('../../src/services/deduplication.js', () => ({
  isManualDuplicate: vi.fn(async () => ({ isDuplicate: false })),
  recordManualRawTransaction: vi.fn(async () => undefined),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/services/transferReconciliationService.js', () => ({
  scheduleReconcile: vi.fn(),
  getTransferSuggestions: vi.fn(),
  markTransfer: vi.fn(),
  unmarkTransfer: vi.fn(),
}));

vi.mock('../../src/services/currency/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(async (rows) => rows),
}));

vi.mock('../../src/database/connection.js', () => {
  const getClient = vi.fn();
  return {
    query: vi.fn(),
    getClient,
    withTransaction: vi.fn(async (fn) => {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      } finally {
        client.release();
      }
    }),
  };
});

await import('../../src/routes/transactions.js');

import { getClient, query as dbQuery } from '../../src/database/connection.js';
import { scheduleReconcile } from '../../src/services/transferReconciliationService.js';

const handler = routeHandlers['post:/bulk-delete'];

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), headersSent: false };
  res.status.mockReturnValue(res);
  res.ok = (data) => res.json({ ok: true, data });
  return res;
}

async function callHandler(req, res) {
  try {
    await handler(req, res);
  } catch (err) {
    const status = err.status ?? 500;
    res.status(status).json({ ok: false, error: { code: err.code ?? 'INTERNAL_SERVER_ERROR', message: err.message } });
  }
}

describe('POST /bulk-delete — input validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when neither ids nor filter is given', async () => {
    const res = mockResponse();
    await callHandler({ body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when both ids and filter are given', async () => {
    const res = mockResponse();
    await callHandler({ body: { ids: [1], filter: { search: 'x' } } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when ids exceeds 500 entries', async () => {
    const res = mockResponse();
    await callHandler({ body: { ids: Array.from({ length: 501 }, (_, i) => i + 1) } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('POST /bulk-delete — id-mode success', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hard-deletes the listed transactions and schedules a refresh', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }) // DELETE RETURNING id
      .mockResolvedValueOnce({}); // COMMIT
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = mockResponse();
    await callHandler({ body: { ids: [1, 2, 3] } }, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.deleted).toBe(3);
    expect(scheduleReconcile).toHaveBeenCalledTimes(1);

    const deleteCall = clientQuery.mock.calls.find(([sql]) => sql.includes('DELETE FROM transactions'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall[1]).toEqual([[1, 2, 3]]);
  });

  it('does not schedule a refresh when nothing was deleted', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = mockResponse();
    await callHandler({ body: { ids: [9999] } }, res);

    expect(res.json.mock.calls[0][0].data.deleted).toBe(0);
    expect(scheduleReconcile).not.toHaveBeenCalled();
  });
});

describe('POST /bulk-delete — filter-mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects filter requests that exceed the cap', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ n: 6000 }] });
    const res = mockResponse();
    await callHandler({ body: { filter: { search: 'big' } } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('resolves filter to ids and deletes them', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ n: 2 }] }) // count
      .mockResolvedValueOnce({ rows: [{ id: 11 }, { id: 22 }] }); // ids

    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 11 }, { id: 22 }] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = mockResponse();
    await callHandler({ body: { filter: { search: 'cafe' } } }, res);

    expect(res.json.mock.calls[0][0].data.deleted).toBe(2);
    const deleteCall = clientQuery.mock.calls.find(([sql]) => sql.includes('DELETE'));
    expect(deleteCall[1]).toEqual([[11, 22]]);
  });
});

describe('POST /bulk-delete — atomicity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rolls back and skips refresh when DELETE fails', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = mockResponse();
    await callHandler({ body: { ids: [1] } }, res);

    expect(scheduleReconcile).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    const rollback = clientQuery.mock.calls.find(([sql]) => sql === 'ROLLBACK');
    expect(rollback).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
