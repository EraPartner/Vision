/**
 * POST /bulk-export — id-mode + filter-mode streaming, format gate.
 *
 * Driven over HTTP against the real router (tests/helpers/routeApp.js), so the
 * streamed body and the download headers are read off a real response instead
 * of `res.write`/`res.setHeader` spies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockConnection } from '../helpers/repoMocks.js';
import { mockTransactionRepository, mockDeduplication, mockMaterializedViews, mockCurrencyConversion } from '../helpers/transactionsRouteMocks.js';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent } from '../helpers/routeApp.js';

vi.mock('../../src/repositories/transactionRepository.js', () => mockTransactionRepository());

vi.mock('../../src/services/deduplication.js', () => mockDeduplication());

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

vi.mock('../../src/services/materializedViewService.js', () => mockMaterializedViews());

vi.mock('../../src/services/currency/currencyConversionService.js', () => mockCurrencyConversion());

vi.mock('../../src/database/connection.js', () => mockConnection({ getClient: vi.fn() }));

const { default: transactionsRouter } = await import('../../src/routes/transactions.js');

import { query as dbQuery } from '../../src/database/connection.js';

const api = routeAgent(transactionsRouter, { mountPath: '/api/transactions' });
const bulkExport = (body) => api.post('/api/transactions/bulk-export').send(body);

const SAMPLE_ROW = {
  id: 1,
  date: '2026-05-08',
  bank_account: 'BE12 3456',
  recipient_name: 'Trader Joe',
  memo: 'Groceries',
  amount: -42.5,
  currency: 'EUR',
  balance: 100,
  category_name: 'FOOD:GROCERIES',
  comment: '',
  tags: ['weekly'],
};

describe('POST /bulk-export — validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unknown format', async () => {
    await bulkExport({ ids: [1], format: 'xml' }).expect(400);
  });

  it('rejects when neither ids nor filter is given', async () => {
    await bulkExport({ format: 'csv' }).expect(400);
  });
});

describe('POST /bulk-export — CSV success', () => {
  beforeEach(() => vi.clearAllMocks());

  it('streams CSV header and a single row to the response', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // probe
      .mockResolvedValueOnce({ rows: [SAMPLE_ROW] });        // chunk

    const res = await bulkExport({ ids: [1], format: 'csv' }).expect(200);

    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.headers['content-disposition']).toMatch(/transactions_export_/);

    expect(res.text).toMatch(/^Date,Bank Account,Recipient/);
    expect(res.text).toContain('Trader Joe');
    expect(res.text).toContain('weekly');
  });
});

describe('POST /bulk-export — NDJSON success', () => {
  beforeEach(() => vi.clearAllMocks());

  it('streams one JSON object per line', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // probe
      .mockResolvedValueOnce({ rows: [SAMPLE_ROW] });        // chunk

    const res = await bulkExport({ ids: [1], format: 'json' }).expect(200);

    expect(res.headers['content-type']).toBe('application/x-ndjson');

    const firstLine = res.text.split('\n').filter(Boolean)[0];
    const parsed = JSON.parse(firstLine);
    expect(parsed.id).toBe(1);
    expect(parsed.recipient).toBe('Trader Joe');
    expect(parsed.tags).toEqual(['weekly']);
  });
});

describe('POST /bulk-export — filter-mode resolves through bulk selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects filter requests over the cap', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ n: 7000 }] });

    await bulkExport({ filter: { search: 'big' }, format: 'csv' }).expect(400);
  });
});
