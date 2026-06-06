/**
 * Import routes - Full CSV import with bank adapters.
 * Mirrors: apps/backend/api/api_routes_import.py
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSupportedBanks } from '../services/bankAdapters.js';
import { importRecipientsCSV, importCategoriesCSV } from '../services/dataImportService.js';
import { logger } from '../config/logger.js';
import { runImportPipeline, commitImport } from '../services/importPipeline/index.js';
import { ValidationError, NotFoundError, ConflictError } from '../middleware/errorHandler.js';
import { createSseWriter } from '../lib/sse.js';
import {
  listBatches,
  getBatch,
  rollbackBatch,
  getPreviewRows,
  overrideRecipient,
  overrideCategory,
  categoryExists,
} from '../services/importBatchService.js';
import customParserConfigRepository from '../services/customParserConfigService.js';
import { refreshAggregations } from '../services/aggregationRefresh.js';

const router = Router();

/* eslint-disable vision-local-money/no-raw-money-arithmetic */
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
/* eslint-enable vision-local-money/no-raw-money-arithmetic */

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

// Multer writes uploads to os.tmpdir() with a generated alphanumeric filename.
// We rebuild the path from the basename + os.tmpdir() (a constant) so a tampered
// req.file.path can't escape the tmp directory, and validate the basename
// against a strict allowlist to break any taint flow into the unlink call.
const SAFE_BASENAME_RE = /^[A-Za-z0-9._-]+$/;

function cleanup(filePath) {
  if (!filePath) return;
  const basename = path.basename(filePath);
  if (!SAFE_BASENAME_RE.test(basename)) return;
  const target = path.join(os.tmpdir(), basename);
  void fs.promises.unlink(target).catch((err) => {
    // ENOENT means already removed (e.g. by another handler) — silent OK.
    if (err && err.code !== 'ENOENT') {
      logger.warn('Failed to clean up uploaded CSV temp file', {
        path: target,
        error: err.message,
      });
    }
  });
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
    const pipelineResult = await runImportPipeline({
      filePath: req.file.path,
      adapterName: bankName,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
    });

    if (pipelineResult.requiresReview) {
      res.status(202);
      res.ok({
        batch_id: pipelineResult.batchId,
        requires_review: true,
        match_source_counts: pipelineResult.matchSourceCounts,
      });
      return;
    }

    const result = {
      total: pipelineResult.total,
      imported: pipelineResult.imported,
      duplicates: pipelineResult.duplicates,
      errors: pipelineResult.errors,
      batch_id: pipelineResult.batchId,
    };

    logger.info('CSV import completed', { bankName, fileName: req.file.originalname, ...result });
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

  const separatorStr = separator != null ? String(separator) : '';
  if (separatorStr && separatorStr.length !== 1) {
    cleanup(req.file.path);
    throw new ValidationError('separator must be a single character');
  }

  const customConfig = {
    bank_name: bank_name.trim(),
    date_format: date_format.trim(),
    encoding: encoding || 'utf-8',
    separator: separatorStr || ',',
    skip_rows: parseInt(skip_rows, 10) || 0,
    column_mapping: {
      date: date_column.trim(),
      recipient: recipient_column.trim(),
      amount: amount_column.trim(),
      memo: memo_column ? memo_column.trim() : '',
    },
  };

  try {
    const pipelineResult = await runImportPipeline({
      filePath: req.file.path,
      adapterName: bank_name,
      customConfig,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
    });

    if (pipelineResult.requiresReview) {
      res.status(202);
      res.ok({
        batch_id: pipelineResult.batchId,
        requires_review: true,
        match_source_counts: pipelineResult.matchSourceCounts,
      });
      return;
    }

    const result = {
      total: pipelineResult.total,
      imported: pipelineResult.imported,
      duplicates: pipelineResult.duplicates,
      errors: pipelineResult.errors,
      batch_id: pipelineResult.batchId,
    };
    res.status(201);
    res.ok(buildImportResult(result));
  } finally {
    cleanup(req.file.path);
  }
});

// --- Saved custom parser configs (CRUD) ---------------------------------

function parseParserId(req) {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) throw new ValidationError('Invalid parser config id');
  return id;
}

function normalizeParserName(name) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('Missing or invalid "name"');
  }
  return name.trim();
}

