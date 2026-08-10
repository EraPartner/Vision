/**
 * Portfolio transaction repo — write operations (create, update, hardDelete).
 * Delegates unit-math validation to the common helpers. Writes target the flat
 * `portfolio_transactions` table — the only shape after migration 0087 (ADR-109).
 */

import { query } from '../database/connection.js';
import { buildSetClauses } from '../lib/sqlClauses.js';
import { getById, mapPortfolioTxRow } from './portfolioTxRepo.reads.js';
import {
  hasPortfolioTransactionImportBatchIdColumn,
  UNIT_BASED_ASSET_CLASSES,
  makeValidationError,
  normalizeTransactionPayload,
  validateSellUnitsAvailability,
} from './portfolioTxRepo.common.js';

/** @typedef {import('../types/rows.js').PortfolioTransactionRow} PortfolioTransactionRow */

/**
 * @param {import('./portfolioTxRepo.common.js').PortfolioTransactionInput} input
 * @returns {Promise<PortfolioTransactionRow|null>}
 */
export async function create({ investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency = 'EUR', note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id, import_batch_id, preloaded_asset_class }) {
  let assetClass = preloaded_asset_class;
  if (!assetClass) {
    const investmentResult = await query('SELECT asset_class FROM investments WHERE id = $1', [investment_id]);
    assetClass = investmentResult.rows[0]?.asset_class;
  }

  if (!assetClass) {
    throw makeValidationError('Investment not found');
  }

  const payload = normalizeTransactionPayload({
    investment_id,
    type,
    date,
    amount,
    units,
    price_per_unit,
    fees,
    taxes,
    currency,
    note,
    is_recurring,
    recurrence_interval,
    recurrence_end_date,
    fx_rate_to_eur,
    account_id,
    import_batch_id,
  }, { assetClass });

  // Recurrence hygiene: a non-recurring row must not carry a stale interval /
  // end-date, and a bounded series must end on or after its start date. The
  // import path leaves is_recurring falsy, so this is a no-op there.
  if (!payload.is_recurring) {
    payload.recurrence_interval = null;
    payload.recurrence_end_date = null;
  } else if (payload.recurrence_end_date && payload.date
      && String(payload.recurrence_end_date) < String(payload.date)) {
    throw makeValidationError('recurrence_end_date must be on or after the transaction date');
  }

  await validateSellUnitsAvailability({
    investmentId: payload.investment_id,
    assetClass,
    type: payload.type,
    date: payload.date,
    units: payload.units,
    accountId: payload.account_id,
  });

  const columns = [
    'investment_id', 'type', 'date', 'amount', 'units', 'price_per_unit', 'fees', 'taxes',
    'currency', 'note', 'is_recurring', 'recurrence_interval', 'recurrence_end_date',
    'fx_rate_to_eur', 'account_id',
  ];
  const values = [
    payload.investment_id,
    payload.type,
    payload.date,
    payload.amount,
    payload.units ?? null,
    payload.price_per_unit ?? null,
    payload.fees ?? 0,
    payload.taxes ?? 0,
    payload.currency,
    payload.note || null,
    payload.is_recurring || false,
    payload.recurrence_interval || null,
    payload.recurrence_end_date || null,
    payload.fx_rate_to_eur ?? null,
    payload.account_id ?? null,
  ];

  // Import provenance (0086): appended ONLY for the import commit path, and only
  // when the column exists on this database. Manual creates therefore emit the
  // exact same statement as before — and neither the probe nor the extra column
  // costs them anything.
  if (payload.import_batch_id != null && await hasPortfolioTransactionImportBatchIdColumn()) {
    columns.push('import_batch_id');
    values.push(payload.import_batch_id);
  }

  const result = await query(
    `INSERT INTO portfolio_transactions
       (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING *`,
    values
  );
  return mapPortfolioTxRow(result.rows[0]);
}

/**
 * @param {number} id
 * @param {Record<string, any>} fields
 * @returns {Promise<PortfolioTransactionRow|null>}
 */
