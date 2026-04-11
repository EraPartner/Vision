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

vi.mock('../../src/services/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(async (rows) => rows),
}));

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import transactionRepository from '../../src/repositories/transactionRepository.js';
import { query as dbQuery } from '../../src/database/connection.js';
import { isManualDuplicate } from '../../src/services/deduplication.js';
import { convertRowsToEur } from '../../src/services/currencyConversionService.js';
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
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return transactions with data', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 1, date: '2026-01-15', bank_account: 'Chase', amount: '25.50', recipient_id: 1 }],
        total: 1,
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].total).toBe(1);
    });

    it('should respect pagination', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 10 });

      const req = { query: { limit: '2', offset: '3' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(3);
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
      expect(res.json.mock.calls[0][0].items).toHaveLength(1);
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
      await routeHandlers['get:/:id'](req, res);

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

      expect(res.send).toHaveBeenCalledTimes(1);
      const csv = res.send.mock.calls[0][0];
      expect(csv).toContain(`'=HYPERLINK(""http://evil"")`);
      expect(csv).toContain("'+cmd");
      expect(csv).toContain("'-100.00");
      expect(csv).toContain("'@danger");
      expect(csv).toContain("'-comment");
    });

    it('should sanitize server error detail when export fails', async () => {
      dbQuery.mockRejectedValue(new Error('sensitive db failure'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/export/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error exporting transactions' });
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
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
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
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: 'Duplicate transaction detected',
          existing_transaction_id: 99,
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
      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should sanitize server error detail when patch fails', async () => {
      transactionRepository.update.mockRejectedValue(new Error('constraint: internal detail'));

      const req = { params: { id: '1' }, body: { amount: -75.00 } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error updating transaction' });
    });

    it('should return 400 when recipient_name cannot be resolved', async () => {
      dbQuery.mockResolvedValueOnce({ rows: [] });

      const req = {
        params: { id: '1' },
        body: { recipient_name: 'Missing Name' },
      };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(transactionRepository.update).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid category_name format', async () => {
      const req = {
        params: { id: '1' },
        body: { category_name: 'INVALID' },
      };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

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
      await routeHandlers['patch:/:id'](req, res);

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

      expect(res.json.mock.calls[0][0].message).toContain('deleted permanently');
    });

    it('should return 404 for non-existent', async () => {
      transactionRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
