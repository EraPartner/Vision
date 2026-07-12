/**
 * Portfolio import routes — CSV import of brokerage/exchange trades into
 * portfolio_transactions. Always custom-config driven (no pre-built adapters),
 * with a review step to resolve instruments. Mirrors importRoutes.js.
 */

import { Router } from 'express';
import { logger } from '../config/logger.js';
import { ValidationError, NotFoundError, ConflictError } from '../middleware/errorHandler.js';
import { createSseWriter } from '../lib/sse.js';
import { csvUpload, cleanup, csvUploadErrorTranslator } from '../lib/csvUpload.js';
import { progressToPercent } from '../lib/importProgress.js';
import {
  runPortfolioImportPipeline,
  commitPortfolioImport,
} from '../services/portfolioImportPipeline/index.js';
import { VALID_PORTFOLIO_TXN_TYPES } from '../services/portfolioImportPipeline/portfolioTypeNormalizer.js';
import {
  listBatches,
  getBatch,
  getPreviewRows,
  overrideInvestment,
  createInvestmentForRow,
  rollbackBatch,
  setBatchAccount,
} from '../services/portfolioImportBatchService.js';
import accountService from '../services/accountService.js';
import customParserConfigRepository from '../services/customParserConfigService.js';
import { VALID_ASSET_CLASSES } from '../lib/assetClasses.js';
import { parseParserId, normalizeParserName, PARSER_NAME_CONSTRAINT } from '../lib/parserConfigRoutes.js';
import { parsePagination } from '../lib/pagination.js';

const router = Router();

const PARSER_KIND = 'portfolio';

