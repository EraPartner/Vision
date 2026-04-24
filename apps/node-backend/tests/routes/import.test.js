/**
 * Import route tests.
 * Mirrors: apps/backend/tests/test_import.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...args) => { routeHandlers[`get:${path}`] = args[args.length - 1]; }),
  post: vi.fn((path, ...args) => { routeHandlers[`post:${path}`] = args[args.length - 1]; }),
  delete: vi.fn((path, ...args) => { routeHandlers[`delete:${path}`] = args[args.length - 1]; }),
  use: vi.fn((...args) => {
    routeHandlers.use = routeHandlers.use || [];
    routeHandlers.use.push(args[args.length - 1]);
  }),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('multer', () => {
  const multer = vi.fn(() => ({
    single: vi.fn(() => (req, res, next) => next()),
  }));
  multer.MulterError = class MulterError extends Error {
    constructor(code) { super(code); this.code = code; }
  };
  return { default: multer };
});

vi.mock('fs', () => {
  const unlink = vi.fn().mockResolvedValue(undefined);
  return {
    default: {
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      promises: { unlink },
    },
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
    promises: { unlink },
  };
});

vi.mock('os', () => ({
  default: { tmpdir: vi.fn(() => '/tmp') },
  tmpdir: vi.fn(() => '/tmp'),
}));

vi.mock('../../src/services/importService.js', () => ({
  importCSV: vi.fn(),
}));

vi.mock('../../src/services/rawTransactionImportService.js', () => ({
  importCSVWithRawStorage: vi.fn(),
}));

vi.mock('../../src/services/bankAdapters.js', () => ({
  getSupportedBanks: vi.fn(() => ['belfius', 'kbc', 'revolut']),
}));

vi.mock('../../src/services/streamingImportService.js', () => ({
  importCSVStreaming: vi.fn(),
}));

vi.mock('../../src/services/dataImportService.js', () => ({
  importRecipientsCSV: vi.fn(),
  importCategoriesCSV: vi.fn(),
}));

vi.mock('../../src/services/materializedViewService.js', () => ({
  scheduleRefresh: vi.fn(),
  refreshMaterializedViews: vi.fn(),
  createMaterializedViews: vi.fn(),
  ensureMaterializedViewIndexes: vi.fn(),
  default: {
    scheduleRefresh: vi.fn(),
    refreshMaterializedViews: vi.fn(),
    createMaterializedViews: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/repositories/importBatchRepository.js', () => ({
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  rollbackBatch: vi.fn(),
}));

vi.mock('../../src/services/aggregationRefresh.js', () => ({
  refreshAggregations: vi.fn().mockResolvedValue(undefined),
}));

import { importCSVWithRawStorage } from '../../src/services/rawTransactionImportService.js';
import { getSupportedBanks } from '../../src/services/bankAdapters.js';
import { importCSVStreaming } from '../../src/services/streamingImportService.js';
import { importRecipientsCSV, importCategoriesCSV } from '../../src/services/dataImportService.js';
import { listBatches, getBatch, rollbackBatch } from '../../src/repositories/importBatchRepository.js';
import multer from 'multer';
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/importRoutes.js');

describe('Import Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  // ──────────────────────────────────────────
  // POST /api/import/csv
  // ──────────────────────────────────────────
  describe('POST /csv', () => {
    it('should return 400 when no file uploaded', async () => {
      const req = { file: null, query: { bank_name: 'belfius' }, body: {} };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should return 400 when bank_name missing', async () => {
      const req = { file: { path: '/tmp/test.csv', originalname: 'test.csv' }, query: {}, body: {} };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should return 201 on successful import', async () => {
      importCSVWithRawStorage.mockResolvedValue({
        total_processed: 5, imported: 4, duplicates: 1, errors: 0, status: 'completed',
      });

      const req = {
        file: { path: '/tmp/test.csv', originalname: 'test.csv' },
        query: { bank_name: 'belfius' },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const body = res.json.mock.calls[0][0];
      expect(body.data.total_processed).toBe(5);
      expect(body.data.imported).toBe(4);
      expect(body.data.duplicates).toBe(1);
      expect(body.data.errors).toBe(0);
      expect(body.data.status).toBe('completed');
    });

    it('should return completed_with_errors status', async () => {
      importCSVWithRawStorage.mockResolvedValue({
        total_processed: 10, imported: 8, duplicates: 1, errors: 1,
      });

      const req = {
        file: { path: '/tmp/test.csv', originalname: 'test.csv' },
        query: { bank_name: 'kbc' },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const body = res.json.mock.calls[0][0];
      expect(body.data.status).toBe('completed_with_errors');
    });

    it('should return 400 for invalid bank config', async () => {
      importCSVWithRawStorage.mockRejectedValue(new Error('No configuration found for bank'));

      const req = {
        file: { path: '/tmp/test.csv', originalname: 'test.csv' },
        query: { bank_name: 'UnknownBank' },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should return 500 on general import failure', async () => {
      importCSVWithRawStorage.mockRejectedValue(new Error('Parse error'));

      const req = {
        file: { path: '/tmp/test.csv', originalname: 'test.csv' },
        query: { bank_name: 'belfius' },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv'](req, res)).rejects.toThrow('Parse error');
    });

    it('should not leak internal error details on import failure', async () => {
      importCSVWithRawStorage.mockRejectedValue(new Error('sensitive parser trace'));

      const req = {
        file: {
          path: '/tmp/test.csv',
          originalname: 'test.csv',
          mimetype: 'text/csv',
        },
        query: { bank_name: 'belfius' },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv'](req, res)).rejects.toThrow();
    });
  });

  // ──────────────────────────────────────────
  // POST /api/import/csv/custom
  // ──────────────────────────────────────────
  describe('POST /csv/custom', () => {
    it('should return 400 when no file uploaded', async () => {
      const req = { file: null, query: {}, body: {} };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv/custom'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should return 400 for missing required params', async () => {
      const req = {
        file: { path: '/tmp/custom.csv', originalname: 'custom.csv' },
        query: { bank_name: 'Custom' },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv/custom'](req, res)).rejects.toThrow('Missing required parameters');
    });

    it('should return 400 for invalid separator', async () => {
      const req = {
        file: { path: '/tmp/custom.csv', originalname: 'custom.csv' },
        query: {
          bank_name: 'Custom', date_format: '%d/%m/%Y',
          date_column: 'Date', recipient_column: 'Desc',
          amount_column: 'Amount', separator: ';;',
        },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv/custom'](req, res)).rejects.toThrow('separator');
    });

    it('should return 201 on success', async () => {
      importCSVWithRawStorage.mockResolvedValue({
        total_processed: 1, imported: 1, duplicates: 0, errors: 0, status: 'completed',
      });

      const req = {
        file: { path: '/tmp/custom.csv', originalname: 'custom.csv' },
        query: {
          bank_name: 'Custom', date_format: '%d/%m/%Y',
          date_column: 'Date', recipient_column: 'Desc', amount_column: 'Amount',
        },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv/custom'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 500 on error', async () => {
      importCSVWithRawStorage.mockRejectedValue(new Error('Import failed'));

      const req = {
        file: { path: '/tmp/custom.csv', originalname: 'custom.csv' },
        query: {
          bank_name: 'Custom', date_format: '%d/%m/%Y',
          date_column: 'Date', recipient_column: 'Desc', amount_column: 'Amount',
        },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv/custom'](req, res)).rejects.toThrow('Import failed');
    });
  });

  // ──────────────────────────────────────────
  // POST /api/import/csv/stream
  // ──────────────────────────────────────────
  describe('POST /csv/stream', () => {
    it('should stream progress and complete SSE events on success', async () => {
      importCSVStreaming.mockImplementation(async (filePath, bankName, customConfig, onProgress) => {
        onProgress({ phase: 'importing', current: 1, total: 2, imported: 1, duplicates: 0, errors: 0, percent: 50 });
        return { total_processed: 2, imported: 2, duplicates: 0, errors: 0 };
      });

      const req = {
        file: { path: '/tmp/stream.csv', originalname: 'stream.csv' },
        query: { bank_name: 'belfius' },
        body: {},
        on: vi.fn(),
      };
      const res = mockSseResponse();

      await routeHandlers['post:/csv/stream'](req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
      }));

      const writes = res.write.mock.calls.map(([payload]) => payload);
      expect(writes.some(payload => payload.includes('event: progress'))).toBe(true);
      expect(writes.some(payload => payload.includes('event: complete'))).toBe(true);
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('should throw ValidationError when bank_name missing', async () => {
      const req = {
        file: { path: '/tmp/stream.csv', originalname: 'stream.csv' },
        query: {},
        body: {},
        on: vi.fn(),
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv/stream'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should emit SSE error event and end response on failure', async () => {
      importCSVStreaming.mockRejectedValue(new Error('adapter failed'));

      const req = {
        file: { path: '/tmp/stream.csv', originalname: 'stream.csv' },
        query: { bank_name: 'belfius' },
        body: {},
        on: vi.fn(),
      };
      const res = mockSseResponse();

      await routeHandlers['post:/csv/stream'](req, res);

      const writes = res.write.mock.calls.map(([payload]) => payload);
      expect(writes.some(payload => payload.includes('event: error'))).toBe(true);
      expect(writes.some(payload => payload.includes('Import failed'))).toBe(true);
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('should not emit complete or error event after client abort', async () => {
      let closeHandler;
      importCSVStreaming.mockImplementation(async (filePath, bankName, customConfig, onProgress) => {
        onProgress({ phase: 'importing', current: 1, total: 2, imported: 1, duplicates: 0, errors: 0, percent: 50 });
        closeHandler();
        return { total_processed: 2, imported: 2, duplicates: 0, errors: 0 };
      });

      const req = {
        file: { path: '/tmp/stream.csv', originalname: 'stream.csv' },
        query: { bank_name: 'belfius' },
        body: {},
        on: vi.fn((event, cb) => {
          if (event === 'close') closeHandler = cb;
        }),
      };
      const res = mockSseResponse();

      await routeHandlers['post:/csv/stream'](req, res);

      const writes = res.write.mock.calls.map(([payload]) => payload);
      expect(writes.some(payload => payload.includes('event: complete'))).toBe(false);
      expect(writes.some(payload => payload.includes('event: error'))).toBe(false);
      expect(res.end).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────
  // POST /api/import/recipients
  // ──────────────────────────────────────────
  describe('POST /recipients', () => {
    it('should return 201 with completed status on successful import', async () => {
      importRecipientsCSV.mockResolvedValue({ total_processed: 2, imported: 2, skipped: 0, errors: 0 });

      const req = {
        file: { path: '/tmp/recipients.csv', originalname: 'recipients.csv' },
        query: {},
        body: {},
      };
      const res = mockResponse();

      await routeHandlers['post:/recipients'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ status: 'completed' }),
      }));
    });

    it('should return 201 with completed_with_errors status when errors > 0', async () => {
      importRecipientsCSV.mockResolvedValue({ total_processed: 2, imported: 1, skipped: 0, errors: 1 });

      const req = {
        file: { path: '/tmp/recipients.csv', originalname: 'recipients.csv' },
        query: {},
        body: {},
      };
      const res = mockResponse();

      await routeHandlers['post:/recipients'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ status: 'completed_with_errors' }),
      }));
    });

    it('should throw ValidationError for invalid separator', async () => {
      const req = {
        file: { path: '/tmp/recipients.csv', originalname: 'recipients.csv' },
        query: { separator: ';;' },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/recipients'](req, res)).rejects.toThrow('separator must be a single character');
    });

    it('should propagate service error', async () => {
      importRecipientsCSV.mockRejectedValue(new Error('boom'));

      const req = {
        file: { path: '/tmp/recipients.csv', originalname: 'recipients.csv' },
        query: {},
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/recipients'](req, res)).rejects.toThrow('boom');
    });
  });

  // ──────────────────────────────────────────
  // POST /api/import/categories
  // ──────────────────────────────────────────
  describe('POST /categories', () => {
    it('should return 201 with completed status on successful import', async () => {
      importCategoriesCSV.mockResolvedValue({ total_processed: 2, imported: 2, skipped: 0, errors: 0 });

      const req = {
        file: { path: '/tmp/categories.csv', originalname: 'categories.csv' },
        query: {},
        body: {},
      };
      const res = mockResponse();

      await routeHandlers['post:/categories'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ status: 'completed' }),
      }));
    });

    it('should return 201 with completed_with_errors status when errors > 0', async () => {
      importCategoriesCSV.mockResolvedValue({ total_processed: 2, imported: 1, skipped: 0, errors: 1 });

      const req = {
        file: { path: '/tmp/categories.csv', originalname: 'categories.csv' },
        query: {},
        body: {},
      };
      const res = mockResponse();

      await routeHandlers['post:/categories'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ status: 'completed_with_errors' }),
      }));
    });

    it('should throw ValidationError for invalid separator', async () => {
      const req = {
        file: { path: '/tmp/categories.csv', originalname: 'categories.csv' },
        query: { separator: ';;' },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/categories'](req, res)).rejects.toThrow('separator must be a single character');
    });

    it('should propagate service error', async () => {
      importCategoriesCSV.mockRejectedValue(new Error('boom'));

      const req = {
        file: { path: '/tmp/categories.csv', originalname: 'categories.csv' },
        query: {},
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/categories'](req, res)).rejects.toThrow('boom');
    });
  });

  // ──────────────────────────────────────────
  // GET /api/import/batches
  // ──────────────────────────────────────────
  describe('GET /batches', () => {
    it('returns paginated batch list with defaults', async () => {
      listBatches.mockResolvedValue({
        batches: [{ id: 1, adapter_name: 'belfius', status: 'complete', rows_imported: 10 }],
        total: 1,
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/batches'](req, res);

      expect(listBatches).toHaveBeenCalledWith({ limit: 50, offset: 0 });
      const body = res.json.mock.calls[0][0];
      expect(body.ok).toBe(true);
      expect(body.data.batches).toHaveLength(1);
      expect(body.data.total).toBe(1);
      expect(body.data.limit).toBe(50);
      expect(body.data.offset).toBe(0);
    });

    it('clamps limit to 200', async () => {
      listBatches.mockResolvedValue({ batches: [], total: 0 });

      const req = { query: { limit: '999', offset: '0' } };
      const res = mockResponse();
      await routeHandlers['get:/batches'](req, res);

      expect(listBatches).toHaveBeenCalledWith({ limit: 200, offset: 0 });
    });

    it('passes custom limit and offset', async () => {
      listBatches.mockResolvedValue({ batches: [], total: 5 });

      const req = { query: { limit: '10', offset: '20' } };
      const res = mockResponse();
      await routeHandlers['get:/batches'](req, res);

      expect(listBatches).toHaveBeenCalledWith({ limit: 10, offset: 20 });
    });
  });

  // ──────────────────────────────────────────
  // GET /api/import/batches/:id
  // ──────────────────────────────────────────
  describe('GET /batches/:id', () => {
    it('returns batch for valid id', async () => {
      getBatch.mockResolvedValue({
        id: 7, adapter_name: 'kbc', status: 'complete', rows_imported: 20, transactions_remaining: 20,
      });

      const req = { params: { id: '7' } };
      const res = mockResponse();
      await routeHandlers['get:/batches/:id'](req, res);

      expect(getBatch).toHaveBeenCalledWith(7);
      const body = res.json.mock.calls[0][0];
      expect(body.ok).toBe(true);
      expect(body.data.id).toBe(7);
    });

    it('throws ValidationError for non-numeric id', async () => {
      const req = { params: { id: 'abc' } };
      const res = mockResponse();

      await expect(routeHandlers['get:/batches/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
      expect(getBatch).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when batch does not exist', async () => {
      getBatch.mockResolvedValue(null);

      const req = { params: { id: '999' } };
      const res = mockResponse();

      await expect(routeHandlers['get:/batches/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ──────────────────────────────────────────
  // DELETE /api/import/batches/:id (rollback)
  // ──────────────────────────────────────────
  describe('DELETE /batches/:id', () => {
    it('rolls back complete batch and returns deleted count', async () => {
      getBatch.mockResolvedValue({ id: 3, status: 'complete' });
      rollbackBatch.mockResolvedValue({ deleted: 15 });

      const req = { params: { id: '3' } };
      const res = mockResponse();
      await routeHandlers['delete:/batches/:id'](req, res);

      expect(rollbackBatch).toHaveBeenCalledWith(3);
      const body = res.json.mock.calls[0][0];
      expect(body.ok).toBe(true);
      expect(body.data.deleted).toBe(15);
    });

    it('throws ValidationError for non-numeric id', async () => {
      const req = { params: { id: 'nope' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/batches/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
      expect(getBatch).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when batch does not exist', async () => {
      getBatch.mockResolvedValue(null);

      const req = { params: { id: '42' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/batches/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
      expect(rollbackBatch).not.toHaveBeenCalled();
    });

    it('throws ValidationError when batch already aborted', async () => {
      getBatch.mockResolvedValue({ id: 5, status: 'aborted' });

      const req = { params: { id: '5' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/batches/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
      expect(rollbackBatch).not.toHaveBeenCalled();
    });

    it.each(['staging', 'validating', 'matching', 'committing'])(
      'throws ValidationError when batch is in-progress (%s)',
      async (status) => {
        getBatch.mockResolvedValue({ id: 6, status });

        const req = { params: { id: '6' } };
        const res = mockResponse();

        await expect(routeHandlers['delete:/batches/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
        expect(rollbackBatch).not.toHaveBeenCalled();
      }
    );

    it('returns deleted:0 when no transactions linked to batch', async () => {
      getBatch.mockResolvedValue({ id: 8, status: 'complete' });
      rollbackBatch.mockResolvedValue({ deleted: 0 });

      const req = { params: { id: '8' } };
      const res = mockResponse();
      await routeHandlers['delete:/batches/:id'](req, res);

      const body = res.json.mock.calls[0][0];
      expect(body.data.deleted).toBe(0);
    });
  });

  describe('multer error middleware', () => {
    it('should forward LIMIT_FILE_SIZE as ValidationError', () => {
      const errorHandler = routeHandlers.use.at(-1);
      const err = new multer.MulterError('LIMIT_FILE_SIZE');
      const req = {};
      const res = mockResponse();
      const next = vi.fn();

      errorHandler(err, req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should forward generic multer errors as ValidationError', () => {
      const errorHandler = routeHandlers.use.at(-1);
      const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE');
      err.message = 'unexpected file';
      const req = {};
      const res = mockResponse();
      const next = vi.fn();

      errorHandler(err, req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should forward non-csv file errors as ValidationError', () => {
      const errorHandler = routeHandlers.use.at(-1);
      const err = new Error('File must be a CSV');
      const req = {};
      const res = mockResponse();
      const next = vi.fn();

      errorHandler(err, req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should pass unknown errors to next middleware', () => {
      const errorHandler = routeHandlers.use.at(-1);
      const err = new Error('unknown');
      const req = {};
      const res = mockResponse();
      const next = vi.fn();

      errorHandler(err, req, res, next);

      expect(next).toHaveBeenCalledWith(err);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────
  // GET /api/import/supported-banks
  // ──────────────────────────────────────────
  describe('GET /supported-banks', () => {
    it('should return supported banks', async () => {
      const req = {};
      const res = mockResponse();
      await routeHandlers['get:/supported-banks'](req, res);

      const body = res.json.mock.calls[0][0];
      expect(body.data.banks).toBeDefined();
      expect(body.data.total).toBe(3);
      expect(body.data.banks).toContain('Belfius');
      expect(body.data.banks).toContain('Kbc');
      expect(body.data.banks).toContain('Revolut');
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  res.ok = (data, meta) => {
    const body = { ok: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };
  return res;
}

function mockSseResponse() {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  };
}
