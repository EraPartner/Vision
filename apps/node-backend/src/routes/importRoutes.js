/**
 * Import routes - Full CSV import with bank adapters.
 * Mirrors: apps/backend/api/api_routes_import.py
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { importCSVWithRawStorage } from '../services/rawTransactionImportService.js';
import { importCSVStreaming } from '../services/streamingImportService.js';
import { getSupportedBanks } from '../services/bankAdapters.js';
import { importRecipientsCSV, importCategoriesCSV } from '../services/dataImportService.js';
import { logger } from '../config/logger.js';
import { scheduleRefresh } from '../services/materializedViewService.js';
import { runImportPipeline } from '../services/importPipeline/index.js';

const router = Router();

const GENERIC_IMPORT_FAILED_DETAIL = 'Import failed';

const PIPELINE_V2_ENABLED = process.env.IMPORT_PIPELINE_V2 === '1'
  || process.env.IMPORT_PIPELINE_V2 === 'true';

/**
 * Convert a V2 pipeline progress event to the legacy SSE shape used by the
 * frontend: { phase, current, total, imported, duplicates, errors, percent }.
 *
 * V2 phases advance: staging (0-40) → validating (40-55) → matching (55-70)
 * → committing (70-100). Mapping is monotonic so the progress bar never
 * regresses.
 */
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

// Configure multer for file uploads (50MB max)
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

// POST /api/import/csv - Import with predefined bank adapter
router.post('/csv', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ detail: 'No file uploaded. Send a CSV file as multipart form-data with field name "file".' });
  }

  const bankName = req.query.bank_name || req.body.bank_name;
  if (!bankName) {
    cleanup(req.file.path);
    return res.status(400).json({ detail: 'Missing required parameter: bank_name (query or body)' });
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
      // Use raw transaction storage (falls back to legacy for unsupported banks)
      result = await importCSVWithRawStorage(req.file.path, bankName);
    }
    cleanup(req.file.path);

    logger.info('CSV import completed', {
      bankName,
      fileName: req.file.originalname,
      pipeline: PIPELINE_V2_ENABLED ? 'v2' : 'legacy',
      ...result,
    });

    if (!PIPELINE_V2_ENABLED) {
      scheduleRefresh();
    }
    res.status(201).json({
      ...result,
      status: result.status || (result.errors > 0 ? 'completed_with_errors' : 'completed'),
      error_message: result.error_message || null,
      links: [],
    });
  } catch (err) {
    cleanup(req.file.path);
    logger.error('CSV import error', { error: err.message, bankName });

    if (err.message.includes('No configuration found')) {
      return res.status(400).json({ detail: `Invalid bank configuration: ${err.message}` });
    }
    res.status(500).json({ detail: GENERIC_IMPORT_FAILED_DETAIL });
  }
});

// POST /api/import/csv/custom - Import with custom CSV configuration
router.post('/csv/custom', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ detail: 'No file uploaded. Send a CSV file as multipart form-data with field name "file".' });
  }

  const {
    bank_name, date_format, date_column, recipient_column, amount_column,
    memo_column, separator, encoding, skip_rows,
  } = { ...req.query, ...req.body };

  if (!bank_name || !date_format || !date_column || !recipient_column || !amount_column) {
    cleanup(req.file.path);
    return res.status(400).json({
      detail: 'Missing required parameters: bank_name, date_format, date_column, recipient_column, amount_column',
    });
  }

  // Validate separator
  if (separator && separator.length > 1) {
    cleanup(req.file.path);
    return res.status(400).json({ detail: 'separator must be a single character' });
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
    cleanup(req.file.path);

    if (!PIPELINE_V2_ENABLED) {
      scheduleRefresh();
    }
    res.status(201).json({
      ...result,
      status: result.status || (result.errors > 0 ? 'completed_with_errors' : 'completed'),
      error_message: result.error_message || null,
      links: [],
    });
  } catch (err) {
    cleanup(req.file.path);
    logger.error('Custom CSV import error', { error: err.message });
    res.status(500).json({ detail: GENERIC_IMPORT_FAILED_DETAIL });
  }
});

