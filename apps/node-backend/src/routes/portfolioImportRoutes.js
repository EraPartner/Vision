/**
 * Portfolio import routes — CSV import of brokerage/exchange trades into
 * portfolio_transactions. Always custom-config driven (no pre-built adapters),
 * with a review step to resolve instruments. Mirrors importRoutes.js.
 *
 * Request parsing is validated with zod (schema → safeParse → ValidationError),
 * the idiom established in settings.js/reports.js. Batch/row route ids share
 * one coerced schema with the transaction import router (lib/importBatchIds.js);
 * the multipart config/brokerage schemas coerce string fields exactly like the
 * pre-zod hand-rolled parsing (String()/parseInt fallbacks, trims, defaults).
 */

import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../config/logger.js';
import { parseBatchIdParam, parseBatchRowIdParams } from '../lib/importBatchIds.js';
import { ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import { csvUpload, cleanup, csvUploadErrorTranslator } from '../lib/csvUpload.js';
import { streamImport } from '../lib/importProgress.js';
import {
  runPortfolioImportPipeline,
  commitPortfolioImport,
} from '../services/portfolioImportPipeline/index.js';
import { VALID_PORTFOLIO_TXN_TYPES } from '../lib/portfolioTxnTypes.js';
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
import { VALID_ASSET_CLASSES } from '../lib/assetClasses.js';
import { registerParserRoutes } from '../lib/parserConfigRoutes.js';
import { parsePagination } from '../lib/pagination.js';

const router = Router();

const PARSER_KIND = 'portfolio';

function parseTypeMapping(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(/** @type {string} */ (raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
// Messages here already name their field, so issues join without path prefixes.
function parseImportInput(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((issue) => issue.message).join('; '));
  }
  return result.data;
}

// Brokerage import (ADR-095): a flag + the sleeve account every row lands on.
// Multipart fields arrive as strings; coerce them. The account is required when
// brokerage is on (cash rows need a ledger account to land on).
const brokerageParamsSchema = z.looseObject({
  is_brokerage: z.unknown().optional().transform((value) => value === true || value === 'true'),
  account_id: z.unknown().optional().transform((value, ctx) => {
    if (value == null || value === '') return undefined;
    const accountId = Number(value);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      ctx.addIssue({ code: 'custom', message: 'account_id must be a positive integer' });
      return z.NEVER;
    }
    return accountId;
  }),
}).superRefine((data, ctx) => {
  if (data.is_brokerage && data.account_id == null) {
    ctx.addIssue({
      code: 'custom',
      message: 'A brokerage import requires account_id (the sleeve cash + trades land on)',
    });
  }
}).transform((data) => ({ isBrokerage: data.is_brokerage, accountId: data.account_id }));

function parseBrokerageParams(data) {
  return parseImportInput(brokerageParamsSchema, data);
}

// Optional column-mapping field: trimmed when a string, '' otherwise.
const trimOrEmptyField = z.unknown().optional().transform((value) =>
  (typeof value === 'string' ? value.trim() : ''));

// Text field with a default: `(value && String(value).trim()) || fallback`.
const defaultedTextField = (fallback) => z.unknown().optional().transform((value) =>
  (value && String(value).trim()) || fallback);

// Flattened request fields → { customConfig, defaultAssetClass, defaultType,
// adapterName }, the shape both /csv/custom and /csv/stream hand to the
// pipeline. Field coercions mirror the pre-zod build byte for byte.
const portfolioImportConfigSchema = z.looseObject({
  date_column: z.unknown().optional().transform((value, ctx) => {
    if (!value || typeof value !== 'string' || !value.trim()) {
      ctx.addIssue({ code: 'custom', message: 'date_column is required' });
      return z.NEVER;
    }
    return value.trim();
  }),
  type_column: trimOrEmptyField,
  symbol_column: trimOrEmptyField,
  name_column: trimOrEmptyField,
  units_column: trimOrEmptyField,
  price_column: trimOrEmptyField,
  amount_column: trimOrEmptyField,
  fees_column: trimOrEmptyField,
  taxes_column: trimOrEmptyField,
  currency_column: trimOrEmptyField,
  fx_rate_column: trimOrEmptyField,
  note_column: trimOrEmptyField,
  default_asset_class: z.enum([...VALID_ASSET_CLASSES], {
    error: 'default_asset_class is required and must be a valid asset class',
  }),
  // Falsy (absent/'') falls back to 'buy' downstream; a truthy value must be a
  // valid canonical type.
  default_type: z.preprocess(
    (value) => (value || undefined),
    z.enum([...VALID_PORTFOLIO_TXN_TYPES], {
      error: (issue) => `default_type "${issue.input}" is not a valid transaction type`,
    }).optional(),
  ),
  separator: z.unknown().optional().transform((value, ctx) => {
    const separator = value != null ? String(value) : ',';
    if (separator && separator.length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'separator must be a single character' });
      return z.NEVER;
    }
    return separator || ',';
  }),
  date_format: defaultedTextField('%Y-%m-%d'),
  encoding: defaultedTextField('utf-8'),
  // csv-parse throws "Invalid Option: from must be a positive integer" on a
  // negative skip — validate here so it 400s instead of a raw 500.
  skip_rows: z.unknown().optional().transform((value, ctx) => {
    const skipRows = parseInt(/** @type {string} */ (value), 10) || 0;
    if (skipRows < 0) {
      ctx.addIssue({ code: 'custom', message: 'skip_rows must be zero or a positive integer' });
      return z.NEVER;
    }
    return skipRows;
  }),
  type_mapping: z.unknown().optional().transform(parseTypeMapping),
  adapter_name: defaultedTextField('portfolio_generic'),
}).superRefine((data, ctx) => {
  if (!data.symbol_column && !data.name_column) {
    ctx.addIssue({ code: 'custom', message: 'map at least one of symbol_column or name_column' });
  }
}).transform((data) => ({
  customConfig: {
    date_format: data.date_format,
    separator: data.separator,
    encoding: data.encoding,
    skip_rows: data.skip_rows,
    default_asset_class: data.default_asset_class,
    default_type: data.default_type || 'buy',
    type_mapping: data.type_mapping,
    column_mapping: {
      date: data.date_column,
      type: data.type_column,
      symbol: data.symbol_column,
      name: data.name_column,
      units: data.units_column,
      price: data.price_column,
      amount: data.amount_column,
      fees: data.fees_column,
      taxes: data.taxes_column,
      currency: data.currency_column,
      fx_rate: data.fx_rate_column,
      note: data.note_column,
    },
  },
  defaultAssetClass: data.default_asset_class,
  defaultType: data.default_type || 'buy',
  adapterName: data.adapter_name,
}));

