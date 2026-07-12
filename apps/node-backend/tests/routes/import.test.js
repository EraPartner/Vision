/**
 * Import route tests.
 * Mirrors: apps/backend/tests/test_import.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...args) => { routeHandlers[`get:${path}`] = args[args.length - 1]; }),
  post: vi.fn((path, ...args) => { routeHandlers[`post:${path}`] = args[args.length - 1]; }),
  patch: vi.fn((path, ...args) => { routeHandlers[`patch:${path}`] = args[args.length - 1]; }),
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

vi.mock('../../src/services/importPipeline/index.js', () => ({
  runImportPipeline: vi.fn(),
}));

vi.mock('../../src/services/bankAdapters.js', () => ({
  getSupportedBanks: vi.fn(() => ['belfius', 'kbc', 'revolut']),
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
  getPreviewRows: vi.fn(),
  overrideRecipient: vi.fn(),
  overrideCategory: vi.fn(),
  categoryExists: vi.fn(),
}));

vi.mock('../../src/services/aggregationRefresh.js', () => ({
  refreshAggregations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/repositories/customParserConfigRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getById: vi.fn(),
    getByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { runImportPipeline } from '../../src/services/importPipeline/index.js';
import { getSupportedBanks } from '../../src/services/bankAdapters.js';
import { importRecipientsCSV, importCategoriesCSV } from '../../src/services/dataImportService.js';
import {
  listBatches,
  getBatch,
  rollbackBatch,
  getPreviewRows,
  overrideRecipient,
  overrideCategory,
  categoryExists,
} from '../../src/repositories/importBatchRepository.js';
import { query } from '../../src/database/connection.js';
import multer from 'multer';
import { ValidationError, NotFoundError, ConflictError } from '../../src/middleware/errorHandler.js';
import customParserConfigRepository from '../../src/repositories/customParserConfigRepository.js';
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
      runImportPipeline.mockResolvedValue({
        total: 5, imported: 4, duplicates: 1, errors: 0,
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
      expect(body.data.total).toBe(5);
      expect(body.data.imported).toBe(4);
      expect(body.data.duplicates).toBe(1);
      expect(body.data.errors).toBe(0);
      expect(body.data.status).toBe('completed');
    });

    it('should return completed_with_errors status', async () => {
      runImportPipeline.mockResolvedValue({
        total: 10, imported: 8, duplicates: 1, errors: 1,
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
      runImportPipeline.mockRejectedValue(new Error('No configuration found for bank'));

      const req = {
        file: { path: '/tmp/test.csv', originalname: 'test.csv' },
        query: { bank_name: 'UnknownBank' },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should return 500 on general import failure', async () => {
      runImportPipeline.mockRejectedValue(new Error('Parse error'));

      const req = {
        file: { path: '/tmp/test.csv', originalname: 'test.csv' },
        query: { bank_name: 'belfius' },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv'](req, res)).rejects.toThrow('Parse error');
    });

    it('should not leak internal error details on import failure', async () => {
      runImportPipeline.mockRejectedValue(new Error('sensitive parser trace'));

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

    it('should return 400 for negative skip_rows', async () => {
      // csv-parse throws a raw error on a negative `from` — must 400 up front.
      const req = {
        file: { path: '/tmp/custom.csv', originalname: 'custom.csv' },
        query: {
          bank_name: 'Custom', date_format: '%d/%m/%Y',
          date_column: 'Date', recipient_column: 'Desc',
          amount_column: 'Amount', skip_rows: '-3',
        },
        body: {},
      };
      const res = mockResponse();

      await expect(routeHandlers['post:/csv/custom'](req, res)).rejects.toThrow('skip_rows');
      expect(runImportPipeline).not.toHaveBeenCalled();
    });

    it('should return 201 on success', async () => {
      runImportPipeline.mockResolvedValue({
        total: 1, imported: 1, duplicates: 0, errors: 0,
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
      runImportPipeline.mockRejectedValue(new Error('Import failed'));

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
      runImportPipeline.mockImplementation(async ({ onProgress }) => {
        await onProgress({ phase: 'importing', current: 1, total: 2, imported: 1, duplicates: 0, errors: 0, percent: 50 });
        return { total: 2, imported: 2, duplicates: 0, errors: 0 };
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
      runImportPipeline.mockRejectedValue(new Error('adapter failed'));

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
      runImportPipeline.mockImplementation(async ({ onProgress }) => {
        await onProgress({ phase: 'importing', current: 1, total: 2, imported: 1, duplicates: 0, errors: 0, percent: 50 });
        closeHandler();
        return { total: 2, imported: 2, duplicates: 0, errors: 0 };
      });

      const req = {
        file: { path: '/tmp/stream.csv', originalname: 'stream.csv' },
        query: { bank_name: 'belfius' },
        body: {},
        on: vi.fn(),
      };
      const res = mockSseResponse();
      res.on = vi.fn((event, cb) => {
        if (event === 'close') closeHandler = cb;
      });

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
  // POST /api/import/batches/:id/rows/:rowId/category-override
  // ──────────────────────────────────────────
  describe('POST /batches/:id/rows/:rowId/category-override', () => {
    const route = 'post:/batches/:id/rows/:rowId/category-override';

    it('rejects non-numeric ids', async () => {
      const req = { params: { id: 'abc', rowId: '5' }, body: { category_id: 1 } };
      const res = mockResponse();
      await expect(routeHandlers[route](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects non-integer category_id', async () => {
      const req = { params: { id: '1', rowId: '5' }, body: { category_id: 'foo' } };
      const res = mockResponse();
      await expect(routeHandlers[route](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('clears the override when category_id is null', async () => {
      overrideCategory.mockResolvedValueOnce(1);

      const req = { params: { id: '1', rowId: '5' }, body: { category_id: null } };
      const res = mockResponse();
      await routeHandlers[route](req, res);

      expect(categoryExists).not.toHaveBeenCalled();
      expect(overrideCategory).toHaveBeenCalledTimes(1);
      expect(overrideCategory).toHaveBeenCalledWith({ batchId: 1, rowId: 5, categoryId: null });

      const body = res.json.mock.calls[0][0];
      expect(body.data).toEqual({ row_id: 5, override_category_id: null });
    });

    it('sets the override after verifying category exists', async () => {
      categoryExists.mockResolvedValueOnce(true);
      overrideCategory.mockResolvedValueOnce(1);

      const req = { params: { id: '7', rowId: '42' }, body: { category_id: 12 } };
      const res = mockResponse();
      await routeHandlers[route](req, res);

      expect(categoryExists).toHaveBeenCalledWith(12);
      expect(overrideCategory).toHaveBeenCalledWith({ batchId: 7, rowId: 42, categoryId: 12 });

      const body = res.json.mock.calls[0][0];
      expect(body.data).toEqual({ row_id: 42, override_category_id: 12 });
    });

    it('rejects unknown category_id with ValidationError', async () => {
      categoryExists.mockResolvedValueOnce(false);

      const req = { params: { id: '1', rowId: '5' }, body: { category_id: 9999 } };
      const res = mockResponse();
      await expect(routeHandlers[route](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws NotFoundError when staging row not found or wrong status', async () => {
      categoryExists.mockResolvedValueOnce(true);
      overrideCategory.mockResolvedValueOnce(0);

      const req = { params: { id: '1', rowId: '5' }, body: { category_id: 1 } };
      const res = mockResponse();
      await expect(routeHandlers[route](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ──────────────────────────────────────────
  // GET /api/import/batches/:id/preview — category fields
  // ──────────────────────────────────────────
  describe('GET /batches/:id/preview category fields', () => {
    const route = 'get:/batches/:id/preview';

    it('exposes recipient_default_category_id and current_category_label per group', async () => {
      getBatch.mockResolvedValue({ id: 1, status: 'awaiting_review' });
      getPreviewRows.mockResolvedValueOnce([
        {
          id: 100,
          row_index: 0,
          recipient_raw: 'SUPERMARKET',
          amount: '-12.50',
          currency: 'EUR',
          tx_date: '2026-04-01',
          memo: '',
          match_source: 'exact',
          match_similarity: null,
          matched_pattern_id: null,
          resolved_recipient_id: 7,
          user_override_recipient_id: null,
          override_category_id: null,
          effective_recipient_id: 7,
          recipient_name: 'SUPERMARKET ABC',
          recipient_default_category_id: 12,
          recipient_default_category_general: 'Groceries',
          recipient_default_category_detail: 'Food',
          override_category_general: null,
          override_category_detail: null,
          matched_pattern_text: null,
          matched_pattern_kind: null,
        },
      ]);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers[route](req, res);

      const body = res.json.mock.calls[0][0];
      expect(body.data.groups).toHaveLength(1);
      const g = body.data.groups[0];
      expect(g.recipient_default_category_id).toBe(12);
      expect(g.recipient_default_category_label).toBe('Groceries: Food');
      expect(g.current_category_id).toBe(12);
      expect(g.current_category_label).toBe('Groceries: Food');
      expect(g.override_category_id).toBeNull();
    });

    it('per-row override beats recipient default in current_category fields', async () => {
      getBatch.mockResolvedValue({ id: 1, status: 'awaiting_review' });
      getPreviewRows.mockResolvedValueOnce([
        {
          id: 101,
          row_index: 0,
          recipient_raw: 'SUPERMARKET',
          amount: '-99.99',
          currency: 'EUR',
          tx_date: '2026-04-01',
          memo: '',
          match_source: 'exact',
          match_similarity: null,
          matched_pattern_id: null,
          resolved_recipient_id: 7,
          user_override_recipient_id: null,
          override_category_id: 22,
          effective_recipient_id: 7,
          recipient_name: 'SUPERMARKET ABC',
          recipient_default_category_id: 12,
          recipient_default_category_general: 'Groceries',
          recipient_default_category_detail: 'Food',
          override_category_general: 'Hardware',
          override_category_detail: 'Tools',
          matched_pattern_text: null,
          matched_pattern_kind: null,
        },
      ]);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers[route](req, res);

      const g = res.json.mock.calls[0][0].data.groups[0];
      expect(g.override_category_id).toBe(22);
      expect(g.current_category_id).toBe(22);
      expect(g.current_category_label).toBe('Hardware: Tools');
      expect(g.recipient_default_category_id).toBe(12);
    });
  });

  // ──────────────────────────────────────────
  // GET /api/import/supported-banks was removed (dead route; adapter catalog is
  // served from /api/info/supported-adapters, registry-derived — see info.test.js).
});

describe('Saved custom parser routes', () => {
  beforeEach(() => vi.clearAllMocks());

  const validConfig = { dateColumn: 'Date', recipientColumn: 'Name', amountColumn: 'Amount' };

  describe('GET /parsers', () => {
    it('returns the list of saved parsers', async () => {
      const items = [{ id: 1, name: 'My Bank', config: validConfig }];
      customParserConfigRepository.getAll.mockResolvedValue(items);
      const res = mockResponse();
      await routeHandlers['get:/parsers']({ query: {} }, res);
      expect(res.json.mock.calls[0][0].data).toEqual(items);
    });
  });

  describe('POST /parsers', () => {
    it('creates a parser and returns 201', async () => {
      customParserConfigRepository.create.mockResolvedValue({ id: 7, name: 'My Bank', config: validConfig });
      const res = mockResponse();
      await routeHandlers['post:/parsers']({ body: { name: 'My Bank', config: validConfig } }, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json.mock.calls[0][0].data.id).toBe(7);
      expect(customParserConfigRepository.create).toHaveBeenCalledWith({
        name: 'My Bank',
        config: expect.objectContaining({ dateColumn: 'Date', dateFormat: '%Y-%m-%d', separator: ',', encoding: 'utf-8', skipRows: 0 }),
        kind: 'transaction',
      });
    });

    it('rejects a missing name', async () => {
      const res = mockResponse();
      await expect(
        routeHandlers['post:/parsers']({ body: { config: validConfig } }, res),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a config missing required columns', async () => {
      const res = mockResponse();
      await expect(
        routeHandlers['post:/parsers']({ body: { name: 'X', config: { dateColumn: 'Date' } } }, res),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('maps a unique-violation to ConflictError', async () => {
      const err = Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_custom_parser_configs_name_kind' });
      customParserConfigRepository.create.mockRejectedValue(err);
      const res = mockResponse();
      await expect(
        routeHandlers['post:/parsers']({ body: { name: 'My Bank', config: validConfig } }, res),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('PATCH /parsers/:id', () => {
    it('returns 404 when the parser does not exist', async () => {
      customParserConfigRepository.update.mockResolvedValue(undefined);
      const res = mockResponse();
      await expect(
        routeHandlers['patch:/parsers/:id']({ params: { id: '5' }, body: { name: 'New' } }, res),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('maps a unique-violation to ConflictError', async () => {
      const err = Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_custom_parser_configs_name_kind' });
      customParserConfigRepository.update.mockRejectedValue(err);
      const res = mockResponse();
      await expect(
        routeHandlers['patch:/parsers/:id']({ params: { id: '5' }, body: { name: 'Taken' } }, res),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects an invalid id', async () => {
      const res = mockResponse();
      await expect(
        routeHandlers['patch:/parsers/:id']({ params: { id: 'abc' }, body: { name: 'X' } }, res),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('DELETE /parsers/:id', () => {
    it('returns 204 when deleted', async () => {
      customParserConfigRepository.delete.mockResolvedValue(true);
      const res = mockResponse();
      await routeHandlers['delete:/parsers/:id']({ params: { id: '3' } }, res);
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('returns 404 when nothing was deleted', async () => {
      customParserConfigRepository.delete.mockResolvedValue(false);
      const res = mockResponse();
      await expect(
        routeHandlers['delete:/parsers/:id']({ params: { id: '3' } }, res),
      ).rejects.toBeInstanceOf(NotFoundError);
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
