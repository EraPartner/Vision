/**
 * POST /bulk-update — field validation, FK pre-checks, single transaction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

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
  logger: mockLogger(),
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

const handler = routeHandlers['post:/bulk-update'];

function mockResponse() {
  return createMockResponse({ headersSent: false });
}

async function callHandler(req, res) {
  try {
    await handler(req, res);
  } catch (err) {
    const status = err.status ?? 500;
    res.status(status).json({ ok: false, error: { code: err.code ?? 'INTERNAL_SERVER_ERROR', message: err.message } });
  }
}

describe('POST /bulk-update — field validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when fields object is missing', async () => {
    const res = mockResponse();
    await callHandler({ body: { ids: [1] } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects when no recognized field is set', async () => {
    const res = mockResponse();
    await callHandler({ body: { ids: [1], fields: { foo: 1 } } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.message).toMatch(/at least one/i);
  });

  it('rejects non-integer category_id', async () => {
    const res = mockResponse();
    await callHandler({ body: { ids: [1], fields: { category_id: 'abc' } } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('accepts category_id = null (uncategorize)', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = mockResponse();
    await callHandler({ body: { ids: [1], fields: { category_id: null } } }, res);

    expect(res.json.mock.calls[0][0].data.updated).toBe(1);
    const updateCall = clientQuery.mock.calls.find(([sql]) => sql.includes('UPDATE transactions'));
    expect(updateCall[0]).toMatch(/category_id = \$2/);
    expect(updateCall[1]).toEqual([[1], null]);
  });

  it('rejects null recipient_id (column is NOT NULL)', async () => {
    const res = mockResponse();
    await callHandler({ body: { ids: [1], fields: { recipient_id: null } } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects non-boolean is_active', async () => {
    const res = mockResponse();
    await callHandler({ body: { ids: [1], fields: { is_active: 'true' } } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('POST /bulk-update — FK pre-checks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when category does not exist', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // category lookup
    const res = mockResponse();
    await callHandler({ body: { ids: [1], fields: { category_id: 999 } } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('returns 400 when recipient does not exist', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // recipient lookup
    const res = mockResponse();
    await callHandler({ body: { ids: [1], fields: { recipient_id: 999 } } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe('POST /bulk-update — success paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates a single field and schedules a refresh', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] }); // category exists
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = mockResponse();
    await callHandler({ body: { ids: [1, 2], fields: { category_id: 7 } } }, res);

    expect(res.json.mock.calls[0][0].data.updated).toBe(2);
    expect(scheduleReconcile).toHaveBeenCalledTimes(1);
  });

  it('updates multiple fields in one statement', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }] }) // category exists
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }); // recipient exists
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = mockResponse();
    await callHandler({
      body: {
        ids: [5],
        fields: { category_id: 7, recipient_id: 99, is_active: false },
      },
    }, res);

    expect(res.json.mock.calls[0][0].data.updated).toBe(1);
    const updateCall = clientQuery.mock.calls.find(([sql]) => sql.includes('UPDATE transactions'));
    expect(updateCall[0]).toMatch(/category_id = \$2.*recipient_id = \$3.*is_active = \$4.*updated_at = NOW\(\)/s);
    expect(updateCall[1]).toEqual([[5], 7, 99, false]);
  });

  it('does not schedule a refresh when nothing was updated', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = mockResponse();
    await callHandler({ body: { ids: [12345], fields: { is_active: true } } }, res);

    expect(res.json.mock.calls[0][0].data.updated).toBe(0);
    expect(scheduleReconcile).not.toHaveBeenCalled();
  });
});

describe('POST /bulk-update — atomicity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rolls back and skips refresh when UPDATE fails', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = mockResponse();
    await callHandler({ body: { ids: [1], fields: { is_active: false } } }, res);

    expect(scheduleReconcile).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
