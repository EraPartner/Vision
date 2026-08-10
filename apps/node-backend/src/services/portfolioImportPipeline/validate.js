/**
 * Portfolio import pipeline — VALIDATE
 *
 * For each pending staging row: normalize the transaction type, check the row
 * carries enough numeric fields for its type (a light pre-check; the repo
 * re-validates at commit), compute a dedup hash, and mark the row 'validated',
 * 'duplicate' (same hash earlier in this batch), or 'error'. The normalized
 * `type` is persisted so match/commit don't re-derive it.
 */

import crypto from 'crypto';
import { query } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { parsedDateToYmd } from '../../lib/importDates.js';
import { toYmd } from '../../utils/portfolioMath.js';
import { todayAppDateString } from '../../lib/timezone.js';
import { UNIT_BASED_ASSET_CLASSES } from '../../repositories/portfolioTxRepo.common.js';
import { normalizeType } from './portfolioTypeNormalizer.js';
import { classifyBrokerageRow } from '../importPipeline/brokerageRouting.js';

/**
 * @typedef {import('../../types/rows.js').PortfolioImportStagingRow} PortfolioImportStagingRow
 * @typedef {import('./index.js').PortfolioImportBatchId} PortfolioImportBatchId
 * @typedef {import('./index.js').PortfolioImportProgressCallback} PortfolioImportProgressCallback
 */

/**
 * The projection validate.js reads. `tx_date` is selected RAW here (unlike the
 * transaction pipeline), so it really is a pg local-midnight `Date` —
 * `resolveAndCheck` formats it with LOCAL getters (`toYmd`) on purpose.
 *
 * @typedef {Pick<PortfolioImportStagingRow,
 *   'id'|'row_index'|'tx_date'|'type_raw'|'symbol_raw'|'name_raw'|'units'|'price_per_unit'|'amount'|'raw_data'>} PendingPortfolioStagingRow
 */

const VALIDATE_CHUNK = 500;

/**
 * Run the validate phase: normalize each pending row's type, pre-check its
 * numeric fields, hash it, and mark it validated / duplicate / error.
 *
 * @param {{ batchId: PortfolioImportBatchId, onProgress?: PortfolioImportProgressCallback }} args
 * @returns {Promise<{ validated: number, duplicates: number, errors: number }>}
 */
export async function validateBatch({ batchId, onProgress }) {
  await query(`UPDATE portfolio_import_batches SET status = 'validating' WHERE id = $1`, [batchId]);

  const { rows: batchRows } = await query(
    `SELECT default_asset_class, default_type, custom_config, is_brokerage FROM portfolio_import_batches WHERE id = $1`,
    [batchId],
  );
  const batch = batchRows[0] || {};
  const defaultAssetClass = batch.default_asset_class || undefined;
  const defaultType = batch.default_type || undefined;
  const isBrokerage = batch.is_brokerage === true;
  const config = typeof batch.custom_config === 'string'
    ? JSON.parse(batch.custom_config)
    : (batch.custom_config || {});
  const typeMapping = config.type_mapping || {};
  const unitBased = defaultAssetClass ? UNIT_BASED_ASSET_CLASSES.has(defaultAssetClass) : false;

  const { rows: pending } = await query(
    `SELECT id, row_index, tx_date, type_raw, symbol_raw, name_raw, units, price_per_unit, amount, raw_data
       FROM portfolio_import_staging_rows
      WHERE batch_id = $1 AND status = 'pending'
      ORDER BY row_index ASC`,
    [batchId],
  );

  // App-timezone calendar day (ADR-009), computed once — used to reject
  // future-dated rows below.
  const today = todayAppDateString();

  const total = pending.length;
  let seen = 0;
  let errors = 0;
  let duplicates = 0;
  /** @type {Set<string>} */
  const seenHashes = new Set();

  if (onProgress) onProgress({ phase: 'validating', current: 0, total });

  for (let start = 0; start < total; start += VALIDATE_CHUNK) {
    const chunk = pending.slice(start, start + VALIDATE_CHUNK);
    /** @type {string[]} */
    const ids = [];
    /** @type {string[]} */
    const statuses = [];
    /** @type {(string|null|undefined)[]} */
    const types = [];
    /** @type {(string|null|undefined)[]} */
    const routes = [];
    /** @type {(string|null)[]} */
    const txHashes = [];
    /** @type {(string|null)[]} */
    const errorMessages = [];

    for (const row of /** @type {PendingPortfolioStagingRow[]} */ (chunk)) {
      ids.push(row.id);
      const { type, route, error } = resolveAndCheck(row, { typeMapping, defaultType, unitBased, isBrokerage, today });
      if (error) {
        errors++;
        statuses.push('error');
        types.push(null);
        routes.push(null);
        txHashes.push(null);
        errorMessages.push(error);
        continue;
      }
      const hash = computeRowHash(row, type, route);
      if (seenHashes.has(hash)) {
        duplicates++;
        statuses.push('duplicate');
        types.push(type);
        routes.push(route);
        txHashes.push(hash);
        errorMessages.push(null);
      } else {
        seenHashes.add(hash);
        statuses.push('validated');
        types.push(type);
        routes.push(route);
        txHashes.push(hash);
        errorMessages.push(null);
      }
    }

    await query(
      `UPDATE portfolio_import_staging_rows s
          SET status        = v.status,
              type          = v.type::portfolio_txn_type,
              route         = v.route,
              tx_hash       = v.tx_hash,
              error_message = v.error_message
         FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
              AS v(id, status, type, route, tx_hash, error_message)
        WHERE s.id = v.id`,
      [ids, statuses, types, routes, txHashes, errorMessages],
    );
    seen += chunk.length;
    if (onProgress) onProgress({ phase: 'validating', current: seen, total });
  }

  if (duplicates > 0) {
    await query(
      `UPDATE portfolio_import_batches SET rows_duplicate = COALESCE(rows_duplicate, 0) + $2 WHERE id = $1`,
      [batchId, duplicates],
    );
  }
  if (errors > 0) {
    await query(
      `UPDATE portfolio_import_batches SET rows_error = COALESCE(rows_error, 0) + $2 WHERE id = $1`,
      [batchId, errors],
    );
  }

  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  const validated = total - errors - duplicates;
  logger.info('[portfolio-pipeline:validate] done', { batchId, total, validated, duplicates, errors });
  return { validated, duplicates, errors };
}

