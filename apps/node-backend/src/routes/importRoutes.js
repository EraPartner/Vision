/**
 * Import routes - Full CSV import with bank adapters.
 * Mirrors: apps/backend/api/api_routes_import.py
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import { importCSVWithRawStorage } from '../services/rawTransactionImportService.js';
import { importCSVStreaming } from '../services/streamingImportService.js';
import { getSupportedBanks } from '../services/bankAdapters.js';
import { importRecipientsCSV, importCategoriesCSV } from '../services/dataImportService.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { scheduleRefresh } from '../services/materializedViewService.js';
import { runImportPipeline } from '../services/importPipeline/index.js';
import { ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import { createSseWriter } from '../lib/sse.js';
import { listBatches, getBatch, rollbackBatch } from '../repositories/importBatchRepository.js';
import { refreshAggregations } from '../services/aggregationRefresh.js';

const router = Router();

const PIPELINE_V2_ENABLED = env.IMPORT_PIPELINE_V2;

function v2ProgressToLegacy(ev) {
  const { phase, current = 0, total = 0, imported = 0, duplicates = 0, errors = 0 } = ev;
  const frac = total > 0 ? current / total : 0;
  let percent = 0;
  if (phase === 'staging') percent = Math.round(frac * 40);
  else if (phase === 'validating') percent = 40 + Math.round(frac * 15);
  else if (phase === 'matching') percent = 55 + Math.round(frac * 15);
  else if (phase === 'committing') percent = 70 + Math.round(frac * 30);
  else if (phase === 'complete') percent = 100;
  return { phase, current, total, imported, duplicates, errors, percent };
}

function isLikelyCsvFile(file) {
  const originalName = file?.originalname?.toLowerCase() || '';
  const mimeType = file?.mimetype?.toLowerCase() || '';
  const hasCsvExtension = originalName.endsWith('.csv');
  const hasLikelyCsvMimeType = mimeType.includes('csv')
    || mimeType.includes('text/plain')
    || mimeType.includes('application/vnd.ms-excel')
    || mimeType === 'application/octet-stream'
    || mimeType === '';
  return hasCsvExtension && hasLikelyCsvMimeType;
}

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!isLikelyCsvFile(file)) {
      cb(new Error('File must be a CSV'));
    } else {
      cb(null, true);
    }
  },
});

function cleanup(filePath) {
  if (!filePath) return;
  void fs.promises.unlink(filePath).catch(() => {});
}

function buildImportResult(result) {
  return {
    ...result,
    status: result.status || (result.errors > 0 ? 'completed_with_errors' : 'completed'),
    error_message: result.error_message || null,
    links: [],
  };
}

// POST /api/import/csv
router.post('/csv', upload.single('file'), async (req, res) => {
  if (!req.file) {
    throw new ValidationError('No file uploaded. Send a CSV file as multipart form-data with field name "file".');
  }

  const bankName = req.query.bank_name || req.body.bank_name;
  if (!bankName) {
    cleanup(req.file.path);
    throw new ValidationError('Missing required parameter: bank_name (query or body)');
  }

  try {
    let result;
    if (PIPELINE_V2_ENABLED) {
      const pipelineResult = await runImportPipeline({
        filePath: req.file.path,
        adapterName: bankName,
        filename: req.file.originalname,
        sizeBytes: req.file.size,
      });
      result = {
        total: pipelineResult.total,
        imported: pipelineResult.imported,
        duplicates: pipelineResult.duplicates,
        errors: pipelineResult.errors,
        batch_id: pipelineResult.batchId,
      };
    } else {
      result = await importCSVWithRawStorage(req.file.path, bankName);
    }

    logger.info('CSV import completed', {
      bankName,
      fileName: req.file.originalname,
      pipeline: PIPELINE_V2_ENABLED ? 'v2' : 'legacy',
      ...result,
    });

    if (!PIPELINE_V2_ENABLED) scheduleRefresh();
    res.status(201);
    res.ok(buildImportResult(result));
  } catch (err) {
    if (err.message?.includes('No configuration found')) {
      throw new ValidationError(`Invalid bank configuration: ${err.message}`);
    }
    throw err;
  } finally {
    cleanup(req.file.path);
  }
});

// POST /api/import/csv/custom
router.post('/csv/custom', upload.single('file'), async (req, res) => {
  if (!req.file) {
    throw new ValidationError('No file uploaded. Send a CSV file as multipart form-data with field name "file".');
  }

  const {
    bank_name, date_format, date_column, recipient_column, amount_column,
    memo_column, separator, encoding, skip_rows,
  } = { ...req.query, ...req.body };

  if (!bank_name || !date_format || !date_column || !recipient_column || !amount_column) {
    cleanup(req.file.path);
    throw new ValidationError(
      'Missing required parameters: bank_name, date_format, date_column, recipient_column, amount_column',
    );
  }

  if (separator && separator.length > 1) {
    cleanup(req.file.path);
    throw new ValidationError('separator must be a single character');
  }

  const customConfig = {
    bank_name: bank_name.trim(),
    date_format: date_format.trim(),
    encoding: encoding || 'utf-8',
    separator: separator || ',',
    skip_rows: parseInt(skip_rows, 10) || 0,
    column_mapping: {
      date: date_column.trim(),
      recipient: recipient_column.trim(),
      amount: amount_column.trim(),
      memo: memo_column ? memo_column.trim() : '',
    },
  };

  try {
    let result;
    if (PIPELINE_V2_ENABLED) {
      const pipelineResult = await runImportPipeline({
        filePath: req.file.path,
        adapterName: bank_name,
        customConfig,
        filename: req.file.originalname,
        sizeBytes: req.file.size,
      });
      result = {
        total: pipelineResult.total,
        imported: pipelineResult.imported,
        duplicates: pipelineResult.duplicates,
        errors: pipelineResult.errors,
        batch_id: pipelineResult.batchId,
      };
    } else {
      result = await importCSVWithRawStorage(req.file.path, bank_name, customConfig);
    }

    if (!PIPELINE_V2_ENABLED) scheduleRefresh();
    res.status(201);
    res.ok(buildImportResult(result));
  } finally {
    cleanup(req.file.path);
  }
});

// POST /api/import/csv/stream — SSE, preserves raw event protocol
router.post('/csv/stream', upload.single('file'), async (req, res) => {
  if (!req.file) {
    throw new ValidationError('No file uploaded.');
  }

  const bankName = req.query.bank_name || req.body.bank_name;
  if (!bankName) {
    cleanup(req.file.path);
    throw new ValidationError('Missing required parameter: bank_name');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const writer = createSseWriter(req, res);

  try {
    let result;
    if (PIPELINE_V2_ENABLED) {
      const pipelineResult = await runImportPipeline({
        filePath: req.file.path,
        adapterName: bankName,
        filename: req.file.originalname,
        sizeBytes: req.file.size,
        onProgress: async (ev) => { await writer.write('progress', v2ProgressToLegacy(ev)); },
      });
      result = {
        total: pipelineResult.total,
        imported: pipelineResult.imported,
        duplicates: pipelineResult.duplicates,
        errors: pipelineResult.errors,
        batch_id: pipelineResult.batchId,
      };
    } else {
      result = await importCSVStreaming(
        req.file.path,
        bankName,
        null,
        async (progress) => { await writer.write('progress', progress); },
      );
    }

    if (!writer.closed) {
      if (!PIPELINE_V2_ENABLED) scheduleRefresh();
      await writer.write('complete', {
        ...result,
        status: result.status || (result.errors > 0 ? 'completed_with_errors' : 'completed'),
        percent: 100,
      });
      writer.end();
    }
  } catch (err) {
    logger.error('Streaming CSV import error', { error: err.message });
    if (!writer.closed) {
      await writer.write('error', { detail: 'Import failed' });
      writer.end();
    }
  } finally {
    cleanup(req.file.path);
  }
});

// GET /api/import/supported-banks
router.get('/supported-banks', (req, res) => {
  const banks = getSupportedBanks();
  res.ok({
    banks: banks.map(b => b.charAt(0).toUpperCase() + b.slice(1)),
    total: banks.length,
  });
});

// POST /api/import/recipients
router.post('/recipients', upload.single('file'), async (req, res) => {
  if (!req.file) {
    throw new ValidationError('No file uploaded. Send a CSV file as multipart form-data with field name "file".');
  }

  const separator = req.query.separator || req.body.separator || ',';
  const encoding = req.query.encoding || req.body.encoding || 'utf-8';

  if (separator.length !== 1) {
    cleanup(req.file.path);
    throw new ValidationError('separator must be a single character');
  }

  try {
    const result = await importRecipientsCSV(req.file.path, { separator, encoding });
    logger.info('Recipient CSV import completed', result);
    res.status(201);
    res.ok({ ...result, status: result.errors > 0 ? 'completed_with_errors' : 'completed' });
  } finally {
    cleanup(req.file.path);
  }
});

// POST /api/import/categories
router.post('/categories', upload.single('file'), async (req, res) => {
  if (!req.file) {
    throw new ValidationError('No file uploaded. Send a CSV file as multipart form-data with field name "file".');
  }

  const separator = req.query.separator || req.body.separator || ',';
  const encoding = req.query.encoding || req.body.encoding || 'utf-8';

  if (separator.length !== 1) {
    cleanup(req.file.path);
    throw new ValidationError('separator must be a single character');
  }

  try {
    const result = await importCategoriesCSV(req.file.path, { separator, encoding });
    logger.info('Category CSV import completed', result);
    res.status(201);
    res.ok({ ...result, status: result.errors > 0 ? 'completed_with_errors' : 'completed' });
  } finally {
    cleanup(req.file.path);
  }
});

// ─── Batch history + rollback ─────────────────────────────────────────────────

// GET /api/import/batches
router.get('/batches', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
  const offset = parseInt(req.query.offset ?? '0', 10);
  const { batches, total } = await listBatches({ limit, offset });
  res.ok({ batches, total, limit, offset });
});

// GET /api/import/batches/:id
router.get('/batches/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) throw new ValidationError('Invalid batch id');
  const batch = await getBatch(id);
  if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
  res.ok(batch);
});

// DELETE /api/import/batches/:id — rollback: deletes transactions, marks batch aborted
router.delete('/batches/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) throw new ValidationError('Invalid batch id');

  const batch = await getBatch(id);
  if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
  if (batch.status === 'aborted') throw new ValidationError('Batch is already aborted');
  if (['staging', 'validating', 'matching', 'committing'].includes(batch.status)) {
    throw new ValidationError('Cannot rollback a batch that is still in progress');
  }

  const { deleted } = await rollbackBatch(id);
  logger.info('[import] batch rolled back', { batchId: id, deleted });

  if (deleted > 0) {
    refreshAggregations().catch((err) => {
      logger.warn('[import] post-rollback aggregation refresh failed', { batchId: id, error: err?.message });
    });
  }

  res.ok({ deleted });
});

// Multer error translator — convert to typed errors so global handler emits envelope.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new ValidationError('File size exceeds maximum of 50MB'));
    }
    return next(new ValidationError(`Upload error: ${err.message}`));
  }
  if (err.message === 'File must be a CSV') {
    return next(new ValidationError('File must be a CSV'));
  }
  next(err);
});

export default router;
