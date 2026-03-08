/**
 * Import routes - Full CSV import with bank adapters.
 * Mirrors: apps/backend/api/api_routes_import.py
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { importCSV } from '../services/importService.js';
import { importCSVWithRawStorage } from '../services/rawTransactionImportService.js';
import { importCSVStreaming } from '../services/streamingImportService.js';
import { getSupportedBanks } from '../services/bankAdapters.js';
import { logger } from '../config/logger.js';
import { scheduleRefresh } from '../services/materializedViewService.js';

const router = Router();

// Configure multer for file uploads (50MB max)
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
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
    // Use raw transaction storage (falls back to legacy for unsupported banks)
    const result = await importCSVWithRawStorage(req.file.path, bankName);
    cleanup(req.file.path);

    logger.info('CSV import completed', {
      bankName,
      fileName: req.file.originalname,
      ...result,
    });

    scheduleRefresh();
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
    res.status(500).json({ detail: `Import failed: ${err.message}` });
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
    const result = await importCSVWithRawStorage(req.file.path, bank_name, customConfig);
    cleanup(req.file.path);

    scheduleRefresh();
    res.status(201).json({
      ...result,
      status: result.status || (result.errors > 0 ? 'completed_with_errors' : 'completed'),
      error_message: result.error_message || null,
      links: [],
    });
  } catch (err) {
    cleanup(req.file.path);
    logger.error('Custom CSV import error', { error: err.message });
    res.status(500).json({ detail: `Import failed: ${err.message}` });
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
    const result = await importCSVStreaming(
      req.file.path,
      bankName,
      null,
      (progress) => {
        if (!aborted) {
          sendEvent('progress', progress);
        }
      }
    );

    cleanup(req.file.path);

    if (!aborted) {
      sendEvent('complete', {
        ...result,
        status: result.status || (result.errors > 0 ? 'completed_with_errors' : 'completed'),
      });
      res.end();
    }
  } catch (err) {
    cleanup(req.file.path);
    logger.error('Streaming CSV import error', { error: err.message });
    if (!aborted) {
      sendEvent('error', { detail: err.message });
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
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
}

export default router;