// Validates and normalizes the column-mapping config to the frontend's
// CustomConfig shape. Required: dateColumn, recipientColumn, amountColumn.
function normalizeParserConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ValidationError('Missing or invalid "config"');
  }
  const required = ['dateColumn', 'recipientColumn', 'amountColumn'];
  for (const key of required) {
    if (!config[key] || typeof config[key] !== 'string' || config[key].trim().length === 0) {
      throw new ValidationError(`config.${key} is required`);
    }
  }
  const skipRows = parseInt(config.skipRows, 10);
  return {
    dateColumn: config.dateColumn.trim(),
    recipientColumn: config.recipientColumn.trim(),
    amountColumn: config.amountColumn.trim(),
    memoColumn: typeof config.memoColumn === 'string' ? config.memoColumn.trim() : '',
    dateFormat: typeof config.dateFormat === 'string' && config.dateFormat.trim() ? config.dateFormat.trim() : '%Y-%m-%d',
    separator: typeof config.separator === 'string' && config.separator.length ? config.separator : ',',
    encoding: typeof config.encoding === 'string' && config.encoding.trim() ? config.encoding.trim() : 'utf-8',
    skipRows: Number.isFinite(skipRows) && skipRows > 0 ? skipRows : 0,
  };
}

const PARSER_NAME_CONSTRAINT = 'uq_custom_parser_configs_name';

// GET /api/import/parsers
router.get('/parsers', async (req, res) => {
  const configs = await customParserConfigRepository.getAll();
  res.ok(configs);
});

// POST /api/import/parsers
router.post('/parsers', async (req, res) => {
  const name = normalizeParserName(req.body.name);
  const config = normalizeParserConfig(req.body.config);
  try {
    const created = await customParserConfigRepository.create({ name, config });
    res.status(201);
    res.ok(created);
  } catch (err) {
    if (err.code === '23505' && err.constraint === PARSER_NAME_CONSTRAINT) {
      throw new ConflictError(`A parser named "${name}" already exists`);
    }
    throw err;
  }
});

// PATCH /api/import/parsers/:id
router.patch('/parsers/:id', async (req, res) => {
  const id = parseParserId(req);
  const name = req.body.name !== undefined ? normalizeParserName(req.body.name) : undefined;
  const config = req.body.config !== undefined ? normalizeParserConfig(req.body.config) : undefined;
  try {
    const updated = await customParserConfigRepository.update(id, { name, config });
    if (!updated) throw new NotFoundError('Parser config not found');
    res.ok(updated);
  } catch (err) {
    if (err.code === '23505' && err.constraint === PARSER_NAME_CONSTRAINT) {
      throw new ConflictError(`A parser named "${name}" already exists`);
    }
    throw err;
  }
});