function parseTypeMapping(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Brokerage import (ADR-095): a flag + the sleeve account every row lands on.
// Multipart fields arrive as strings; coerce them. The account is required when
// brokerage is on (cash rows + trade legs need a sleeve).
function parseBrokerageParams(data) {
  const isBrokerage = data.is_brokerage === true || data.is_brokerage === 'true';
  const rawAccount = data.account_id;
  let accountId;
  if (rawAccount != null && rawAccount !== '') {
    accountId = Number(rawAccount);
    if (!Number.isInteger(accountId) || accountId <= 0) throw new ValidationError('account_id must be a positive integer');
  }
  if (isBrokerage && accountId == null) {
    throw new ValidationError('A brokerage import requires account_id (the sleeve cash + trades land on)');
  }
  return { isBrokerage, accountId };
}

// Build the backend customConfig + batch defaults from flattened request fields.
function buildPortfolioConfig(data) {
  const {
    date_format, separator, encoding, skip_rows,
    date_column, type_column, symbol_column, name_column,
    units_column, price_column, amount_column, fees_column, taxes_column,
    currency_column, fx_rate_column, note_column,
    default_asset_class, default_type, type_mapping,
  } = data;

  if (!date_column || typeof date_column !== 'string' || !date_column.trim()) {
    throw new ValidationError('date_column is required');
  }
  const hasSymbol = typeof symbol_column === 'string' && symbol_column.trim();
  const hasName = typeof name_column === 'string' && name_column.trim();
  if (!hasSymbol && !hasName) {
    throw new ValidationError('map at least one of symbol_column or name_column');
  }
  if (!default_asset_class || !VALID_ASSET_CLASSES.has(default_asset_class)) {
    throw new ValidationError('default_asset_class is required and must be a valid asset class');
  }
  if (default_type && !VALID_PORTFOLIO_TXN_TYPES.has(default_type)) {
    throw new ValidationError(`default_type "${default_type}" is not a valid transaction type`);
  }
  const sep = separator != null ? String(separator) : ',';
  if (sep && sep.length !== 1) {
    throw new ValidationError('separator must be a single character');
  }

  const trimOrEmpty = (v) => (typeof v === 'string' ? v.trim() : '');

  // csv-parse throws "Invalid Option: from must be a positive integer" on a
  // negative skip — validate here so it 400s instead of a raw 500.
  const skipRows = parseInt(skip_rows, 10) || 0;
  if (skipRows < 0) {
    throw new ValidationError('skip_rows must be zero or a positive integer');
  }

  const customConfig = {
    date_format: (date_format && String(date_format).trim()) || '%Y-%m-%d',
    separator: sep || ',',
    encoding: (encoding && String(encoding).trim()) || 'utf-8',
    skip_rows: skipRows,
    default_asset_class,
    default_type: default_type || 'buy',
    type_mapping: parseTypeMapping(type_mapping),
    column_mapping: {
      date: date_column.trim(),
      type: trimOrEmpty(type_column),
      symbol: trimOrEmpty(symbol_column),
      name: trimOrEmpty(name_column),
      units: trimOrEmpty(units_column),
      price: trimOrEmpty(price_column),
      amount: trimOrEmpty(amount_column),
      fees: trimOrEmpty(fees_column),
      taxes: trimOrEmpty(taxes_column),
      currency: trimOrEmpty(currency_column),
      fx_rate: trimOrEmpty(fx_rate_column),
      note: trimOrEmpty(note_column),
    },
  };

  return {
    customConfig,
    defaultAssetClass: default_asset_class,
    defaultType: default_type || 'buy',
    adapterName: (data.adapter_name && String(data.adapter_name).trim()) || 'portfolio_generic',
  };
}

// POST /api/portfolio/import/csv/custom — one-shot (202 if review needed)
router.post('/csv/custom', csvUpload.single('file'), async (req, res) => {
  if (!req.file) throw new ValidationError('No file uploaded.');
  let built;
  try {
    built = buildPortfolioConfig({ ...req.query, ...req.body });
  } catch (err) {
    cleanup(req.file.path);
    throw err;
  }

  const brokerage = parseBrokerageParams({ ...req.query, ...req.body });

  try {
    const result = await runPortfolioImportPipeline({
      filePath: req.file.path,
      adapterName: built.adapterName,
      customConfig: built.customConfig,
      defaultAssetClass: built.defaultAssetClass,
      defaultType: built.defaultType,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      isBrokerage: brokerage.isBrokerage,
      accountId: brokerage.accountId,
    });

    if (result.requiresReview) {
      res.status(202);
      res.ok({ batch_id: result.batchId, requires_review: true, match_source_counts: result.matchSourceCounts });
      return;
    }
    res.status(201);
    res.ok({
      batch_id: result.batchId,
      total: result.total,
      skipped: result.skipped,
      imported: result.imported,
      duplicates: result.duplicates,
      errors: result.errors,
    });
  } finally {
    cleanup(req.file.path);
  }
});

// POST /api/portfolio/import/csv/stream — SSE progress
router.post('/csv/stream', csvUpload.single('file'), async (req, res) => {
  if (!req.file) throw new ValidationError('No file uploaded.');
  let built;
  try {
    built = buildPortfolioConfig({ ...req.query, ...req.body });
  } catch (err) {
    cleanup(req.file.path);
    throw err;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const writer = createSseWriter(req, res);
  const brokerage = parseBrokerageParams({ ...req.query, ...req.body });

  try {
    const result = await runPortfolioImportPipeline({
      filePath: req.file.path,
      adapterName: built.adapterName,
      customConfig: built.customConfig,
      defaultAssetClass: built.defaultAssetClass,
      defaultType: built.defaultType,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      isBrokerage: brokerage.isBrokerage,
      accountId: brokerage.accountId,
      onProgress: async (ev) => { await writer.write('progress', progressToPercent(ev)); },
    });

    if (result.requiresReview) {
      if (!writer.closed) {
        await writer.write('review_required', {
          batch_id: result.batchId,
          match_source_counts: result.matchSourceCounts,
          percent: 70,
        });
        writer.end();
      }
    } else if (!writer.closed) {
      await writer.write('complete', {
        batch_id: result.batchId,
        total_processed: result.total,
        skipped: result.skipped,
        imported: result.imported,
        duplicates: result.duplicates,
        errors: result.errors,
        status: result.errors > 0 ? 'completed_with_errors' : 'completed',
        percent: 100,
      });
      writer.end();
    }
  } catch (err) {
    logger.error('Streaming portfolio import error', { error: err.message });
    if (!writer.closed) {
      // Expected validation failures (zero-row batch, bad config) carry a safe,
      // actionable message; anything else stays generic to avoid leaking internals.
      const detail = err instanceof ValidationError ? err.message : 'Import failed';
      await writer.write('error', { detail });
      writer.end();
    }
  } finally {
    cleanup(req.file.path);
  }
});

// --- Saved portfolio parser configs (CRUD) ------------------------------------

// Stores the frontend's PortfolioCustomConfig (camelCase) as JSONB. Required:
// dateColumn, a symbol or name column, and a valid defaultAssetClass.
function normalizePortfolioParserConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ValidationError('Missing or invalid "config"');
  }
  if (!config.dateColumn || typeof config.dateColumn !== 'string' || !config.dateColumn.trim()) {
    throw new ValidationError('config.dateColumn is required');
  }
  const hasSymbol = typeof config.symbolColumn === 'string' && config.symbolColumn.trim();
  const hasName = typeof config.nameColumn === 'string' && config.nameColumn.trim();
  if (!hasSymbol && !hasName) {
    throw new ValidationError('config requires symbolColumn or nameColumn');
  }
  if (!config.defaultAssetClass || !VALID_ASSET_CLASSES.has(config.defaultAssetClass)) {
    throw new ValidationError('config.defaultAssetClass must be a valid asset class');
  }
  return config;
}