// POST /api/import/csv/stream - SSE streaming import with progress
router.post('/csv/stream', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ detail: 'No file uploaded.' });
  }

  const bankName = req.query.bank_name || req.body.bank_name;
  if (!bankName) {
    cleanup(req.file.path);
    return res.status(400).json({ detail: 'Missing required parameter: bank_name' });
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Handle client disconnect
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    let result;
    if (PIPELINE_V2_ENABLED) {
      const pipelineResult = await runImportPipeline({
        filePath: req.file.path,
        adapterName: bankName,
        filename: req.file.originalname,
        sizeBytes: req.file.size,
        onProgress: (ev) => {
          if (!aborted) {
            sendEvent('progress', v2ProgressToLegacy(ev));
          }
        },
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
        (progress) => {
          if (!aborted) {
            sendEvent('progress', progress);
          }
        }
      );
    }

    cleanup(req.file.path);

    if (!aborted) {
      if (!PIPELINE_V2_ENABLED) {
        scheduleRefresh();
      }
      sendEvent('complete', {
        ...result,
        status: result.status || (result.errors > 0 ? 'completed_with_errors' : 'completed'),
        percent: 100,
      });
      res.end();
    }
  } catch (err) {
    cleanup(req.file.path);
    logger.error('Streaming CSV import error', { error: err.message });
    if (!aborted) {
      sendEvent('error', { detail: GENERIC_IMPORT_FAILED_DETAIL });
      res.end();
    }
  }
});

// GET /api/import/supported-banks
router.get('/supported-banks', (req, res) => {
  const banks = getSupportedBanks();
  res.json({
    banks: banks.map(b => b.charAt(0).toUpperCase() + b.slice(1)),
    total: banks.length,
  });
});

// POST /api/import/recipients - Bulk import recipients from CSV
router.post('/recipients', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ detail: 'No file uploaded. Send a CSV file as multipart form-data with field name "file".' });
  }

  const separator = req.query.separator || req.body.separator || ',';
  const encoding = req.query.encoding || req.body.encoding || 'utf-8';

  if (separator.length !== 1) {
    cleanup(req.file.path);
    return res.status(400).json({ detail: 'separator must be a single character' });
  }

  try {
    const result = await importRecipientsCSV(req.file.path, { separator, encoding });
    cleanup(req.file.path);
    logger.info('Recipient CSV import completed', result);
    res.status(201).json({ ...result, status: result.errors > 0 ? 'completed_with_errors' : 'completed' });
  } catch (err) {
    cleanup(req.file.path);
    logger.error('Recipient CSV import error', { error: err.message });
    res.status(500).json({ detail: GENERIC_IMPORT_FAILED_DETAIL });
  }
});

// POST /api/import/categories - Bulk import categories from CSV
router.post('/categories', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ detail: 'No file uploaded. Send a CSV file as multipart form-data with field name "file".' });
  }

  const separator = req.query.separator || req.body.separator || ',';
  const encoding = req.query.encoding || req.body.encoding || 'utf-8';

  if (separator.length !== 1) {
    cleanup(req.file.path);
    return res.status(400).json({ detail: 'separator must be a single character' });
  }

  try {
    const result = await importCategoriesCSV(req.file.path, { separator, encoding });
    cleanup(req.file.path);
    logger.info('Category CSV import completed', result);
    res.status(201).json({ ...result, status: result.errors > 0 ? 'completed_with_errors' : 'completed' });
  } catch (err) {
    cleanup(req.file.path);
    logger.error('Category CSV import error', { error: err.message });
    res.status(500).json({ detail: GENERIC_IMPORT_FAILED_DETAIL });
  }
});

// Error handler for multer
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ detail: 'File size exceeds maximum of 50MB' });
    }
    return res.status(400).json({ detail: `Upload error: ${err.message}` });
  }
  if (err.message === 'File must be a CSV') {
    return res.status(400).json({ detail: 'File must be a CSV' });
  }
  next(err);
});

function cleanup(filePath) {
  if (!filePath) return;
  void fs.promises.unlink(filePath).catch(() => {});
}

export default router;
