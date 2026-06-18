/**
 * Portfolio transaction repo — write operations (create, update, hardDelete).
 * Polymorphic on assetClass; delegates unit-math + inheritance-table paths to common helpers.
 */

import { query } from '../database/connection.js';
import { getById, mapPortfolioTxRow } from './portfolioTxRepo.reads.js';
import {
  hasPortfolioTransactionInheritanceSchema,
  markInheritanceSchemaPresent,
  isNonUpdatablePortfolioTransactionsViewError,
  isMissingInheritanceRelationError,
  UNIT_BASED_ASSET_CLASSES,
  makeValidationError,
  normalizeTransactionPayload,
  validateSellUnitsAvailability,
  createThroughInheritanceTables,
  updateThroughInheritanceTables,
  hardDeleteThroughInheritanceTables,
} from './portfolioTxRepo.common.js';

export async function create({ investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency = 'EUR', note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id, preloaded_asset_class }) {
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
  }, { assetClass });

  await validateSellUnitsAvailability({
    investmentId: payload.investment_id,
    assetClass,
    type: payload.type,
    date: payload.date,
    units: payload.units,
  });

  if (await hasPortfolioTransactionInheritanceSchema()) {
    try {
      return await createThroughInheritanceTables(payload, getById, assetClass);
    } catch (err) {
      if (!isMissingInheritanceRelationError(err)) throw err;
    }
  }

  try {
    const result = await query(
      `INSERT INTO portfolio_transactions
         (investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
      [
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
      ]
    );
    return mapPortfolioTxRow(result.rows[0]);
  } catch (err) {
    if (!isNonUpdatablePortfolioTransactionsViewError(err)) throw err;
    markInheritanceSchemaPresent();
    return createThroughInheritanceTables(payload, getById, assetClass);
  }
}

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

  await validateSellUnitsAvailability({
    investmentId: existing.investment_id,
    assetClass,
    type: normalized.type,
    date: normalized.date,
    units: normalized.units,
    excludeTransactionId: id,
  });

  const normalizedSetClauses = [];
  const normalizedParams = [];
  let normalizedIdx = 1;
  for (const [key, value] of Object.entries(normalizedFields)) {
    if (allowed.includes(key) && value !== undefined) {
      normalizedSetClauses.push(`${key} = $${normalizedIdx++}`);
      normalizedParams.push(value);
    }
  }

  if (normalizedSetClauses.length === 0) return existing;

  if (await hasPortfolioTransactionInheritanceSchema()) {
    return updateThroughInheritanceTables(id, normalizedFields, getById);
  }

  normalizedParams.push(id);
  const sql = `UPDATE portfolio_transactions SET ${normalizedSetClauses.join(', ')} WHERE id = $${normalizedIdx} RETURNING *`;
  try {
    const result = await query(sql, normalizedParams);
    return result.rows[0] ? mapPortfolioTxRow(result.rows[0]) : null;
  } catch (err) {
    if (!isNonUpdatablePortfolioTransactionsViewError(err)) throw err;
    markInheritanceSchemaPresent();
    return updateThroughInheritanceTables(id, normalizedFields, getById);
  }
}

export async function hardDelete(id) {
  if (await hasPortfolioTransactionInheritanceSchema()) {
    try {
      return await hardDeleteThroughInheritanceTables(id);
    } catch (err) {
      if (!isMissingInheritanceRelationError(err)) throw err;
    }
  }

  try {
    const result = await query('DELETE FROM portfolio_transactions WHERE id = $1', [id]);
    return result.rowCount > 0;
  } catch (err) {
    if (!isNonUpdatablePortfolioTransactionsViewError(err)) throw err;
    markInheritanceSchemaPresent();
    return hardDeleteThroughInheritanceTables(id);
  }
}
