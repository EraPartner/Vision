/**
 * Import route tests.
 * Mirrors: apps/backend/tests/test_import.py
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js), which also puts the router's own trailing
 * error middleware (`router.use(csvUploadErrorTranslator)`,
 * routes/importRoutes.js:580) on the tested path, and the zod-validated
 * batch/row id parsing (parseBatchIdParam / parseBatchRowIdParams) — both
 * silently dropped/bypassed by the old mock-router harness.
 *
 * Mount path is /api/import, behind importRateLimiter at the app level
 * (main.js:325) — a module-scoped per-IP counter deliberately NOT reproduced
 * here per the routeApp.js fidelity map (it would 429 this suite's own many
 * requests).
 *
 * multer is stubbed to a pass-through; requests that need `req.file` set it
 * via a shared `uploadState` (vi.hoisted), the same pattern as
 * attachments.test.js. This lets one suite cover both "no file uploaded"
 * guards AND the csvUploadErrorTranslator's multer-error mapping (a fixed
 * `before`-middleware injection, as importValidationPins.test.js uses, can
 * only ever inject a successful upload).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockConnection } from '../helpers/repoMocks.js';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, okEnvelope, errEnvelope } from '../helpers/routeApp.js';

const uploadState = vi.hoisted(() => ({ file: null, error: null }));

vi.mock('multer', () => {
  const multer = vi.fn(() => ({
    single: () => (req, _res, next) => {
      if (uploadState.error) return next(uploadState.error);
      req.file = uploadState.file ?? undefined;
      next();
    },
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
  commitImport: vi.fn(),
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
  logger: mockLogger(),
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

vi.mock('../../src/database/connection.js', () => mockConnection());

import { runImportPipeline } from '../../src/services/importPipeline/index.js';
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
import multer from 'multer';
import customParserConfigRepository from '../../src/repositories/customParserConfigRepository.js';

const { default: importRouter } = await import('../../src/routes/importRoutes.js');

const BASE = '/api/import';
const api = routeAgent(importRouter, { mountPath: BASE });
// Same router behind an error handler in production mode (main.js:401 passes
// `settings.isProduction`) — used only for the one test below that pins the
// message-sanitization branch (errorHandler.js:234-235); the harness defaults
// isProduction to false so unsanitized 5xx messages stay visible elsewhere,
// matching a dev/test run.
const apiProd = routeAgent(importRouter, { mountPath: BASE, isProduction: () => true });

const FILE = { path: '/tmp/test.csv', originalname: 'test.csv', size: 100 };

/** Split a buffered `text/event-stream` body into `{ name, data }` frames. */
function parseSseFrames(rawText) {
  return rawText
    .split('\n\n')
    .filter((frame) => frame.startsWith('event:'))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split('\n');
      return {
        name: eventLine.replace(/^event: /, ''),
        data: JSON.parse(dataLine.replace(/^data: /, '')),
      };
    });
}