export async function update(id, fields) {
  const allowed = ['date', 'amount', 'units', 'price_per_unit', 'fees', 'taxes', 'currency', 'note', 'is_recurring', 'recurrence_interval', 'recurrence_end_date', 'fx_rate_to_eur', 'account_id'];

  const existing = await getById(id);
  if (!existing) return null;

  if (Object.prototype.hasOwnProperty.call(fields, 'type') && fields.type !== existing.type) {
    throw makeValidationError('type cannot be changed');
  }

  const merged = {
    ...existing,
    ...fields,
  };
  let assetClass = existing.asset_class;
  if (!assetClass) {
    const investmentResult = await query('SELECT asset_class FROM investments WHERE id = $1', [existing.investment_id]);
    assetClass = investmentResult.rows[0]?.asset_class;
  }
  const hasAmountInPatch = Object.prototype.hasOwnProperty.call(fields, 'amount');
  const hasUnitsInPatch = Object.prototype.hasOwnProperty.call(fields, 'units');
  const hasPriceInPatch = Object.prototype.hasOwnProperty.call(fields, 'price_per_unit');
  const patchCount = Number(hasAmountInPatch) + Number(hasUnitsInPatch) + Number(hasPriceInPatch);
  const shouldApplyUnitMath = (merged.type === 'buy' || merged.type === 'sell')
    && Boolean(assetClass)
    && UNIT_BASED_ASSET_CLASSES.has(assetClass);

  if (shouldApplyUnitMath && patchCount === 1) {
    throw makeValidationError('For buy/sell transaction updates, provide at least two of amount, units, and price_per_unit');
  }

  const inputForNormalization = { ...merged };
  if (shouldApplyUnitMath && patchCount === 2) {
    if (!hasAmountInPatch) inputForNormalization.amount = undefined;
    if (!hasUnitsInPatch) inputForNormalization.units = undefined;
    if (!hasPriceInPatch) inputForNormalization.price_per_unit = undefined;
  }

  const normalized = normalizeTransactionPayload(inputForNormalization, { assetClass });
  const normalizedFields = { ...fields };
  const normalizedType = normalized.type;
  const shouldNormalizeAllUnitMath = (normalizedType === 'buy' || normalizedType === 'sell')
    && Boolean(assetClass)
    && UNIT_BASED_ASSET_CLASSES.has(assetClass);

  if (shouldNormalizeAllUnitMath || fields.amount !== undefined) normalizedFields.amount = normalized.amount;
  if (shouldNormalizeAllUnitMath || fields.units !== undefined) normalizedFields.units = normalized.units;
  if (shouldNormalizeAllUnitMath || fields.price_per_unit !== undefined) normalizedFields.price_per_unit = normalized.price_per_unit;

  const shouldApplyDefaultFeesTaxes = shouldNormalizeAllUnitMath || normalizedType === 'gift';
  if (shouldApplyDefaultFeesTaxes || fields.fees !== undefined) normalizedFields.fees = normalized.fees;
  if (shouldApplyDefaultFeesTaxes || fields.taxes !== undefined) normalizedFields.taxes = normalized.taxes;
  if (fields.fx_rate_to_eur !== undefined) normalizedFields.fx_rate_to_eur = normalized.fx_rate_to_eur;

  // Recurrence hygiene on update: turning recurrence off clears the now-stale
  // interval/end-date; a bounded series's end date must stay on or after its
  // start date (checked only when the patch actually touches either field).
  if (fields.is_recurring === false) {
    normalizedFields.recurrence_interval = null;
    normalizedFields.recurrence_end_date = null;
  } else {
    const touchesRecurrenceWindow = fields.recurrence_end_date !== undefined || fields.date !== undefined;
    if (touchesRecurrenceWindow && merged.is_recurring
        && merged.recurrence_end_date && merged.date
        && String(merged.recurrence_end_date) < String(merged.date)) {
      throw makeValidationError('recurrence_end_date must be on or after the transaction date');
    }
  }

  await validateSellUnitsAvailability({
    investmentId: existing.investment_id,
    assetClass,
    type: normalized.type,
    date: normalized.date,
    units: normalized.units,
    // Effective post-update account: the patch's value when it touches
    // account_id (including explicit null = unassign), else the stored one.
    accountId: normalized.account_id,
    excludeTransactionId: id,
  });

  const {
    clauses: normalizedSetClauses,
    params: normalizedParams,
    nextIdx: normalizedIdx,
  } = buildSetClauses(normalizedFields, { allowed });

  if (normalizedSetClauses.length === 0) return existing;

  normalizedParams.push(id);
  const sql = `UPDATE portfolio_transactions SET ${normalizedSetClauses.join(', ')} WHERE id = $${normalizedIdx} RETURNING *`;
  const result = await query(sql, normalizedParams);
  return result.rows[0] ? mapPortfolioTxRow(result.rows[0]) : null;
}

/**
 * @param {number} id
 * @returns {Promise<boolean>}
 */
export async function hardDelete(id) {
  const result = await query('DELETE FROM portfolio_transactions WHERE id = $1', [id]);
  return result.rowCount > 0;
}

/**
 * Hard-delete every lot stamped with `import_batch_id = batchId` in ONE statement
 * (migration 0086) — the portfolio equivalent of the bank side's
 * `DELETE FROM transactions WHERE import_batch_id = $1`.
 *
 * Scope is the batch stamp and nothing else: no id list is passed in, so this
 * cannot repeat the cross-table id confusion that once let a `transactions.id`
 * delete an unrelated portfolio trade of the same number. Cash rows live in
 * `transactions` and are never stamped with a PORTFOLIO batch id (the column
 * there FKs to `import_batches`, a different table), so they are structurally
 * out of reach of this statement.
 *
 * Returns the deleted ids so the caller can tell which of a batch's committed
 * rows were covered here and which (pre-0086, `import_batch_id IS NULL`) still
 * need the per-id fallback.
 *
 * @param {number|string} batchId
 * @returns {Promise<Array<number|string>>} ids of the lots deleted (empty on an
 *          un-migrated database, where the caller's fallback does all the work)
 */
export async function hardDeleteByImportBatch(batchId) {
  if (!await hasPortfolioTransactionImportBatchIdColumn()) return [];

  const result = await query(
    'DELETE FROM portfolio_transactions WHERE import_batch_id = $1 RETURNING id',
    [batchId],
  );
  return result.rows.map((/** @type {{id: number|string}} */ r) => r.id);
}

/**
 * Repoint portfolio lots from merged-away source accounts onto the survivor
 * (ADR-088 account merge).
 *
 * @param {number} targetId
 * @param {number[]} sourceIds
 * @returns {Promise<number>} rows repointed
 */
export async function repointAccount(targetId, sourceIds) {
  const result = await query(
    'UPDATE portfolio_transactions SET account_id = $1 WHERE account_id = ANY($2::int[])',
    [targetId, sourceIds],
  );
  return result.rowCount ?? 0;
}