router.get('/parsers', async (req, res) => {
  res.ok(await customParserConfigRepository.getAll(PARSER_KIND));
});

router.post('/parsers', async (req, res) => {
  const name = normalizeParserName(req.body.name);
  const config = normalizePortfolioParserConfig(req.body.config);
  try {
    const created = await customParserConfigRepository.create({ name, config, kind: PARSER_KIND });
    res.status(201);
    res.ok(created);
  } catch (err) {
    if (err.code === '23505' && err.constraint === PARSER_NAME_CONSTRAINT) {
      throw new ConflictError(`A portfolio parser named "${name}" already exists`);
    }
    throw err;
  }
});

router.patch('/parsers/:id', async (req, res) => {
  const id = parseParserId(req);
  const name = req.body.name !== undefined ? normalizeParserName(req.body.name) : undefined;
  const config = req.body.config !== undefined ? normalizePortfolioParserConfig(req.body.config) : undefined;
  try {
    const updated = await customParserConfigRepository.update(id, { name, config });
    if (!updated) throw new NotFoundError('Parser config not found');
    res.ok(updated);
  } catch (err) {
    if (err.code === '23505' && err.constraint === PARSER_NAME_CONSTRAINT) {
      throw new ConflictError(`A portfolio parser named "${name}" already exists`);
    }
    throw err;
  }
});

router.delete('/parsers/:id', async (req, res) => {
  const id = parseParserId(req);
  const deleted = await customParserConfigRepository.delete(id);
  if (!deleted) throw new NotFoundError('Parser config not found');
  res.status(204).send();
});

// --- Batch history + rollback -------------------------------------------------

router.get('/batches', async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { maxLimit: 200 });
  const { batches, total } = await listBatches({ limit, offset });
  res.ok({ batches, total, limit, offset });
});

router.get('/batches/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) throw new ValidationError('Invalid batch id');
  const batch = await getBatch(id);
  if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
  res.ok(batch);
});

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
  logger.info('[portfolio-import] batch rolled back', { batchId: id, deleted });
  res.ok({ deleted });
});

// --- Review -------------------------------------------------------------------