describe('Import Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadState.file = { ...FILE };
    uploadState.error = null;
  });

  // ──────────────────────────────────────────
  // POST /api/import/csv
  // ──────────────────────────────────────────
  describe('POST /csv', () => {
    it('should return 400 when no file uploaded', async () => {
      uploadState.file = null;

      const res = await api.post(`${BASE}/csv`).query({ bank_name: 'belfius' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should return 400 when bank_name missing', async () => {
      const res = await api.post(`${BASE}/csv`).send({}).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should return 201 on successful import', async () => {
      runImportPipeline.mockResolvedValue({ total: 5, imported: 4, duplicates: 1, errors: 0 });

      const res = await api.post(`${BASE}/csv`).query({ bank_name: 'belfius' }).expect(201);

      expect(res.body.data.total).toBe(5);
      expect(res.body.data.imported).toBe(4);
      expect(res.body.data.duplicates).toBe(1);
      expect(res.body.data.errors).toBe(0);
      expect(res.body.data.status).toBe('completed');
    });

    it('should return completed_with_errors status', async () => {
      runImportPipeline.mockResolvedValue({ total: 10, imported: 8, duplicates: 1, errors: 1 });

      const res = await api.post(`${BASE}/csv`).query({ bank_name: 'kbc' }).expect(201);

      expect(res.body.data.status).toBe('completed_with_errors');
    });

    // The 202 arm — `respondReviewRequired` (importRoutes.js:74-84). Nothing is
    // committed on this branch, so the body deliberately carries no counts; the
    // client narrows on `requires_review`. Pinned so the shape cannot drift
    // again without a test noticing.
    it('should return 202 with the review-required shape when rows need review', async () => {
      runImportPipeline.mockResolvedValue({
        batchId: 42,
        total: 5,
        requiresReview: true,
        matchSourceCounts: { exact: 1, fuzzy: 2, pattern: 0, new: 2 },
      });

      const res = await api.post(`${BASE}/csv`).query({ bank_name: 'belfius' }).expect(202);

      expect(res.body).toEqual(okEnvelope({
        batch_id: 42,
        requires_review: true,
        match_source_counts: { exact: 1, fuzzy: 2, pattern: 0, new: 2 },
      }));
      // No counts on this branch — the review page is the outcome, not a commit.
      expect(res.body.data).not.toHaveProperty('total');
      expect(res.body.data).not.toHaveProperty('imported');
      expect(res.body.data).not.toHaveProperty('status');
    });

    it('should return 400 for invalid bank config', async () => {
      runImportPipeline.mockRejectedValue(new Error('No configuration found for bank'));

      const res = await api.post(`${BASE}/csv`).query({ bank_name: 'UnknownBank' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should return 500 on general import failure', async () => {
      runImportPipeline.mockRejectedValue(new Error('Parse error'));

      const res = await api.post(`${BASE}/csv`).query({ bank_name: 'belfius' }).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'Parse error' }));
    });

    // Was `.rejects.toThrow()` against the directly-invoked handler — that only
    // proved SOMETHING threw, not that the response the client actually
    // receives is sanitized. Pinned for real here: dev/test mode still echoes
    // the raw message (existing behavior — see the `apiProd` assertion below
    // for the production branch this test's title actually describes).
    it('should not leak internal error details on import failure (production mode)', async () => {
      runImportPipeline.mockRejectedValue(new Error('sensitive parser trace'));

      const res = await apiProd.post(`${BASE}/csv`).query({ bank_name: 'belfius' }).expect(500);

      expect(res.body).toEqual(errEnvelope({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An internal server error occurred. Please try again later.',
      }));
      expect(JSON.stringify(res.body)).not.toContain('sensitive parser trace');
    });
  });

  // ──────────────────────────────────────────
  // POST /api/import/csv/custom
  // ──────────────────────────────────────────
  describe('POST /csv/custom', () => {
    it('should return 400 when no file uploaded', async () => {
      uploadState.file = null;

      const res = await api.post(`${BASE}/csv/custom`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should return 400 for missing required params', async () => {
      const res = await api.post(`${BASE}/csv/custom`).query({ bank_name: 'Custom' }).expect(400);
      expect(res.body.error.message).toContain('Missing required parameters');
    });

    it('should return 400 for invalid separator', async () => {
      const res = await api.post(`${BASE}/csv/custom`).query({
        bank_name: 'Custom', date_format: '%d/%m/%Y',
        date_column: 'Date', recipient_column: 'Desc',
        amount_column: 'Amount', separator: ';;',
      }).expect(400);
      expect(res.body.error.message).toMatch(/separator/);
    });

    it('should return 400 for negative skip_rows', async () => {
      // csv-parse throws a raw error on a negative `from` — must 400 up front.
      const res = await api.post(`${BASE}/csv/custom`).query({
        bank_name: 'Custom', date_format: '%d/%m/%Y',
        date_column: 'Date', recipient_column: 'Desc',
        amount_column: 'Amount', skip_rows: '-3',
      }).expect(400);

      expect(res.body.error.message).toMatch(/skip_rows/);
      expect(runImportPipeline).not.toHaveBeenCalled();
    });

    it('should return 201 on success', async () => {
      runImportPipeline.mockResolvedValue({ total: 1, imported: 1, duplicates: 0, errors: 0 });

      await api.post(`${BASE}/csv/custom`).query({
        bank_name: 'Custom', date_format: '%d/%m/%Y',
        date_column: 'Date', recipient_column: 'Desc', amount_column: 'Amount',
      }).expect(201);
    });

    // Same 202 arm as /csv — the custom-mapping route shares
    // `respondReviewRequired`, and its frontend caller (TransactionImportCard)
    // routes to the review page off exactly these fields.
    it('should return 202 with the review-required shape when rows need review', async () => {
      runImportPipeline.mockResolvedValue({
        batchId: 43,
        total: 2,
        requiresReview: true,
        matchSourceCounts: { exact: 0, fuzzy: 0, pattern: 0, new: 2 },
      });

      const res = await api.post(`${BASE}/csv/custom`).query({
        bank_name: 'Custom', date_format: '%d/%m/%Y',
        date_column: 'Date', recipient_column: 'Desc', amount_column: 'Amount',
      }).expect(202);

      expect(res.body).toEqual(okEnvelope({
        batch_id: 43,
        requires_review: true,
        match_source_counts: { exact: 0, fuzzy: 0, pattern: 0, new: 2 },
      }));
      expect(res.body.data).not.toHaveProperty('total');
      expect(res.body.data).not.toHaveProperty('imported');
    });

    it('should return 500 on error', async () => {
      runImportPipeline.mockRejectedValue(new Error('Import failed'));

      const res = await api.post(`${BASE}/csv/custom`).query({
        bank_name: 'Custom', date_format: '%d/%m/%Y',
        date_column: 'Date', recipient_column: 'Desc', amount_column: 'Amount',
      }).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'Import failed' }));
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

      const res = await api.post(`${BASE}/csv/stream`).query({ bank_name: 'belfius' }).expect(200);

      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      const frames = parseSseFrames(res.text);
      const names = frames.map((f) => f.name);
      expect(names).toContain('progress');
      expect(names).toContain('complete');

      const complete = frames.find((f) => f.name === 'complete');
      expect(complete.data).toEqual(expect.objectContaining({
        total_processed: 2, imported: 2, duplicates: 0, errors: 0, status: 'completed', percent: 100,
      }));
    });

    it('should return a 400 VALIDATION_ERROR envelope (no SSE) when bank_name missing', async () => {
      const res = await api.post(`${BASE}/csv/stream`).send({}).expect(400);

      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(res.headers['content-type']).toMatch(/json/);
    });

    it('should emit an SSE error event on pipeline failure', async () => {
      runImportPipeline.mockRejectedValue(new Error('adapter failed'));

      const res = await api.post(`${BASE}/csv/stream`).query({ bank_name: 'belfius' }).expect(200);

      const frames = parseSseFrames(res.text);
      const errFrame = frames.find((f) => f.name === 'error');
      // A plain Error (not a ValidationError) maps to the generic detail —
      // the raw 'adapter failed' message is deliberately not echoed to the
      // client (importProgress.js's streamImport).
      expect(errFrame.data).toEqual({ detail: 'Import failed' });
      expect(frames.some((f) => f.name === 'complete')).toBe(false);
    });

    // The underlying "write()/end() are no-ops once the client has
    // disconnected" invariant is unit-pinned in tests/sseWriter.test.js
    // ("no-ops write() after client disconnect"); this is the integration-level
    // regression check that a mid-stream client abort doesn't hang the
    // in-flight pipeline or throw an unhandled rejection.
    it('does not hang or throw when the client disconnects mid-stream', async () => {
      let pipelineSettled = false;
      runImportPipeline.mockImplementation(async ({ onProgress }) => {
        await onProgress({ phase: 'importing', current: 1, total: 2, imported: 1, duplicates: 0, errors: 0, percent: 50 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        pipelineSettled = true;
        return { total: 2, imported: 2, duplicates: 0, errors: 0 };
      });

      const test = api.post(`${BASE}/csv/stream`).query({ bank_name: 'belfius' });
      test.end(() => {}); // fire-and-forget: an aborted request rejects the client promise
      await new Promise((resolve) => setTimeout(resolve, 15));
      test.abort();

      await new Promise((resolve) => setTimeout(resolve, 45));
      expect(pipelineSettled).toBe(true);
    });
  });

  // ──────────────────────────────────────────
  // POST /api/import/recipients
  // ──────────────────────────────────────────
  describe('POST /recipients', () => {
    it('should return 201 with completed status on successful import', async () => {
      importRecipientsCSV.mockResolvedValue({ total_processed: 2, imported: 2, skipped: 0, errors: 0 });

      const res = await api.post(`${BASE}/recipients`).send({}).expect(201);

      expect(res.body).toEqual(okEnvelope(expect.objectContaining({ status: 'completed' })));
    });

    it('should return 201 with completed_with_errors status when errors > 0', async () => {
      importRecipientsCSV.mockResolvedValue({ total_processed: 2, imported: 1, skipped: 0, errors: 1 });

      const res = await api.post(`${BASE}/recipients`).send({}).expect(201);

      expect(res.body).toEqual(okEnvelope(expect.objectContaining({ status: 'completed_with_errors' })));
    });

    it('should throw ValidationError for invalid separator', async () => {
      const res = await api.post(`${BASE}/recipients`).query({ separator: ';;' }).send({}).expect(400);
      expect(res.body.error.message).toMatch(/separator must be a single character/);
    });

    it('should propagate service error', async () => {
      importRecipientsCSV.mockRejectedValue(new Error('boom'));

      const res = await api.post(`${BASE}/recipients`).send({}).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' }));
    });
  });

  // ──────────────────────────────────────────
  // POST /api/import/categories
  // ──────────────────────────────────────────
  describe('POST /categories', () => {
    it('should return 201 with completed status on successful import', async () => {
      importCategoriesCSV.mockResolvedValue({ total_processed: 2, imported: 2, skipped: 0, errors: 0 });

      const res = await api.post(`${BASE}/categories`).send({}).expect(201);

      expect(res.body).toEqual(okEnvelope(expect.objectContaining({ status: 'completed' })));
    });

    it('should return 201 with completed_with_errors status when errors > 0', async () => {
      importCategoriesCSV.mockResolvedValue({ total_processed: 2, imported: 1, skipped: 0, errors: 1 });

      const res = await api.post(`${BASE}/categories`).send({}).expect(201);

      expect(res.body).toEqual(okEnvelope(expect.objectContaining({ status: 'completed_with_errors' })));
    });

    it('should throw ValidationError for invalid separator', async () => {
      const res = await api.post(`${BASE}/categories`).query({ separator: ';;' }).send({}).expect(400);
      expect(res.body.error.message).toMatch(/separator must be a single character/);
    });

    it('should propagate service error', async () => {
      importCategoriesCSV.mockRejectedValue(new Error('boom'));

      const res = await api.post(`${BASE}/categories`).send({}).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' }));
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

      const res = await api.get(`${BASE}/batches`).expect(200);

      expect(listBatches).toHaveBeenCalledWith({ limit: 50, offset: 0 });
      // Canonical collection shape: { items, total, limit, offset } — the old
      // `batches` key is gone from the wire (the service still uses it).
      expect(res.body.data.batches).toBeUndefined();
      expect(res.body).toEqual(okEnvelope({
        items: [{ id: 1, adapter_name: 'belfius', status: 'complete', rows_imported: 10 }],
        total: 1, limit: 50, offset: 0,
      }));
    });

    it('clamps limit to 200', async () => {
      listBatches.mockResolvedValue({ batches: [], total: 0 });

      await api.get(`${BASE}/batches`).query({ limit: '999', offset: '0' }).expect(200);

      expect(listBatches).toHaveBeenCalledWith({ limit: 200, offset: 0 });
    });

    it('passes custom limit and offset', async () => {
      listBatches.mockResolvedValue({ batches: [], total: 5 });

      await api.get(`${BASE}/batches`).query({ limit: '10', offset: '20' }).expect(200);

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

      const res = await api.get(`${BASE}/batches/7`).expect(200);

      expect(getBatch).toHaveBeenCalledWith(7);
      expect(res.body.data.id).toBe(7);
    });

    it('throws ValidationError for non-numeric id', async () => {
      const res = await api.get(`${BASE}/batches/abc`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(getBatch).not.toHaveBeenCalled();
    });

    it('throws ValidationError for a trailing-garbage id like "12abc" (was treated as batch 12)', async () => {
      const res = await api.get(`${BASE}/batches/12abc`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(getBatch).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when batch does not exist', async () => {
      getBatch.mockResolvedValue(null);

      const res = await api.get(`${BASE}/batches/999`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });
  });

  // ──────────────────────────────────────────
  // DELETE /api/import/batches/:id (rollback)
  // ──────────────────────────────────────────
  describe('DELETE /batches/:id', () => {
    it('rolls back complete batch and returns deleted count', async () => {
      getBatch.mockResolvedValue({ id: 3, status: 'complete' });
      rollbackBatch.mockResolvedValue({ deleted: 15 });

      const res = await api.delete(`${BASE}/batches/3`).expect(200);

      expect(rollbackBatch).toHaveBeenCalledWith(3);
      expect(res.body.data.deleted).toBe(15);
    });

    it('throws ValidationError for non-numeric id', async () => {
      const res = await api.delete(`${BASE}/batches/nope`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(getBatch).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when batch does not exist', async () => {
      getBatch.mockResolvedValue(null);

      const res = await api.delete(`${BASE}/batches/42`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
      expect(rollbackBatch).not.toHaveBeenCalled();
    });

    it('throws ValidationError when batch already aborted', async () => {
      getBatch.mockResolvedValue({ id: 5, status: 'aborted' });

      const res = await api.delete(`${BASE}/batches/5`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(rollbackBatch).not.toHaveBeenCalled();
    });

    it.each(['staging', 'validating', 'matching', 'committing'])(
      'throws ValidationError when batch is in-progress (%s)',
      async (status) => {
        getBatch.mockResolvedValue({ id: 6, status });

        const res = await api.delete(`${BASE}/batches/6`).expect(400);
        expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
        expect(rollbackBatch).not.toHaveBeenCalled();
      }
    );

    it('returns deleted:0 when no transactions linked to batch', async () => {
      getBatch.mockResolvedValue({ id: 8, status: 'complete' });
      rollbackBatch.mockResolvedValue({ deleted: 0 });

      const res = await api.delete(`${BASE}/batches/8`).expect(200);

      expect(res.body.data.deleted).toBe(0);
    });
  });

  // ──────────────────────────────────────────
  // multer error middleware (csvUploadErrorTranslator, importRoutes.js:580)
  // ──────────────────────────────────────────
  describe('multer error middleware', () => {
    it('maps LIMIT_FILE_SIZE to a 400 VALIDATION_ERROR envelope', async () => {
      uploadState.error = new multer.MulterError('LIMIT_FILE_SIZE');

      const res = await api.post(`${BASE}/csv`).query({ bank_name: 'belfius' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR', message: 'File size exceeds maximum of 50MB' }));
    });

    it('maps other multer errors to a 400 VALIDATION_ERROR envelope', async () => {
      const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE');
      err.message = 'unexpected file';
      uploadState.error = err;

      const res = await api.post(`${BASE}/csv`).query({ bank_name: 'belfius' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR', message: 'Upload error: unexpected file' }));
    });

    it('maps a non-CSV fileFilter rejection to a 400 VALIDATION_ERROR envelope', async () => {
      uploadState.error = new Error('File must be a CSV');

      const res = await api.post(`${BASE}/csv`).query({ bank_name: 'belfius' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR', message: 'File must be a CSV' }));
    });

    it('passes unrelated errors through to the generic 500 handler', async () => {
      uploadState.error = new Error('unknown');

      const res = await api.post(`${BASE}/csv`).query({ bank_name: 'belfius' }).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'unknown' }));
    });
  });

  // ──────────────────────────────────────────
  // POST /api/import/batches/:id/rows/:rowId/category-override
  // ──────────────────────────────────────────
  describe('POST /batches/:id/rows/:rowId/category-override', () => {
    const url = (id, rowId) => `${BASE}/batches/${id}/rows/${rowId}/category-override`;

    it('rejects non-numeric ids', async () => {
      const res = await api.post(url('abc', '5')).send({ category_id: 1 }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('rejects non-integer category_id', async () => {
      const res = await api.post(url('1', '5')).send({ category_id: 'foo' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('clears the override when category_id is null', async () => {
      overrideCategory.mockResolvedValueOnce(1);

      const res = await api.post(url('1', '5')).send({ category_id: null }).expect(200);

      expect(categoryExists).not.toHaveBeenCalled();
      expect(overrideCategory).toHaveBeenCalledTimes(1);
      expect(overrideCategory).toHaveBeenCalledWith({ batchId: 1, rowId: 5, categoryId: null });
      expect(res.body.data).toEqual({ row_id: 5, override_category_id: null });
    });

    it('sets the override after verifying category exists', async () => {
      categoryExists.mockResolvedValueOnce(true);
      overrideCategory.mockResolvedValueOnce(1);

      const res = await api.post(url('7', '42')).send({ category_id: 12 }).expect(200);

      expect(categoryExists).toHaveBeenCalledWith(12);
      expect(overrideCategory).toHaveBeenCalledWith({ batchId: 7, rowId: 42, categoryId: 12 });
      expect(res.body.data).toEqual({ row_id: 42, override_category_id: 12 });
    });

    it('rejects unknown category_id with ValidationError', async () => {
      categoryExists.mockResolvedValueOnce(false);

      const res = await api.post(url('1', '5')).send({ category_id: 9999 }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('throws NotFoundError when staging row not found or wrong status', async () => {
      categoryExists.mockResolvedValueOnce(true);
      overrideCategory.mockResolvedValueOnce(0);

      const res = await api.post(url('1', '5')).send({ category_id: 1 }).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });
  });

  // ──────────────────────────────────────────
  // GET /api/import/batches/:id/preview — category fields
  // ──────────────────────────────────────────
  describe('GET /batches/:id/preview category fields', () => {
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

      const res = await api.get(`${BASE}/batches/1/preview`).expect(200);

      expect(res.body.data.groups).toHaveLength(1);
      const g = res.body.data.groups[0];
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

      const res = await api.get(`${BASE}/batches/1/preview`).expect(200);

      const g = res.body.data.groups[0];
      expect(g.override_category_id).toBe(22);
      expect(g.current_category_id).toBe(22);
      expect(g.current_category_label).toBe('Hardware: Tools');
      expect(g.recipient_default_category_id).toBe(12);
    });
  });

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

      const res = await api.get(`${BASE}/parsers`).expect(200);
      // Canonical collection shape: { items, total } (total = row count here).
      expect(res.body.data).toEqual({ items, total: 1 });
    });
  });

  describe('POST /parsers', () => {
    it('creates a parser and returns 201', async () => {
      customParserConfigRepository.create.mockResolvedValue({ id: 7, name: 'My Bank', config: validConfig });

      const res = await api.post(`${BASE}/parsers`).send({ name: 'My Bank', config: validConfig }).expect(201);

      expect(res.body.data.id).toBe(7);
      expect(customParserConfigRepository.create).toHaveBeenCalledWith({
        name: 'My Bank',
        config: expect.objectContaining({ dateColumn: 'Date', dateFormat: '%Y-%m-%d', separator: ',', encoding: 'utf-8', skipRows: 0 }),
        kind: 'transaction',
      });
    });

    it('rejects a missing name', async () => {
      const res = await api.post(`${BASE}/parsers`).send({ config: validConfig }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('rejects a config missing required columns', async () => {
      const res = await api.post(`${BASE}/parsers`).send({ name: 'X', config: { dateColumn: 'Date' } }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('maps a unique-violation to ConflictError', async () => {
      const err = Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_custom_parser_configs_name_kind' });
      customParserConfigRepository.create.mockRejectedValue(err);

      const res = await api.post(`${BASE}/parsers`).send({ name: 'My Bank', config: validConfig }).expect(409);
      expect(res.body).toEqual(errEnvelope({ code: 'CONFLICT' }));
    });
  });

  describe('PATCH /parsers/:id', () => {
    it('returns 404 when the parser does not exist', async () => {
      customParserConfigRepository.update.mockResolvedValue(undefined);

      const res = await api.patch(`${BASE}/parsers/5`).send({ name: 'New' }).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });

    it('maps a unique-violation to ConflictError', async () => {
      const err = Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_custom_parser_configs_name_kind' });
      customParserConfigRepository.update.mockRejectedValue(err);

      const res = await api.patch(`${BASE}/parsers/5`).send({ name: 'Taken' }).expect(409);
      expect(res.body).toEqual(errEnvelope({ code: 'CONFLICT' }));
    });

    // 'abc' was the only value pinned here, and it is the one the old
    // `parseInt`+isNaN guard happened to catch. '12abc' is the one that mattered:
    // it resolved to parser 12. Full matrix in parserConfigIdValidation.test.js;
    // these two keep the *real* router on the hook for wiring the guard.
    it('rejects an invalid id', async () => {
      for (const id of ['abc', '12abc']) {
        const res = await api.patch(`${BASE}/parsers/${id}`).send({ name: 'X' }).expect(400);
        expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      }
      expect(customParserConfigRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /parsers/:id', () => {
    it('returns 204 when deleted', async () => {
      customParserConfigRepository.delete.mockResolvedValue(true);

      await api.delete(`${BASE}/parsers/3`).expect(204);
    });

    it('returns 404 when nothing was deleted', async () => {
      customParserConfigRepository.delete.mockResolvedValue(false);

      const res = await api.delete(`${BASE}/parsers/3`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });

    // The 🔺 case: this used to answer 204 having deleted parser 12.
    it('rejects a malformed id instead of deleting the record it truncates to', async () => {
      customParserConfigRepository.delete.mockResolvedValue(true);

      const res = await api.delete(`${BASE}/parsers/12abc`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(customParserConfigRepository.delete).not.toHaveBeenCalled();
    });
  });
});