// Build the backend customConfig + batch defaults from flattened request fields.
function buildPortfolioConfig(data) {
  return parseImportInput(portfolioImportConfigSchema, data);
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

  // Validate before streamImport commits the SSE headers, so rejections still
  // travel through the envelope error handler (previously this ran after
  // writeHead, corrupting the response and leaking the upload on a bad
  // account_id).
  let brokerage;
  try {
    brokerage = parseBrokerageParams({ ...req.query, ...req.body });
  } catch (err) {
    cleanup(req.file.path);
    throw err;
  }

  await streamImport(req, res, {
    filePath: req.file.path,
    errorLogMessage: 'Streaming portfolio import error',
    run: (onProgress) => runPortfolioImportPipeline({
      filePath: req.file.path,
      adapterName: built.adapterName,
      customConfig: built.customConfig,
      defaultAssetClass: built.defaultAssetClass,
      defaultType: built.defaultType,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      isBrokerage: brokerage.isBrokerage,
      accountId: brokerage.accountId,
      onProgress,
    }),
    buildComplete: (result) => ({
      batch_id: result.batchId,
      total_processed: result.total,
      skipped: result.skipped,
      imported: result.imported,
      duplicates: result.duplicates,
      errors: result.errors,
    }),
  });
});

// --- Saved portfolio parser configs (CRUD) ------------------------------------

// Stores the frontend's PortfolioCustomConfig (camelCase) as JSONB. Required:
// dateColumn, a symbol or name column, and a valid defaultAssetClass.
const portfolioParserConfigSchema = z.looseObject({
  dateColumn: z.unknown().optional().transform((value, ctx) => {
    if (!value || typeof value !== 'string' || !value.trim()) {
      ctx.addIssue({ code: 'custom', message: 'config.dateColumn is required' });
      return z.NEVER;
    }
    return value;
  }),
  defaultAssetClass: z.enum([...VALID_ASSET_CLASSES], {
    error: 'config.defaultAssetClass must be a valid asset class',
  }),
}).superRefine((config, ctx) => {
  const hasSymbol = typeof config.symbolColumn === 'string' && config.symbolColumn.trim();
  const hasName = typeof config.nameColumn === 'string' && config.nameColumn.trim();
  if (!hasSymbol && !hasName) {
    ctx.addIssue({ code: 'custom', message: 'config requires symbolColumn or nameColumn' });
  }
});

// Loose pass-through: every key (known and unknown) is stored untouched, as
// before — only presence/validity is checked.
function normalizePortfolioParserConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ValidationError('Missing or invalid "config"');
  }
  return parseImportInput(portfolioParserConfigSchema, config);
}

// GET/POST/PATCH/DELETE /parsers[/:id] — shared with the transaction import router.
registerParserRoutes(router, {
  kind: PARSER_KIND,
  normalizeConfig: normalizePortfolioParserConfig,
  label: 'portfolio ',
});

// --- Batch history + rollback -------------------------------------------------

// Canonical collection shape `{items, total, limit, offset}` — the service
// keeps its `batches` key internally, only the wire key is normalised.
router.get('/batches', async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { maxLimit: 200 });
  const { batches, total } = await listBatches({ limit, offset });
  res.ok({ items: batches, total, limit, offset });
});

router.get('/batches/:id', async (req, res) => {
  const id = parseBatchIdParam(req);
  const batch = await getBatch(id);
  if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
  res.ok(batch);
});

router.delete('/batches/:id', async (req, res) => {
  const id = parseBatchIdParam(req);
  const batch = await getBatch(id);
  if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
  if (batch.status === 'aborted') throw new ValidationError('Batch is already aborted');
  if (['staging', 'validating', 'matching', 'committing'].includes(batch.status)) {
    throw new ValidationError('Cannot rollback a batch that is still in progress');
  }
  const { deleted } = await rollbackBatch(id);
  logger.info('[portfolio-import] batch rolled back', { batchId: id, deleted });
  // Not a plain delete: a rollback reports the side-effect count the caller
  // surfaces, so it keeps a 200 body (docs/reference/code-patterns.md,
  // "DELETE responses").
  res.ok({ deleted });
});

// --- Review -------------------------------------------------------------------

router.get('/batches/:id/preview', async (req, res) => {
  const batchId = parseBatchIdParam(req);
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
  const { batchId, rowId } = parseBatchRowIdParams(req);

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
  const batchId = parseBatchIdParam(req);
  const batch = await getBatch(batchId);
  if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);
  // 'complete_with_errors' re-opens for a repair pass: the user fixes the errored
  // rows (override → reset to matched) and re-commits; commit only drains 'matched'
  // rows, so already-committed rows are untouched and only the repaired ones import.
  if (!['awaiting_review', 'matching', 'complete_with_errors'].includes(batch.status)) {
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