router.get('/batches/:id/preview', async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  if (!Number.isFinite(batchId)) throw new ValidationError('Invalid batch id');
  const batch = await getBatch(batchId);
  if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);

  const rows = await getPreviewRows(batchId);

  // Group by effective investment. Unresolved rows (no investment yet) group by
  // their raw symbol/name so each distinct unmatched instrument is its own group
  // — never lump different unmatched instruments together.
  const groupMap = new Map();
  for (const row of rows) {
    // Brokerage cash rows (ADR-095) carry no instrument — collect them in one
    // dedicated cash group so the review never prompts to resolve a holding for them.
    const key = row.route === 'cash'
      ? 'cash'
      : (row.effective_investment_id != null
        ? `inv:${row.effective_investment_id}`
        : `raw:${(row.symbol_raw || row.name_raw || '?').toLowerCase()}`);
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        is_cash: row.route === 'cash',
        investment_id: row.effective_investment_id,
        investment_name: row.investment_name,
        investment_symbol: row.investment_symbol,
        investment_asset_class: row.investment_asset_class,
        raw_symbol: row.route === 'cash' ? null : row.symbol_raw,
        raw_name: row.route === 'cash' ? null : row.name_raw,
        rows: [],
      });
    }
    groupMap.get(key).rows.push({
      id: row.id,
      row_index: row.row_index,
      status: row.status,
      route: row.route,
      tx_date: row.tx_date,
      type: row.type,
      type_raw: row.type_raw,
      symbol_raw: row.symbol_raw,
      name_raw: row.name_raw,
      units: row.units,
      price_per_unit: row.price_per_unit,
      amount: row.amount,
      fees: row.fees,
      taxes: row.taxes,
      currency: row.currency,
      fx_rate_to_eur: row.fx_rate_to_eur,
      note: row.note,
      match_source: row.match_source,
      error_message: row.error_message,
      user_override_investment_id: row.user_override_investment_id,
    });
  }

  const groups = [...groupMap.values()].map((g) => ({ ...g, row_count: g.rows.length }));

  const totals = { symbol: 0, name_exact: 0, unresolved: 0, error: 0 };
  for (const row of rows) {
    if (row.status === 'error') { totals.error += 1; continue; }
    const src = row.match_source ?? 'unresolved';
    totals[src] = (totals[src] || 0) + 1;
  }

  res.ok({ batch_id: batchId, groups, totals });
});

// POST /api/portfolio/import/batches/:id/rows/:rowId/investment-override
// Body: { investment_id } to point at an existing holding, or { create_new: true }.
router.post('/batches/:id/rows/:rowId/investment-override', async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  const rowId = parseInt(req.params.rowId, 10);
  if (!Number.isFinite(batchId) || !Number.isFinite(rowId)) {
    throw new ValidationError('Invalid batch or row id');
  }

  if (req.body.create_new === true) {
    const investment = await createInvestmentForRow({ batchId, rowId });
    if (!investment) throw new NotFoundError(`Row ${rowId} not found in batch ${batchId}`);
    res.ok({ row_id: rowId, investment_id: investment.id, created: true, investment });
    return;
  }

  const { investment_id } = req.body;
  if (investment_id !== null && investment_id !== undefined && !Number.isInteger(Number(investment_id))) {
    throw new ValidationError('investment_id must be an integer or null');
  }
  const effectiveId = investment_id != null ? Number(investment_id) : null;

  const rowCount = await overrideInvestment({ batchId, rowId, investmentId: effectiveId });
  if (rowCount === 0) {
    throw new NotFoundError(`Row ${rowId} not found in batch ${batchId} or not in matched status`);
  }
  res.ok({ row_id: rowId, user_override_investment_id: effectiveId });
});

// POST /api/portfolio/import/batches/:id/commit
router.post('/batches/:id/commit', async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  if (!Number.isFinite(batchId)) throw new ValidationError('Invalid batch id');
  const batch = await getBatch(batchId);
  if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);
  if (!['awaiting_review', 'matching'].includes(batch.status)) {
    throw new ValidationError(`Batch ${batchId} is not in a reviewable state (status: ${batch.status})`);
  }

  // Optional batch-level brokerage account (ADR-095): committed lots inherit it
  // (ADR-091). Validate it exists, then store on the batch so commit stamps it.
  const { account_id } = req.body ?? {};
  if (account_id !== undefined && account_id !== null) {
    const accountId = Number(account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new ValidationError('account_id must be a positive integer');
    }
    await accountService.get(accountId); // throws NotFoundError if missing
    await setBatchAccount(batchId, accountId);
  }

  const { imported, duplicates, errors } = await commitPortfolioImport({ batchId });
  logger.info('[portfolio-import] batch committed after review', { batchId, imported, duplicates, errors });
  res.ok({ batch_id: batchId, total: imported + duplicates + errors, imported, duplicates, errors });
});

router.use(csvUploadErrorTranslator);

export default router;
