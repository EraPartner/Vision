/**
 * Transaction route tests.
 * Mirrors: apps/backend/tests/test_transactions.py
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js) — so the per-route middleware chain
 * (validateIdParam, the export rate limiters), Express query/body parsing, the
 * ADR-026 envelope middleware and the centralized error handler are all on the
 * tested path. Repositories/services are still mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockConnection } from '../helpers/repoMocks.js';
import { mockTransactionRepository, mockDeduplication, mockMaterializedViews, mockCurrencyConversion, mockAttachmentRecordService, mockAttachmentService } from '../helpers/transactionsRouteMocks.js';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, okEnvelope, errEnvelope } from '../helpers/routeApp.js';

vi.mock('../../src/repositories/transactionRepository.js', () => mockTransactionRepository());

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

vi.mock('../../src/services/deduplication.js', () => mockDeduplication());

vi.mock('../../src/services/materializedViewService.js', () => mockMaterializedViews());

vi.mock('../../src/services/currency/currencyConversionService.js', () => mockCurrencyConversion());

vi.mock('../../src/database/connection.js', () => mockConnection());

vi.mock('../../src/services/attachmentRecordService.js', () => mockAttachmentRecordService());

vi.mock('../../src/services/attachmentService.js', () => mockAttachmentService());

vi.mock('../../src/services/transferReconciliationService.js', () => ({
  scheduleReconcile: vi.fn(),
  getTransferSuggestions: vi.fn(async () => []),
  markTransfer: vi.fn(),
  unmarkTransfer: vi.fn(),
}));

import transactionRepository from '../../src/repositories/transactionRepository.js';
import { unmarkTransfer, scheduleReconcile } from '../../src/services/transferReconciliationService.js';
import { query as dbQuery } from '../../src/database/connection.js';
import { isManualDuplicate } from '../../src/services/deduplication.js';
import { convertRowsToEur } from '../../src/services/currency/currencyConversionService.js';
import { attachmentRepository } from '../../src/services/attachmentRecordService.js';
import { removeAttachmentFile } from '../../src/services/attachmentService.js';

const { default: transactionsRouter } = await import('../../src/routes/transactions.js');

const api = routeAgent(transactionsRouter, { mountPath: '/api/transactions' });
// Same router behind an error handler in production mode (main.js:401 passes
// `settings.isProduction`), so the 5xx message-sanitization branch
// (errorHandler.js:139-141) is actually exercised rather than assumed.
const apiProd = routeAgent(transactionsRouter, {
  mountPath: '/api/transactions',
  isProduction: () => true,
});

const PROD_5XX_MESSAGE = 'An internal server error occurred. Please try again later.';

describe('Transaction Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-arm the factory defaults that clearAllMocks wipes.
    isManualDuplicate.mockResolvedValue({ isDuplicate: false });
    convertRowsToEur.mockImplementation(async (rows) => rows);
    attachmentRepository.listPathsByTransactionIds.mockResolvedValue([]);
  });

  describe('GET /', () => {
    it('should return empty list', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 0 });

      const res = await api.get('/api/transactions/').expect(200);

      expect(res.body).toEqual(okEnvelope({
        items: [], total: 0, limit: expect.any(Number), offset: 0, links: [],
      }));
    });

    it('should return transactions with data', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 1, date: '2026-01-15', bank_account: 'Chase', amount: '25.50', recipient_id: 1 }],
        total: 1,
      });

      const res = await api.get('/api/transactions/').expect(200);

      expect(res.body.data.total).toBe(1);
    });

    it('should respect pagination', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 10 });

      const res = await api.get('/api/transactions/?limit=2&offset=3').expect(200);

      expect(res.body.data.limit).toBe(2);
      expect(res.body.data.offset).toBe(3);
    });

    it('should handle uncategorised filter', async () => {
      transactionRepository.getUncategorisedWithCount.mockResolvedValue({ rows: [], total: 0 });

      await api.get('/api/transactions/?uncategorised=true').expect(200);

      expect(transactionRepository.getUncategorisedWithCount).toHaveBeenCalled();
    });

    it('should support filtering by transaction_id', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 42, date: '2026-01-15', bank_account: 'Chase', amount: '25.50', recipient_id: 1 }],
        total: 1,
      });

      const res = await api.get('/api/transactions/?transaction_id=42').expect(200);

      expect(transactionRepository.getAllWithCount).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 42 }));
      expect(res.body.data.items).toHaveLength(1);
    });

    it('should normalize rows when normalize_to_eur is true', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 1, date: '2026-01-15', amount: '10', currency: 'USD' }],
        total: 1,
      });
      convertRowsToEur.mockResolvedValue([
        { id: 1, date: '2026-01-15', amount: '10', currency: 'USD', amount_eur: 9 },
      ]);

      const res = await api
        .get('/api/transactions/?normalize_to_eur=true&target_currency=GBP')
        .expect(200);

      expect(convertRowsToEur).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 1 })]),
        'GBP'
      );
      expect(res.body.data.items[0].amount_eur).toBe(9);
    });

    it('should thread include_balance to the repository and expose running_balance on rows (WP-B4)', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{
          id: 1, date: '2026-01-15', bank_account: 'Chase', amount: '-25.50',
          recipient_id: 1, running_balance: '974.50',
        }],
        total: 1,
      });

      const res = await api
        .get('/api/transactions/?include_balance=true&account_id=3')
        .expect(200);

      expect(transactionRepository.getAllWithCount).toHaveBeenCalledWith(
        expect.objectContaining({ includeBalance: true, accountId: 3 }),
      );
      expect(res.body.data.items[0].running_balance).toBe(974.5);
    });

    it('should omit the running_balance key entirely when include_balance is not set', async () => {
      transactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 1, date: '2026-01-15', bank_account: 'Chase', amount: '25.50', recipient_id: 1 }],
        total: 1,
      });

      const res = await api.get('/api/transactions/').expect(200);

      expect(transactionRepository.getAllWithCount).toHaveBeenCalledWith(
        expect.objectContaining({ includeBalance: false }),
      );
      expect('running_balance' in res.body.data.items[0]).toBe(false);
    });

    it('rejects a malformed account_id through the real validation guard (400 envelope)', async () => {
      const res = await api.get('/api/transactions/?account_id=abc').expect(400);

      expect(res.body).toEqual(errEnvelope({
        code: 'VALIDATION_ERROR',
        message: 'account_id must be a positive integer',
      }));
      expect(transactionRepository.getAllWithCount).not.toHaveBeenCalled();
    });
  });

  describe('GET /:id', () => {
    it('should return transaction by id', async () => {
      transactionRepository.getById.mockResolvedValue({
        id: 1, date: '2026-01-15', amount: '50.00', bank_account: 'Chase',
      });

      const res = await api.get('/api/transactions/1').expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.data.id).toBe(1);
    });

    it('should return 404 for non-existent', async () => {
      transactionRepository.getById.mockResolvedValue(null);

      const res = await api.get('/api/transactions/99999').expect(404);

      expect(res.body).toEqual(errEnvelope({
        code: 'NOT_FOUND',
        message: 'Transaction with ID 99999 not found',
      }));
    });

    it('rejects a non-integer :id via validateIdParam before the handler runs', async () => {
      // validateIdParam is registered BEFORE the handler on this route
      // (routes/transactions.js:523). The old mock-router harness kept only the
      // last handler, so this guard was never on the tested path.
      const res = await api.get('/api/transactions/abc').expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(transactionRepository.getById).not.toHaveBeenCalled();
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

      const res = await api.get('/api/transactions/export/csv').expect(200);

      const csv = res.text;
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

      const res = await apiProd.get('/api/transactions/export/csv').expect(500);

      expect(res.body).toEqual(errEnvelope({
        code: 'INTERNAL_SERVER_ERROR',
        message: PROD_5XX_MESSAGE,
      }));
      expect(res.text).not.toContain('sensitive db failure');
    });

    it('should apply transaction_type=expense filter to export query', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      await api.get('/api/transactions/export/csv?transaction_type=expense').expect(200);

      const probeSql = dbQuery.mock.calls[0][0];
      expect(probeSql).toContain('t.amount < 0');
    });

    it('should apply transaction_type=income filter to export query', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      await api.get('/api/transactions/export/csv?transaction_type=income').expect(200);

      const probeSql = dbQuery.mock.calls[0][0];
      expect(probeSql).toContain('t.amount > 0');
    });

    it('should apply recipient_id filter to export query', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      await api.get('/api/transactions/export/csv?recipient_id=42').expect(200);

      const probeParams = dbQuery.mock.calls[0][1];
      expect(probeParams).toContain(42);
    });

    it('should apply search filter as ILIKE pattern in export query', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      await api.get('/api/transactions/export/csv?search=netflix').expect(200);

      const [probeSql, probeParams] = dbQuery.mock.calls[0];
      expect(probeSql).toMatch(/t\.memo ILIKE/);
      expect(probeParams).toContain('%netflix%');
    });

    it('should apply transaction_id filter to export query', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      await api.get('/api/transactions/export/csv?transaction_id=7').expect(200);

      const [probeSql, probeParams] = dbQuery.mock.calls[0];
      expect(probeSql).toMatch(/t\.id = \$/);
      expect(probeParams).toContain(7);
    });

    it('should join recipients/categories tables in probe SQL so recipient/search filters resolve', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      await api.get('/api/transactions/export/csv?search=foo').expect(200);

      const probeSql = dbQuery.mock.calls[0][0];
      expect(probeSql).toContain('LEFT JOIN recipients r');
      expect(probeSql).toContain('LEFT JOIN categories c');
    });

    it('sets the streamed CSV download headers', async () => {
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await api.get('/api/transactions/export/csv').expect(200);

      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/filename=transactions_export.*\.csv/);
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

      const res = await api.get('/api/transactions/export/json').expect(200);

      expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
      expect(res.headers['content-disposition']).toMatch(/filename=transactions_export.*\.ndjson/);
    });

    it('should emit one JSON object per transaction line', async () => {
      // 2 rows in chunk → still < EXPORT_CHUNK_SIZE → breaks after first chunk
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [sampleRow, { ...sampleRow, id: 2, amount: '-5.00' }] });

      const res = await api.get('/api/transactions/export/json').expect(200);

      const lines = res.text.trim().split('\n').filter(Boolean);
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

      const res = await api
        .get('/api/transactions/export/json?start_date=2099-01-01')
        .expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('should return 500 on unexpected error before headers sent', async () => {
      dbQuery.mockRejectedValueOnce(new Error('db error'));

      const res = await api.get('/api/transactions/export/json').expect(500);

      expect(res.body.ok).toBe(false);
    });

    it('should include all expected fields in output', async () => {
      // 1 row < EXPORT_CHUNK_SIZE → loop breaks after first chunk; only 2 DB calls needed
      dbQuery
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [sampleRow] });

      const res = await api.get('/api/transactions/export/json').expect(200);

      const obj = JSON.parse(res.text.trim().split('\n')[0]);
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

      const res = await api
        .post('/api/transactions/')
        .send({
          transaction_date: '2026-01-15', bank_account: 'Chase',
          recipient_id: 1, amount: -50.00, memo: 'Test',
        })
        .expect(201);

      expect(res.body.ok).toBe(true);
      expect(res.body.data.id).toBe(1);
    });

    it('should return 400 for missing fields', async () => {
      const res = await api
        .post('/api/transactions/')
        .send({ bank_account: 'Chase', amount: -50.00 })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for a zero amount', async () => {
      await api
        .post('/api/transactions/')
        .send({
          transaction_date: '2026-01-15', bank_account: 'Chase',
          recipient_id: 1, amount: 0,
        })
        .expect(400);

      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it('should return 400 for a non-numeric amount', async () => {
      await api
        .post('/api/transactions/')
        .send({
          transaction_date: '2026-01-15', bank_account: 'Chase',
          recipient_id: 1, amount: 'abc',
        })
        .expect(400);

      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it('should return 409 when manual duplicate is detected', async () => {
      isManualDuplicate.mockResolvedValue({ isDuplicate: true, existingTransactionId: 99 });

      const res = await api
        .post('/api/transactions/')
        .send({
          transaction_date: '2026-01-15',
          bank_account: 'Chase',
          recipient_id: 1,
          amount: -50,
        })
        .expect(409);

      expect(res.body).toEqual(errEnvelope({
        code: 'CONFLICT',
        message: 'Duplicate transaction detected',
        details: { existing_transaction_id: 99 },
      }));
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it('PIN: a malformed JSON body yields a 500 INTERNAL_SERVER_ERROR, not a 400', async () => {
      // body-parser raises a SyntaxError carrying `status = 400`, but
      // createErrorHandler only honours `err.status` for AppError instances
      // (src/middleware/errorHandler.js:117-119), so a client typo is reported
      // as a server fault. Pinning current production behavior — the mock-router
      // harness never ran a body parser, so this path was invisible.
      const res = await api
        .post('/api/transactions/')
        .set('Content-Type', 'application/json')
        .send('{"amount": ');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('PIN: an over-limit body yields a 500, and in production the reason is hidden', async () => {
      // Same root cause as the malformed-JSON pin: body-parser's
      // PayloadTooLargeError carries `status = 413` but is not an AppError, so
      // errorHandler.js:117-119 maps it to 500. In production the 5xx branch
      // (errorHandler.js:139-141) then replaces "request entity too large" with
      // the generic message, so a client that posted a too-large bulk payload
      // cannot tell why it failed.
      const oversize = { memo: 'x'.repeat(1024 * 1024 + 100) };

      const dev = await api.post('/api/transactions/').send(oversize);
      expect(dev.status).toBe(500);
      expect(dev.body.error.message).toBe('request entity too large');

      const prod = await apiProd.post('/api/transactions/').send(oversize);
      expect(prod.status).toBe(500);
      expect(prod.body.error.message).toBe(PROD_5XX_MESSAGE);
    });

    it('the CSRF guard blocks a cross-site POST before the router runs', async () => {
      const res = await api
        .post('/api/transactions/')
        .set('Sec-Fetch-Site', 'cross-site')
        .send({ transaction_date: '2026-01-15', bank_account: 'Chase', recipient_id: 1, amount: -1 })
        .expect(403);

      expect(res.body).toEqual(errEnvelope({
        code: 'FORBIDDEN',
        message: 'Cross-site request blocked',
      }));
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id', () => {
    it('should update transaction', async () => {
      transactionRepository.update.mockResolvedValue({
        id: 1, date: '2026-01-15', amount: '-75.00', bank_account: 'Chase',
      });

      const res = await api
        .patch('/api/transactions/1')
        .send({ amount: -75.00 })
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.data.amount).toBe(-75);
    });

    it('should return 404 for non-existent', async () => {
      transactionRepository.update.mockResolvedValue(null);

      await api.patch('/api/transactions/99999').send({ amount: -75.00 }).expect(404);
    });

    it('should sanitize server error detail when patch fails', async () => {
      transactionRepository.update.mockRejectedValue(new Error('constraint: internal detail'));

      const res = await apiProd.patch('/api/transactions/1').send({ amount: -75.00 }).expect(500);

      expect(res.body).toEqual(errEnvelope({
        code: 'INTERNAL_SERVER_ERROR',
        message: PROD_5XX_MESSAGE,
      }));
      expect(res.text).not.toContain('internal detail');
    });

    it('should return 400 when recipient_name cannot be resolved', async () => {
      dbQuery.mockResolvedValueOnce({ rows: [] });

      await api
        .patch('/api/transactions/1')
        .send({ recipient_name: 'Missing Name' })
        .expect(400);

      expect(transactionRepository.update).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid category_name format', async () => {
      await api
        .patch('/api/transactions/1')
        .send({ category_name: 'INVALID' })
        .expect(400);

      expect(transactionRepository.update).not.toHaveBeenCalled();
    });

    it('should return 400 when category_name does not exist', async () => {
      dbQuery.mockResolvedValueOnce({ rows: [{ id: 11 }] });
      dbQuery.mockResolvedValueOnce({ rows: [] });

      await api
        .patch('/api/transactions/1')
        .send({
          recipient_name: 'Known Recipient',
          category_name: 'FOOD:UNKNOWN',
        })
        .expect(400);

      expect(transactionRepository.update).not.toHaveBeenCalled();
    });

    it('rejects a non-integer :id via validateIdParam before the rate limiter and handler', async () => {
      await api.patch('/api/transactions/abc').send({ amount: -75 }).expect(400);

      expect(transactionRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:id', () => {
    it('should delete and return 204 with no body', async () => {
      transactionRepository.hardDelete.mockResolvedValue(true);

      const res = await api.delete('/api/transactions/1').expect(204);

      expect(res.text).toBe('');
    });

    it('should return 404 for non-existent', async () => {
      transactionRepository.hardDelete.mockResolvedValue(false);

      await api.delete('/api/transactions/99999').expect(404);
    });

    it('removes attachment files from disk after the delete', async () => {
      // The DB CASCADE only removes the attachments rows — the files must be
      // removed too or receipt PII persists forever and re-enters backups.
      transactionRepository.hardDelete.mockResolvedValue(true);
      attachmentRepository.listPathsByTransactionIds.mockResolvedValue([
        'attachments/1/receipt-a.png',
        'attachments/1/receipt-b.pdf',
      ]);

      await api.delete('/api/transactions/1').expect(204);

      expect(attachmentRepository.listPathsByTransactionIds).toHaveBeenCalledWith([1]);
      expect(removeAttachmentFile).toHaveBeenCalledWith('attachments/1/receipt-a.png');
      expect(removeAttachmentFile).toHaveBeenCalledWith('attachments/1/receipt-b.pdf');
    });

    it('does not remove files when the transaction was not found', async () => {
      transactionRepository.hardDelete.mockResolvedValue(false);
      attachmentRepository.listPathsByTransactionIds.mockResolvedValue(['attachments/9/x.png']);

      await api.delete('/api/transactions/99999').expect(404);

      expect(removeAttachmentFile).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /transfers/:id', () => {
    it('clears the transfer mark and returns 204 with no body', async () => {
      const res = await api.delete('/api/transactions/transfers/10').expect(204);

      expect(unmarkTransfer).toHaveBeenCalledWith(10);
      expect(scheduleReconcile).toHaveBeenCalled();
      expect(res.text).toBe('');
    });
  });

  describe('unmatched paths', () => {
    it('falls through to the 404 error envelope', async () => {
      const res = await api.get('/api/transactions/1/nope/nope').expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