// DELETE /api/import/parsers/:id
router.delete('/parsers/:id', async (req, res) => {
  const id = parseParserId(req);
  const deleted = await customParserConfigRepository.delete(id);
  if (!deleted) throw new NotFoundError('Parser config not found');
  res.status(204).send();
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
    const pipelineResult = await runImportPipeline({
      filePath: req.file.path,
      adapterName: bankName,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      onProgress: async (ev) => { await writer.write('progress', v2ProgressToLegacy(ev)); },
    });

    if (pipelineResult.requiresReview) {
      if (!writer.closed) {
        await writer.write('review_required', {
          batch_id: pipelineResult.batchId,
          match_source_counts: pipelineResult.matchSourceCounts,
          percent: 70,
        });
        writer.end();
      }
    } else if (!writer.closed) {
      const result = {
        total_processed: pipelineResult.total,
        imported: pipelineResult.imported,
        duplicates: pipelineResult.duplicates,
        errors: pipelineResult.errors,
        batch_id: pipelineResult.batchId,
      };
      await writer.write('complete', {
        ...result,
        status: result.errors > 0 ? 'completed_with_errors' : 'completed',
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

  const separator = String(req.query.separator || req.body.separator || ',');
  const encoding = String(req.query.encoding || req.body.encoding || 'utf-8');

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

  const separator = String(req.query.separator || req.body.separator || ',');
  const encoding = String(req.query.encoding || req.body.encoding || 'utf-8');

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

  const { deleted, recipientsRemoved } = await rollbackBatch(id);
  logger.info('[import] batch rolled back', { batchId: id, deleted, recipientsRemoved });

  if (deleted > 0 || recipientsRemoved > 0) {
    try {
      await refreshAggregations();
    } catch (err) {
      logger.warn('[import] post-rollback aggregation refresh failed', { batchId: id, error: err?.message });
    }
  }

  res.ok({ deleted, recipientsRemoved });
});

// ─── Import review endpoints ──────────────────────────────────────────────────

// GET /api/import/batches/:id/preview
// Returns staging rows grouped by resolved recipient with match-source badges.
router.get('/batches/:id/preview', async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  if (!Number.isFinite(batchId)) throw new ValidationError('Invalid batch id');

  const batch = await getBatch(batchId);
  if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);

  const rows = await getPreviewRows(batchId);

  const formatCategoryLabel = (general, detail) => {
    if (!general && !detail) return null;
    return [general, detail].filter(Boolean).join(': ');
  };

  // Group rows by effective_recipient_id (null = unresolved).
  const groupMap = new Map();
  for (const row of rows) {
    const key = row.effective_recipient_id ?? '__unresolved__';
    if (!groupMap.has(key)) {
      const defaultLabel = formatCategoryLabel(
        row.recipient_default_category_general,
        row.recipient_default_category_detail,
      );
      const overrideLabel = formatCategoryLabel(
        row.override_category_general,
        row.override_category_detail,
      );
      const currentCategoryId = row.override_category_id ?? row.recipient_default_category_id ?? null;
      const currentCategoryLabel = overrideLabel ?? defaultLabel ?? null;

      groupMap.set(key, {
        recipient_id: row.effective_recipient_id,
        recipient_name: row.recipient_name,
        recipient_default_category_id: row.recipient_default_category_id ?? null,
        recipient_default_category_label: defaultLabel,
        override_category_id: row.override_category_id ?? null,
        current_category_id: currentCategoryId,
        current_category_label: currentCategoryLabel,
        matched_pattern_id: row.matched_pattern_id,
        matched_pattern_text: row.matched_pattern_text,
        matched_pattern_kind: row.matched_pattern_kind,
        rows: [],
      });
    }
    groupMap.get(key).rows.push({
      id: row.id,
      row_index: row.row_index,
      recipient_raw: row.recipient_raw,
      amount: row.amount,
      currency: row.currency,
      tx_date: row.tx_date,
      memo: row.memo,
      match_source: row.match_source,
      match_similarity: row.match_similarity,
      matched_pattern_id: row.matched_pattern_id,
      user_override_recipient_id: row.user_override_recipient_id,
      override_category_id: row.override_category_id ?? null,
    });
  }

  const groups = [...groupMap.values()].map((g) => ({
    ...g,
    row_count: g.rows.length,
  }));

  // Summary counts across all groups.
  const totals = { exact: 0, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 };
  for (const row of rows) {
    const src = row.match_source ?? 'unresolved';
    totals[src] = (totals[src] || 0) + 1;
  }

  res.ok({ batch_id: batchId, groups, totals });
});

// POST /api/import/batches/:id/rows/:rowId/override
// Set (or clear) user_override_recipient_id on a single staging row.
router.post('/batches/:id/rows/:rowId/override', async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  const rowId = parseInt(req.params.rowId, 10);
  if (!Number.isFinite(batchId) || !Number.isFinite(rowId)) {
    throw new ValidationError('Invalid batch or row id');
  }

  const { recipient_id } = req.body;
  if (recipient_id !== null && recipient_id !== undefined && !Number.isInteger(Number(recipient_id))) {
    throw new ValidationError('recipient_id must be an integer or null');
  }

  const effectiveRecipientId = recipient_id != null ? Number(recipient_id) : null;

  const rowCount = await overrideRecipient({
    batchId,
    rowId,
    recipientId: effectiveRecipientId,
  });

  if (rowCount === 0) {
    throw new NotFoundError(`Row ${rowId} not found in batch ${batchId} or not in matched status`);
  }

  res.ok({ row_id: rowId, user_override_recipient_id: effectiveRecipientId });
});

// POST /api/import/batches/:id/rows/:rowId/category-override
// Set (or clear) override_category_id on a single staging row. Symmetrical to
// the recipient override above. The category landing on the committed
// transaction is COALESCE(staging.override_category_id, recipient.default_category_id).
router.post('/batches/:id/rows/:rowId/category-override', async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  const rowId = parseInt(req.params.rowId, 10);
  if (!Number.isFinite(batchId) || !Number.isFinite(rowId)) {
    throw new ValidationError('Invalid batch or row id');
  }

  const { category_id } = req.body;
  if (category_id !== null && category_id !== undefined && !Number.isInteger(Number(category_id))) {
    throw new ValidationError('category_id must be an integer or null');
  }

  const effectiveCategoryId = category_id != null ? Number(category_id) : null;

  if (effectiveCategoryId !== null && !(await categoryExists(effectiveCategoryId))) {
    throw new ValidationError(`Category ${effectiveCategoryId} not found`);
  }

  const rowCount = await overrideCategory({
    batchId,
    rowId,
    categoryId: effectiveCategoryId,
  });

  if (rowCount === 0) {
    throw new NotFoundError(`Row ${rowId} not found in batch ${batchId} or not in matched status`);
  }

  res.ok({ row_id: rowId, override_category_id: effectiveCategoryId });
});

// POST /api/import/batches/:id/commit
// Commit a reviewed batch, honouring any user overrides set above.
router.post('/batches/:id/commit', async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  if (!Number.isFinite(batchId)) throw new ValidationError('Invalid batch id');

  const batch = await getBatch(batchId);
  if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);
  if (!['awaiting_review', 'matched'].includes(batch.status)) {
    throw new ValidationError(`Batch ${batchId} is not in a reviewable state (status: ${batch.status})`);
  }

  const { imported, duplicates, errors } = await commitImport({ batchId });

  logger.info('[import] batch committed after review', { batchId, imported, duplicates, errors });
  res.ok(buildImportResult({ batch_id: batchId, total: imported + duplicates + errors, imported, duplicates, errors }));
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
