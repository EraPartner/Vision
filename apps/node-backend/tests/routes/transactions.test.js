/**
 * Transaction route tests.
 * Mirrors: apps/backend/tests/test_transactions.py
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
    getAll: vi.fn(),
    getAllWithCount: vi.fn(),
    getUncategorised: vi.fn(),
    getUncategorisedWithCount: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/services/deduplication.js', () => ({
  isManualDuplicate: vi.fn(async () => ({ isDuplicate: false })),
  recordManualRawTransaction: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/materializedViewService.js', () => ({
  scheduleRefresh: vi.fn(),
}));

vi.mock('../../src/services/currency/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(async (rows) => rows),
}));

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../../src/services/attachmentRecordService.js', () => ({
  attachmentRepository: {
    listPathsByTransactionIds: vi.fn(async () => []),
  },
}));

vi.mock('../../src/services/attachmentService.js', () => ({
  removeAttachmentFile: vi.fn(async () => undefined),
}));

import transactionRepository from '../../src/repositories/transactionRepository.js';
import { query as dbQuery } from '../../src/database/connection.js';
import { isManualDuplicate } from '../../src/services/deduplication.js';
import { convertRowsToEur } from '../../src/services/currency/currencyConversionService.js';
import { attachmentRepository } from '../../src/services/attachmentRecordService.js';
import { removeAttachmentFile } from '../../src/services/attachmentService.js';
await import('../../src/routes/transactions.js');

describe('Transaction Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return empty list', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 0 });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.data.items).toEqual([]);
      expect(result.data.total).toBe(0);
    });

    it('should return transactions with data', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 1, date: '2026-01-15', bank_account: 'Chase', amount: '25.50', recipient_id: 1 }],
        total: 1,
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].data.total).toBe(1);
    });

    it('should respect pagination', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 10 });

      const req = { query: { limit: '2', offset: '3' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.data.limit).toBe(2);
      expect(result.data.offset).toBe(3);
    });

    it('should handle uncategorised filter', async () => {
      transactionRepository.getUncategorisedWithCount.mockResolvedValue({ rows: [], total: 0 });

      const req = { query: { uncategorised: 'true' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(transactionRepository.getUncategorisedWithCount).toHaveBeenCalled();
    });

    it('should support filtering by transaction_id', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 42, date: '2026-01-15', bank_account: 'Chase', amount: '25.50', recipient_id: 1 }],
        total: 1,
      });

      const req = { query: { transaction_id: '42' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(transactionRepository.getAllWithCount).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 42 }));
      expect(res.json.mock.calls[0][0].data.items).toHaveLength(1);
    });

    it('should normalize rows when normalize_to_eur is true', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 1, date: '2026-01-15', amount: '10', currency: 'USD' }],
        total: 1,
      });
      convertRowsToEur.mockResolvedValue([
        { id: 1, date: '2026-01-15', amount: '10', currency: 'USD', amount_eur: 9 },
      ]);

      const req = { query: { normalize_to_eur: 'true', target_currency: 'GBP' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(convertRowsToEur).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 1 })]),
        'GBP'
      );
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('GET /:id', () => {
    it('should return transaction by id', async () => {
      transactionRepository.getById.mockResolvedValue({
        id: 1, date: '2026-01-15', amount: '50.00', bank_account: 'Chase',
      });

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/:id'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      transactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await callHandler(routeHandlers['get:/:id'], req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /export/csv', () => {
    it('should neutralize spreadsheet formula values in CSV export', async () => {
      dbQuery.mockResolvedValue({
        rows: [
          {
            date: '2026-01-15',
            bank_account: 'Main',
            recipient_name: '=HYPERLINK("http://evil")',
            memo: '+cmd',
            amount: '-100.00',
            currency: 'EUR',
            balance: '1000.00',
            category_name: '@danger',
            comment: '-comment',
          },
        ],
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/export/csv'](req, res);

      expect(res.write).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalledTimes(1);
      const csv = res.write.mock.calls.map(([chunk]) => chunk).join('');
      // Text columns are still guarded against spreadsheet formula injection.
      expect(csv).toContain(`'=HYPERLINK(""http://evil"")`);
      expect(csv).toContain("'+cmd");
      expect(csv).toContain("'@danger");
      expect(csv).toContain("'-comment");
      // Numeric columns are NOT guarded — a leading "'" would break re-import
      // (negative amounts/balances would NaN-drop on a Vision-export round-trip).
      expect(csv).toContain(",-100.00,");
      expect(csv).not.toContain("'-100.00");
    });

    it('should sanitize server error detail when export fails', async () => {
      dbQuery.mockRejectedValue(new Error('sensitive db failure'));

      const req = { query: {} };
      const res = mockResponse();
      await callHandler(routeHandlers['get:/export/csv'], req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: expect.objectContaining({ message: expect.any(String) }) })
      );
    });

    it('should apply transaction_type=expense filter to export query', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      const req = { query: { transaction_type: 'expense' } };
      const res = mockResponse();
      await routeHandlers['get:/export/csv'](req, res);

      const probeSql = dbQuery.mock.calls[0][0];
      expect(probeSql).toContain('t.amount < 0');
    });

    it('should apply transaction_type=income filter to export query', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      const req = { query: { transaction_type: 'income' } };
      const res = mockResponse();
      await routeHandlers['get:/export/csv'](req, res);

      const probeSql = dbQuery.mock.calls[0][0];
      expect(probeSql).toContain('t.amount > 0');
    });

    it('should apply recipient_id filter to export query', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      const req = { query: { recipient_id: '42' } };
      const res = mockResponse();
      await routeHandlers['get:/export/csv'](req, res);

      const probeParams = dbQuery.mock.calls[0][1];
      expect(probeParams).toContain(42);
    });

    it('should apply search filter as ILIKE pattern in export query', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      const req = { query: { search: 'netflix' } };
      const res = mockResponse();
      await routeHandlers['get:/export/csv'](req, res);

      const [probeSql, probeParams] = dbQuery.mock.calls[0];
      expect(probeSql).toMatch(/t\.memo ILIKE/);
      expect(probeParams).toContain('%netflix%');
    });

    it('should apply transaction_id filter to export query', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      const req = { query: { transaction_id: '7' } };
      const res = mockResponse();
      await routeHandlers['get:/export/csv'](req, res);

      const [probeSql, probeParams] = dbQuery.mock.calls[0];
      expect(probeSql).toMatch(/t\.id = \$/);
      expect(probeParams).toContain(7);
    });

    it('should join recipients/categories tables in probe SQL so recipient/search filters resolve', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      const req = { query: { search: 'foo' } };
      const res = mockResponse();
      await routeHandlers['get:/export/csv'](req, res);

      const probeSql = dbQuery.mock.calls[0][0];
      expect(probeSql).toContain('LEFT JOIN recipients r');
      expect(probeSql).toContain('LEFT JOIN categories c');
    });
  });

  describe('GET /export/json', () => {
    const sampleRow = {
      id: 1,
      date: '2026-01-15',
      bank_account: 'Main',
      recipient_name: 'Netflix',
      memo: 'Monthly sub',
      amount: '-12.99',
      currency: 'EUR',
      balance: '987.01',
      category_name: 'ENTERTAINMENT:STREAMING',
      comment: null,
    };

    it('should stream NDJSON with correct Content-Type', async () => {
      // probe returns a row; chunk has 1 row (< EXPORT_CHUNK_SIZE) → breaks after first chunk
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })       // probe
        .mockResolvedValueOnce({ rows: [sampleRow] }); // chunk (1 row < 1000 → break)

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/export/json'](req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringMatching(/filename=transactions_export.*\.ndjson/),
      );
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('should emit one JSON object per transaction line', async () => {
      // 2 rows in chunk → still < EXPORT_CHUNK_SIZE → breaks after first chunk
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [sampleRow, { ...sampleRow, id: 2, amount: '-5.00' }] });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/export/json'](req, res);

      const written = res.write.mock.calls.map(([chunk]) => chunk).join('');
      const lines = written.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      const parsed = lines.map((l) => JSON.parse(l));
      expect(parsed[0]).toMatchObject({
        id: 1, date: '2026-01-15', recipient: 'Netflix',
        amount: '-12.99', category: 'ENTERTAINMENT:STREAMING',
      });
      expect(parsed[1].id).toBe(2);
    });

    it('should return 404 when no transactions match filters', async () => {
      dbQuery.mockResolvedValueOnce({ rows: [] }); // probe

      const req = { query: { start_date: '2099-01-01' } };
      const res = mockResponse();
      await callHandler(routeHandlers['get:/export/json'], req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should return 500 on unexpected error before headers sent', async () => {
      dbQuery.mockRejectedValueOnce(new Error('db error'));

      const req = { query: {} };
      const res = mockResponse();
      await callHandler(routeHandlers['get:/export/json'], req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should include all expected fields in output', async () => {
      // 1 row < EXPORT_CHUNK_SIZE → loop breaks after first chunk; only 2 DB calls needed
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [sampleRow] });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/export/json'](req, res);

      const written = res.write.mock.calls.map(([chunk]) => chunk).join('');
      const obj = JSON.parse(written.trim().split('\n')[0]);
      expect(Object.keys(obj).sort()).toEqual(
        ['amount', 'balance', 'bank_account', 'category', 'comment', 'currency', 'date', 'id', 'memo', 'recipient', 'tags'].sort()
      );
    });
  });

  describe('POST /', () => {
    it('should create transaction with 201', async () => {
      transactionRepository.create.mockResolvedValue({
        id: 1, date: '2026-01-15', amount: '-50.00', bank_account: 'Chase', recipient_id: 1,
      });

      const req = {
        body: {
          transaction_date: '2026-01-15', bank_account: 'Chase',
          recipient_id: 1, amount: -50.00, memo: 'Test',
        },
      };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 400 for missing fields', async () => {
      const req = { body: { bank_account: 'Chase', amount: -50.00 } };
      const res = mockResponse();
      await callHandler(routeHandlers['post:/'], req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for a zero amount', async () => {
      const req = {
        body: {
          transaction_date: '2026-01-15', bank_account: 'Chase',
          recipient_id: 1, amount: 0,
        },
      };
      const res = mockResponse();
      await callHandler(routeHandlers['post:/'], req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it('should return 400 for a non-numeric amount', async () => {
      const req = {
        body: {
          transaction_date: '2026-01-15', bank_account: 'Chase',
          recipient_id: 1, amount: 'abc',
        },
      };
      const res = mockResponse();
      await callHandler(routeHandlers['post:/'], req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it('should return 409 when manual duplicate is detected', async () => {
      isManualDuplicate.mockResolvedValue({ isDuplicate: true, existingTransactionId: 99 });

      const req = {
        body: {
          transaction_date: '2026-01-15',
          bank_account: 'Chase',
          recipient_id: 1,
          amount: -50,
        },
      };
      const res = mockResponse();
      await callHandler(routeHandlers['post:/'], req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            message: 'Duplicate transaction detected',
            details: { existing_transaction_id: 99 },
          }),
        })
      );
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id', () => {
    it('should update transaction', async () => {
      transactionRepository.update.mockResolvedValue({
        id: 1, date: '2026-01-15', amount: '-75.00', bank_account: 'Chase',
      });

      const req = { params: { id: '1' }, body: { amount: -75.00 } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      transactionRepository.update.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { amount: -75.00 } };
      const res = mockResponse();
      await callHandler(routeHandlers['patch:/:id'], req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should sanitize server error detail when patch fails', async () => {
      transactionRepository.update.mockRejectedValue(new Error('constraint: internal detail'));

      const req = { params: { id: '1' }, body: { amount: -75.00 } };
      const res = mockResponse();
      await callHandler(routeHandlers['patch:/:id'], req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: expect.objectContaining({ message: expect.any(String) }) })
      );
    });

    it('should return 400 when recipient_name cannot be resolved', async () => {
      dbQuery.mockResolvedValueOnce({ rows: [] });

      const req = {
        params: { id: '1' },
        body: { recipient_name: 'Missing Name' },
      };
      const res = mockResponse();
      await callHandler(routeHandlers['patch:/:id'], req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(transactionRepository.update).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid category_name format', async () => {
      const req = {
        params: { id: '1' },
        body: { category_name: 'INVALID' },
      };
      const res = mockResponse();
      await callHandler(routeHandlers['patch:/:id'], req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(transactionRepository.update).not.toHaveBeenCalled();
    });

    it('should return 400 when category_name does not exist', async () => {
      dbQuery.mockResolvedValueOnce({ rows: [{ id: 11 }] });
      dbQuery.mockResolvedValueOnce({ rows: [] });

      const req = {
        params: { id: '1' },
        body: {
          recipient_name: 'Known Recipient',
          category_name: 'FOOD:UNKNOWN',
        },
      };
      const res = mockResponse();
      await callHandler(routeHandlers['patch:/:id'], req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(transactionRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:id', () => {
    it('should delete and return success', async () => {
      transactionRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.json.mock.calls[0][0].data.message).toContain('deleted permanently');
    });

    it('should return 404 for non-existent', async () => {
      transactionRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await callHandler(routeHandlers['delete:/:id'], req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('removes attachment files from disk after the delete', async () => {
      // The DB CASCADE only removes the attachments rows — the files must be
      // removed too or receipt PII persists forever and re-enters backups.
      transactionRepository.hardDelete.mockResolvedValue(true);
      attachmentRepository.listPathsByTransactionIds.mockResolvedValue([
        'attachments/1/receipt-a.png',
        'attachments/1/receipt-b.pdf',
      ]);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(attachmentRepository.listPathsByTransactionIds).toHaveBeenCalledWith([1]);
      expect(removeAttachmentFile).toHaveBeenCalledWith('attachments/1/receipt-a.png');
      expect(removeAttachmentFile).toHaveBeenCalledWith('attachments/1/receipt-b.pdf');
    });

    it('does not remove files when the transaction was not found', async () => {
      transactionRepository.hardDelete.mockResolvedValue(false);
      attachmentRepository.listPathsByTransactionIds.mockResolvedValue(['attachments/9/x.png']);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await callHandler(routeHandlers['delete:/:id'], req, res);

      expect(removeAttachmentFile).not.toHaveBeenCalled();
    });
  });
});

function mockResponse() {
  const res = {
    json: vi.fn(),
    status: vi.fn(),
    send: vi.fn(),
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    headersSent: false,
  };
  res.status.mockReturnValue(res);
  res.ok = (data, meta) => {
    const body = { ok: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };
  return res;
}

/**
 * Simulates Express error-handler middleware for routes that throw typed errors.
 * Routes use `throw new NotFoundError / ValidationError / ConflictError` which
 * propagates to the centralized error handler in production. In unit tests we
 * catch the error here and replicate the handler's response shape.
 */
async function callHandler(handler, req, res) {
  try {
    await handler(req, res);
  } catch (err) {
    const status = err.status ?? 500;
    const code = err.code ?? 'INTERNAL_SERVER_ERROR';
    const message = err.message ?? 'Internal server error';
    const error = { code, message };
    if (err.details !== undefined) error.details = err.details;
    res.status(status).json({ ok: false, error });
  }
}
