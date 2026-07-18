/**
 * Bulk-tag route tests — isolated file so we can add withTransaction to the
 * connection mock without touching the 584-line transactions.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockPooledTxConnection } from '../helpers/repoMocks.js';
import { mockTransactionRepository, mockDeduplication, mockTransferReconciliation, mockCurrencyConversion } from '../helpers/transactionsRouteMocks.js';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/repositories/transactionRepository.js', () => mockTransactionRepository());

vi.mock('../../src/services/deduplication.js', () => mockDeduplication());

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

vi.mock('../../src/services/transferReconciliationService.js', () => mockTransferReconciliation());

vi.mock('../../src/services/currency/currencyConversionService.js', () => mockCurrencyConversion());

vi.mock('../../src/database/connection.js', () => mockPooledTxConnection());

await import('../../src/routes/transactions.js');

import { getClient, query as dbQuery } from '../../src/database/connection.js';
import { scheduleReconcile } from '../../src/services/transferReconciliationService.js';

describe('POST /bulk-tag — input validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when transaction_ids is missing', async () => {
    const req = { body: { add_slugs: ['rome-2020'] } };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/bulk-tag'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when transaction_ids is empty array', async () => {
    const req = { body: { transaction_ids: [], add_slugs: ['rome-2020'] } };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/bulk-tag'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when transaction_ids exceeds 500 entries', async () => {
    const req = { body: { transaction_ids: Array.from({ length: 501 }, (_, i) => i + 1), add_slugs: ['rome'] } };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/bulk-tag'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when add_slugs exceeds 50 entries', async () => {
    const req = { body: { transaction_ids: [1], add_slugs: Array.from({ length: 51 }, (_, i) => `tag-${i}`) } };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/bulk-tag'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when both add_slugs and remove_slugs are empty', async () => {
    const req = { body: { transaction_ids: [1], add_slugs: [], remove_slugs: [] } };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/bulk-tag'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('POST /bulk-tag — unknown slug rejection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 listing unknown add slug before writing anything', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // no active tag found
    const req = { body: { transaction_ids: [1], add_slugs: ['ghost-tag'] } };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/bulk-tag'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.message).toContain('ghost-tag');
    expect(getClient).not.toHaveBeenCalled();
  });

  it('returns 400 listing unknown remove slug before writing anything', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // no tag found
    const req = { body: { transaction_ids: [1], remove_slugs: ['ghost-tag'] } };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/bulk-tag'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe('POST /bulk-tag — success paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds tags and returns correct counts', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 10, slug: 'rome-2020' }] });
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ transaction_id: 1 }, { transaction_id: 2 }] }) // INSERT
      .mockResolvedValueOnce({}); // COMMIT
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const req = { body: { transaction_ids: [1, 2], add_slugs: ['rome-2020'] } };
    const res = mockResponse();
    await routeHandlers['post:/bulk-tag'](req, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.added).toBe(2);
    expect(data.removed).toBe(0);
    expect(data.transactions_affected).toBe(2);
    expect(scheduleReconcile).toHaveBeenCalledTimes(1);
  });

  it('removes tags and returns correct counts', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 10, slug: 'rome-2020' }] });
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ transaction_id: 1 }] }) // DELETE
      .mockResolvedValueOnce({}); // COMMIT
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const req = { body: { transaction_ids: [1], remove_slugs: ['rome-2020'] } };
    const res = mockResponse();
    await routeHandlers['post:/bulk-tag'](req, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.removed).toBe(1);
    expect(data.added).toBe(0);
  });

  it('adds and removes in a single transaction', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: 10, slug: 'rome-2020' }] }) // add_slugs lookup
      .mockResolvedValueOnce({ rows: [{ id: 11, slug: 'work-trip' }] }); // remove_slugs lookup
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ transaction_id: 1 }] }) // INSERT
      .mockResolvedValueOnce({ rows: [{ transaction_id: 1 }] }) // DELETE
      .mockResolvedValueOnce({}); // COMMIT
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const req = { body: { transaction_ids: [1], add_slugs: ['rome-2020'], remove_slugs: ['work-trip'] } };
    const res = mockResponse();
    await routeHandlers['post:/bulk-tag'](req, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.added).toBe(1);
    expect(data.removed).toBe(1);
  });
});

describe('POST /bulk-tag — atomicity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rolls back and does not call scheduleReconcile when transaction fails', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 10, slug: 'rome-2020' }] });
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('DB exploded')) // INSERT fails
      .mockResolvedValueOnce({}); // ROLLBACK
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const req = { body: { transaction_ids: [1], add_slugs: ['rome-2020'] } };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/bulk-tag'], req, res);

    expect(scheduleReconcile).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    const rollbackCall = clientQuery.mock.calls.find(([sql]) => sql === 'ROLLBACK');
    expect(rollbackCall).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function mockResponse() {
  return createMockResponse({ headersSent: false });
}

async function callHandler(handler, req, res) {
  try {
    await handler(req, res);
  } catch (err) {
    const status = err.status ?? 500;
    const code = err.code ?? 'INTERNAL_SERVER_ERROR';
    res.status(status).json({ ok: false, error: { code, message: err.message } });
  }
}
