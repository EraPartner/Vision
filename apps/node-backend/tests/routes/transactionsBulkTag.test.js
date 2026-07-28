/**
 * Bulk-tag route tests — isolated file so we can add withTransaction to the
 * connection mock without touching the large transactions.test.js.
 *
 * Driven over HTTP against the real router (tests/helpers/routeApp.js): the
 * per-route rate limiter declared on POST /bulk-tag (routes/transactions.js:433)
 * and the centralized error handler are both on the tested path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockPooledTxConnection } from '../helpers/repoMocks.js';
import { mockTransactionRepository, mockDeduplication, mockTransferReconciliation, mockCurrencyConversion } from '../helpers/transactionsRouteMocks.js';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent } from '../helpers/routeApp.js';

vi.mock('../../src/repositories/transactionRepository.js', () => mockTransactionRepository());

vi.mock('../../src/services/deduplication.js', () => mockDeduplication());

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

vi.mock('../../src/services/transferReconciliationService.js', () => mockTransferReconciliation());

vi.mock('../../src/services/currency/currencyConversionService.js', () => mockCurrencyConversion());

vi.mock('../../src/database/connection.js', () => mockPooledTxConnection());

const { default: transactionsRouter } = await import('../../src/routes/transactions.js');

import { getClient, query as dbQuery } from '../../src/database/connection.js';
import { scheduleReconcile } from '../../src/services/transferReconciliationService.js';

const api = routeAgent(transactionsRouter, { mountPath: '/api/transactions' });
const bulkTag = (body) => api.post('/api/transactions/bulk-tag').send(body);

describe('POST /bulk-tag — input validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when transaction_ids is missing', async () => {
    await bulkTag({ add_slugs: ['rome-2020'] }).expect(400);
  });

  it('returns 400 when transaction_ids is empty array', async () => {
    await bulkTag({ transaction_ids: [], add_slugs: ['rome-2020'] }).expect(400);
  });

  it('returns 400 when transaction_ids exceeds 500 entries', async () => {
    await bulkTag({
      transaction_ids: Array.from({ length: 501 }, (_, i) => i + 1),
      add_slugs: ['rome'],
    }).expect(400);
  });

  it('returns 400 when add_slugs exceeds 50 entries', async () => {
    await bulkTag({
      transaction_ids: [1],
      add_slugs: Array.from({ length: 51 }, (_, i) => `tag-${i}`),
    }).expect(400);
  });

  it('returns 400 when both add_slugs and remove_slugs are empty', async () => {
    await bulkTag({ transaction_ids: [1], add_slugs: [], remove_slugs: [] }).expect(400);
  });
});

describe('POST /bulk-tag — unknown slug rejection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 listing unknown add slug before writing anything', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // no active tag found

    const res = await bulkTag({ transaction_ids: [1], add_slugs: ['ghost-tag'] }).expect(400);

    expect(res.body.error.message).toContain('ghost-tag');
    expect(getClient).not.toHaveBeenCalled();
  });

  it('returns 400 listing unknown remove slug before writing anything', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // no tag found

    await bulkTag({ transaction_ids: [1], remove_slugs: ['ghost-tag'] }).expect(400);

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

    const res = await bulkTag({ transaction_ids: [1, 2], add_slugs: ['rome-2020'] }).expect(200);

    expect(res.body.data.added).toBe(2);
    expect(res.body.data.removed).toBe(0);
    expect(res.body.data.transactions_affected).toBe(2);
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

    const res = await bulkTag({ transaction_ids: [1], remove_slugs: ['rome-2020'] }).expect(200);

    expect(res.body.data.removed).toBe(1);
    expect(res.body.data.added).toBe(0);
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

    const res = await bulkTag({
      transaction_ids: [1], add_slugs: ['rome-2020'], remove_slugs: ['work-trip'],
    }).expect(200);

    expect(res.body.data.added).toBe(1);
    expect(res.body.data.removed).toBe(1);
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

    const res = await bulkTag({ transaction_ids: [1], add_slugs: ['rome-2020'] }).expect(500);

    expect(scheduleReconcile).not.toHaveBeenCalled();
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    const rollbackCall = clientQuery.mock.calls.find(([sql]) => sql === 'ROLLBACK');
    expect(rollbackCall).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