/**
 * Resolve one staging row's canonical type and brokerage route, or report why
 * it cannot be committed.
 *
 * @param {PendingPortfolioStagingRow} row
 * @param {{ typeMapping: Record<string, string>, defaultType: string|undefined, unitBased: boolean, isBrokerage: boolean, today: string }} options
 * @returns {{ type?: string, route?: string, error?: string }} exactly one of `type`/`error` is meaningful
 */
function resolveAndCheck(row, { typeMapping, defaultType, unitBased, isBrokerage, today }) {
  if (!row.tx_date) return { error: 'missing date' };

  // Reject future-dated rows: a typo'd year (e.g. 2035) or a broker export with a
  // trade-settlement date ahead of today would otherwise pass validation and
  // commit a transaction dated in the future, skewing every time-based portfolio
  // calc. tx_date is a pg DATE (local-midnight Date) — format with local getters
  // (toYmd), never UTC, then compare against the app-timezone calendar day.
  if (today) {
    const rowYmd = toYmd(row.tx_date);
    if (rowYmd && rowYmd > today) return { error: 'transaction date is in the future' };
  }

  // Try the portfolio type first (handles aliases + the user's type_mapping).
  // Brokerage dividend/interest/fee/tax rows resolve here and route 'portfolio'
  // when they name an instrument; instrument-less ones route 'cash' below (D6,
  // ADR-095 addendum). External cash (deposit/withdrawal) never normalizes as a
  // portfolio type and takes the cash route in the error branch.
  const { type, error } = normalizeType(row.type_raw, { typeMapping, defaultType });
  if (error) {
    if (isBrokerage) {
      const { target } = classifyBrokerageRow({ kind: row.type_raw });
      if (target === 'cash') {
        if (row.amount == null) return { error: 'cash row requires an amount' };
        return { type: undefined, route: 'cash' };
      }
    }
    return { error };
  }

  const hasUnits = row.units != null;
  const hasPrice = row.price_per_unit != null;
  const hasAmount = row.amount != null;

  if ((type === 'buy' || type === 'sell') && unitBased) {
    if (Number(hasUnits) + Number(hasPrice) + Number(hasAmount) < 2) {
      return { error: 'provide at least two of units, price, amount' };
    }
  } else if (type === 'gift') {
    if (!hasUnits) return { error: 'gift requires units' };
  } else if (!hasAmount) {
    return { error: 'missing amount' };
  }

  if (isBrokerage && type) {
    // D6 (ADR-095 addendum): an instrument-less dividend/interest/fee/tax row
    // is a cash movement — one signed transactions row on the sleeve — instead
    // of a portfolio row that can only ever error "unresolved instrument" at
    // commit. Deterministic from the row itself: no symbol AND no name means
    // there is nothing the matcher (or the user) could ever attach it to. A
    // row that names an instrument keeps the portfolio route, where an
    // unresolved match is a correct signal for user review. The row's
    // canonical `type` is persisted alongside route='cash' so commit derives
    // the ledger sign and the auto-category from the kind.
    const hasInstrument = Boolean(
      String(row.symbol_raw || '').trim() || String(row.name_raw || '').trim(),
    );
    const { target } = classifyBrokerageRow({ kind: type, hasInstrument });
    if (target === 'cash') return { type, route: 'cash' };
  }

  return { type, route: isBrokerage ? 'portfolio' : undefined };
}

/**
 * sha256 of route|type|raw record, falling back to the parsed fields when the
 * adapter kept no raw record.
 *
 * @param {PendingPortfolioStagingRow} row
 * @param {string|undefined} type
 * @param {string|undefined} route
 * @returns {string} lowercase hex digest
 */
function computeRowHash(row, type, route) {
  let raw;
  if (row.raw_data) {
    raw = `${route || 'portfolio'}|${type || ''}|${row.raw_data}`;
  } else {
    const dateStr = parsedDateToYmd(row.tx_date);
    raw = `${route || 'portfolio'}|${dateStr}|${type || ''}|${row.amount ?? ''}|${row.units ?? ''}`;
  }
  return crypto.createHash('sha256').update(raw, 'utf-8').digest('hex');
}
