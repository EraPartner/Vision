/**
 * POST /bulk-export — id-mode + filter-mode streaming, format gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockConnection } from '../helpers/repoMocks.js';
import { mockTransactionRepository, mockDeduplication, mockMaterializedViews, mockCurrencyConversion } from '../helpers/transactionsRouteMocks.js';
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

vi.mock('../../src/services/materializedViewService.js', () => mockMaterializedViews());

vi.mock('../../src/services/currency/currencyConversionService.js', () => mockCurrencyConversion());

vi.mock('../../src/database/connection.js', () => mockConnection({ getClient: vi.fn() }));

await import('../../src/routes/transactions.js');

import { query as dbQuery } from '../../src/database/connection.js';

const handler = routeHandlers['post:/bulk-export'];

function mockResponse() {
  return createMockResponse({ setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), headersSent: false });
}

async function callHandler(req, res) {
  try {
    await handler(req, res);
  } catch (err) {
    const status = err.status ?? 500;
    res.status(status).json({ ok: false, error: { code: err.code ?? 'INTERNAL_SERVER_ERROR', message: err.message } });
  }
}

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
    const res = mockResponse();
    await callHandler({ body: { ids: [1], format: 'xml' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects when neither ids nor filter is given', async () => {
    const res = mockResponse();
    await callHandler({ body: { format: 'csv' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('POST /bulk-export — CSV success', () => {
  beforeEach(() => vi.clearAllMocks());

  it('streams CSV header and a single row to the response', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // probe
      .mockResolvedValueOnce({ rows: [SAMPLE_ROW] });        // chunk

    const res = mockResponse();
    await callHandler({ body: { ids: [1], format: 'csv' } }, res);

    const headers = res.setHeader.mock.calls;
    expect(headers.find(([k]) => k === 'Content-Type')[1]).toBe('text/csv');
    expect(headers.find(([k]) => k === 'Content-Disposition')[1]).toMatch(/transactions_export_/);

    const writes = res.write.mock.calls.map(([s]) => s);
    expect(writes[0]).toMatch(/^Date,Bank Account,Recipient/);
    expect(writes.join('')).toContain('Trader Joe');
    expect(writes.join('')).toContain('weekly');
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});

describe('POST /bulk-export — NDJSON success', () => {
  beforeEach(() => vi.clearAllMocks());

  it('streams one JSON object per line', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // probe
      .mockResolvedValueOnce({ rows: [SAMPLE_ROW] });        // chunk

    const res = mockResponse();
    await callHandler({ body: { ids: [1], format: 'json' } }, res);

    const ctype = res.setHeader.mock.calls.find(([k]) => k === 'Content-Type')[1];
    expect(ctype).toBe('application/x-ndjson');

    const body = res.write.mock.calls.map(([s]) => s).join('');
    const firstLine = body.split('\n').filter(Boolean)[0];
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

    const res = mockResponse();
    await callHandler({ body: { filter: { search: 'big' }, format: 'csv' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
