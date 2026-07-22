/**
 * Portfolio transaction repo — shared helpers:
 *   - schema-cache probe + reset
 *   - error classifiers (view-not-updatable, missing inheritance, duplicate id)
 *   - asset-class maps (table-by-class, unit-based set)
 *   - validation (normalizeTransactionPayload, validateSellUnitsAvailability)
 *   - inheritance-table CRUD helpers (create/update/hardDelete through base)
 */

import { query, withTransaction, withSavepointIfInTransaction } from '../database/connection.js';
import { toDecimal, toNumber, roundMoney, multiply, divide } from '../lib/money.js';
import { buildUpdateSql } from '../lib/sqlClauses.js';
import { VALID_PORTFOLIO_TXN_TYPES } from '../lib/portfolioTxnTypes.js';
import { UNIT_BASED_ASSET_CLASSES as UNIT_BASED_ASSET_CLASS_LIST } from '@vision/types/assetClasses';

// Mirrors the recurrence_interval DB enum (migration 0001) and the frontend
// RecurrenceInterval union. An out-of-set value has no DB CHECK on the flat
// table path and otherwise surfaces as a raw enum-cast 500.
export const VALID_RECURRENCE_INTERVALS = new Set([
  'daily', 'weekly', 'bi-weekly', 'monthly', 'quarterly', 'yearly',
]);

let _hasPortfolioTransactionInheritanceSchema;

export async function hasPortfolioTransactionInheritanceSchema() {
  if (_hasPortfolioTransactionInheritanceSchema !== undefined) {
    return _hasPortfolioTransactionInheritanceSchema;
  }

  const result = await query("SELECT to_regclass('public.portfolio_transactions_base') AS portfolio_transactions_base");
  _hasPortfolioTransactionInheritanceSchema = Boolean(result.rows[0]?.portfolio_transactions_base);
  return _hasPortfolioTransactionInheritanceSchema;
}

export function markInheritanceSchemaPresent() {
  _hasPortfolioTransactionInheritanceSchema = true;
}

export function markInheritanceSchemaAbsent() {
  _hasPortfolioTransactionInheritanceSchema = false;
}

export function __resetPortfolioTransactionSchemaCache() {
  _hasPortfolioTransactionInheritanceSchema = undefined;
}

export function isNonUpdatablePortfolioTransactionsViewError(err) {
  const msg = err?.message || '';
  return msg.includes('cannot update view "portfolio_transactions"')
    || msg.includes('cannot insert into view "portfolio_transactions"')
    || msg.includes('cannot delete from view "portfolio_transactions"');
}

export function isMissingInheritanceRelationError(err) {
  if (err?.code === '42P01') return true;
  const msg = err?.message || '';
  return msg.includes('relation "portfolio_transactions_base" does not exist')
    || msg.includes('relation "stock_transactions" does not exist')
    || msg.includes('relation "etf_transactions" does not exist')
    || msg.includes('relation "crypto_transactions" does not exist')
    || msg.includes('relation "metals_transactions" does not exist')
    || msg.includes('relation "real_estate_transactions" does not exist')
    || msg.includes('relation "savings_transactions" does not exist')
    || msg.includes('relation "bond_transactions" does not exist');
}

function isDuplicatePortfolioTransactionIdError(err, childTable) {
  if (err?.code !== '23505') return false;
  const msg = err?.message || '';
  const detail = err?.detail || '';
  const constraint = err?.constraint || '';
  return (constraint === `${childTable}_pkey` || msg.includes(`${childTable}_pkey`))
    && (detail.includes('Key (id)=') || msg.includes('Key (id)='));
}

async function resyncPortfolioTransactionsBaseIdSequence() {
  await query(
    "SELECT setval(pg_get_serial_sequence('portfolio_transactions_base', 'id'), COALESCE((SELECT MAX(id) FROM portfolio_transactions_base), 0) + 1, false)"
  );
}

export const TRANSACTION_TABLE_BY_ASSET_CLASS = {
  stock: 'stock_transactions',
  etf: 'etf_transactions',
  crypto: 'crypto_transactions',
  metals: 'metals_transactions',
  real_estate: 'real_estate_transactions',
  savings: 'savings_transactions',
  bond: 'bond_transactions',
};

// Derived from the shared canonical subset (@vision/types/assetClasses) so it
// cannot drift from the frontend's copy. Widened to Set<string>: callers probe
// raw payload values with .has().
export const UNIT_BASED_ASSET_CLASSES = new Set(/** @type {readonly string[]} */ (UNIT_BASED_ASSET_CLASS_LIST));

export function buildListWhereClause({ investmentId = null, type = null } = {}) {
  let where = 'WHERE 1=1';
  const params = [];
  let idx = 1;

  if (investmentId) {
    where += ` AND investment_id = $${idx++}`;
    params.push(investmentId);
  }
  if (type) {
    where += ` AND type = $${idx++}`;
    params.push(type);
  }

  return { where, params, nextParam: idx };
}

export function makeValidationError(message) {
  const err = /** @type {Error & { code?: string }} */ (new Error(message));
  err.code = 'VALIDATION_ERROR';
  return err;
}

function parseOptionalNumber(value, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw makeValidationError(`${fieldName} must be a valid number`);
  }
  return parsed;
}

function normalizeBuySellMath({ amount, units, pricePerUnit }) {
  const hasAmount = amount !== undefined;
  const hasUnits = units !== undefined;
  const hasPrice = pricePerUnit !== undefined;
  const provided = Number(hasAmount) + Number(hasUnits) + Number(hasPrice);

  if (provided < 2) {
    throw makeValidationError('For buy/sell transactions, provide at least two of amount, units, and price_per_unit');
  }

  if ((hasUnits && units <= 0) || (hasPrice && pricePerUnit <= 0) || (hasAmount && amount <= 0)) {
    throw makeValidationError('For buy/sell transactions, amount, units, and price_per_unit must be positive');
  }

  let nextAmount = amount;
  let nextUnits = units;
  let nextPrice = pricePerUnit;

  if (!hasAmount) nextAmount = roundMoney(multiply(nextUnits, nextPrice), 4);
  if (!hasUnits) nextUnits = roundMoney(divide(nextAmount, nextPrice), 8);
  if (!hasPrice) nextPrice = roundMoney(divide(nextAmount, nextUnits), 6);

  const expectedAmount = roundMoney(multiply(nextUnits, nextPrice), 4);
  const comparableAmount = roundMoney(nextAmount, 4);
  // Decimal compare: float subtraction at the tolerance boundary rejects the
  // exactly-one-cent case this check intends to accept (e.g. |100.00 − 99.99|
  // as floats is 0.010000000000005116 > 0.01).
  if (toDecimal(expectedAmount).minus(toDecimal(comparableAmount)).abs().gt('0.01')) {
    throw makeValidationError('amount must equal units * price_per_unit for buy/sell transactions');
  }

  return {
    amount: comparableAmount,
    units: roundMoney(nextUnits, 8),
    price_per_unit: roundMoney(nextPrice, 6),
  };
}

/**
 * @param {any} payload
 * @param {{ assetClass?: string }} [options]
 */
export function normalizeTransactionPayload(payload, { assetClass } = {}) {
  const type = payload.type;
  // Membership guard: an unknown type ('banana') otherwise inserted (invisible
  // to the units replay) or reached the enum column as a raw cast 500. The
  // import pipeline already constrains types to this same canonical set, so this
  // only rejects genuine garbage on the direct-API/update paths.
  if (type != null && !VALID_PORTFOLIO_TXN_TYPES.has(type)) {
    throw makeValidationError(`Invalid transaction type: ${type}`);
  }
  // recurrence_interval is a DB enum with no CHECK on the flat-table path; an
  // out-of-set value 500'd at insert. The import path never sets it (undefined).
  if (payload.recurrence_interval != null && payload.recurrence_interval !== ''
      && !VALID_RECURRENCE_INTERVALS.has(payload.recurrence_interval)) {
    throw makeValidationError(`Invalid recurrence_interval: ${payload.recurrence_interval}`);
  }
  const amount = parseOptionalNumber(payload.amount, 'amount');
  const units = parseOptionalNumber(payload.units, 'units');
  const pricePerUnit = parseOptionalNumber(payload.price_per_unit, 'price_per_unit');
  const fees = parseOptionalNumber(payload.fees, 'fees');
  const taxes = parseOptionalNumber(payload.taxes, 'taxes');
  const fxRateToEur = parseOptionalNumber(payload.fx_rate_to_eur, 'fx_rate_to_eur');

  if (fxRateToEur !== undefined && fxRateToEur <= 0) {
    throw makeValidationError('fx_rate_to_eur must be positive');
  }

  const isUnitBasedAssetClass = assetClass ? UNIT_BASED_ASSET_CLASSES.has(assetClass) : false;

  if ((type === 'buy' || type === 'sell') && isUnitBasedAssetClass) {
    const math = normalizeBuySellMath({ amount, units, pricePerUnit });
    return {
      ...payload,
      ...math,
      fees: fees ?? 0,
      taxes: taxes ?? 0,
      fx_rate_to_eur: fxRateToEur,
    };
  }

  if (type === 'buy' || type === 'sell') {
    if (amount === undefined || amount <= 0) {
      throw makeValidationError('amount is required');
    }
    return {
      ...payload,
      amount,
      units,
      price_per_unit: pricePerUnit,
      fees: fees ?? 0,
      taxes: taxes ?? 0,
      fx_rate_to_eur: fxRateToEur,
    };
  }

  if (type === 'gift') {
    if (assetClass && !UNIT_BASED_ASSET_CLASSES.has(assetClass)) {
      throw makeValidationError('gift transactions are only supported for unit-based investments');
    }
    if (units === undefined || units <= 0) {
      throw makeValidationError('gift transactions require units > 0');
    }
    if ((fees ?? 0) !== 0 || (taxes ?? 0) !== 0) {
      throw makeValidationError('gift transactions must have 0 fees and 0 taxes');
    }
    if (amount !== undefined && amount < 0) {
      throw makeValidationError('gift transaction amount cannot be negative');
    }

    return {
      ...payload,
      amount: amount ?? 0,
      units: roundMoney(units, 8),
      price_per_unit: pricePerUnit !== undefined ? roundMoney(pricePerUnit, 6) : undefined,
      fees: 0,
      taxes: 0,
      fx_rate_to_eur: fxRateToEur,
    };
  }

  if (amount === undefined) {
    throw makeValidationError('amount is required');
  }

  return {
    ...payload,
    amount,
    units,
    price_per_unit: pricePerUnit,
    fees: fees ?? 0,
    taxes: taxes ?? 0,
    fx_rate_to_eur: fxRateToEur,
  };
}

/**
 * @param {any} investmentId
 * @param {any} date
 * @param {{ excludeTransactionId?: number }} [options]
 */
async function getNetUnitsOnOrBeforeDate(investmentId, date, { excludeTransactionId } = {}) {
  if (!investmentId || !date) return 0;

  const hasExcludedTxn = Number.isInteger(excludeTransactionId) && excludeTransactionId > 0;
  const params = [investmentId, date];
  // Ordered replay, not a flat SUM: a `split` row carries the NEW absolute
  // post-split total, not a delta, so it can't be summed. Buy/gift add, sell
  // subtracts, split sets the running total to its units value — mirroring
  // snapshotBuilder / calculateCostBasis. A flat buy+gift−sell SUM under-counted
  // held units after a split, wrongly rejecting legitimate imported sells.
  let sql = `
    SELECT type, COALESCE(units, 0) AS units
    FROM portfolio_transactions
    WHERE investment_id = $1
      AND date <= $2::date
  `;

  if (hasExcludedTxn) {
    params.push(excludeTransactionId);
    sql += ` AND id <> $3`;
  }
  sql += ` ORDER BY date ASC, id ASC`;

  const result = await query(sql, params);
  let net = toDecimal(0);
  for (const row of result.rows) {
    const units = toDecimal(row.units || 0);
    if (row.type === 'buy' || row.type === 'gift') net = net.plus(units);
    else if (row.type === 'sell') net = net.minus(units);
    // Split only applies to units already held (net.gt(0)) — matching the
    // canonical core (shared-utils/portfolio.js, snapshotBuilder). A stray/
    // imported split with no prior buys must NOT mint phantom units, or a sell
    // that every valuation path treats as an oversell would validate here.
    else if (row.type === 'split' && units.gt(0) && net.gt(0)) net = units; // absolute new total
    // return_of_capital / merger / spinoff / cash rows: no unit change
  }
  return toNumber(net);
}

/**
 * @param {{ investmentId: any, assetClass: any, type: any, date: any, units: any, excludeTransactionId?: any }} params
 */
export async function validateSellUnitsAvailability({
  investmentId,
  assetClass,
  type,
  date,
  units,
  excludeTransactionId,
}) {
  if (type !== 'sell') return;
  if (!UNIT_BASED_ASSET_CLASSES.has(assetClass)) return;

  const sellUnits = Number(units) || 0;
  if (sellUnits <= 0) return;

  const availableUnits = await getNetUnitsOnOrBeforeDate(investmentId, date, { excludeTransactionId });
  const EPSILON = 1e-8;
  if (sellUnits - availableUnits > EPSILON) {
    throw makeValidationError('sell units exceed available holdings');
  }
}

export const BASE_ALLOWED_FIELDS = [
  'date',
  'amount',
  'fees',
  'taxes',
  'currency',
  'note',
  'is_recurring',
  'recurrence_interval',
  'recurrence_end_date',
  'fx_rate_to_eur',
  'account_id', // owning account for the lot (ADR-091)
];

export const CHILD_ALLOWED_FIELDS_BY_ASSET_CLASS = {
  stock: ['units', 'price_per_unit'],
  etf: ['units', 'price_per_unit'],
  crypto: ['units', 'price_per_unit'],
  metals: ['units', 'price_per_unit'],
  real_estate: [],
  savings: [],
  bond: [],
};

export async function createThroughInheritanceTables(fields, getByIdFn, preloadedAssetClass) {
  const {
    investment_id,
    type,
    date,
    amount,
    units,
    price_per_unit,
    fees,
    taxes,
    currency = 'EUR',
    note,
    is_recurring,
    recurrence_interval,
    recurrence_end_date,
    fx_rate_to_eur,
    account_id,
  } = fields;

  const assetClass = preloadedAssetClass;
  const childTable = TRANSACTION_TABLE_BY_ASSET_CLASS[assetClass];

  if (!childTable) throw new Error(`Unsupported investment asset_class: ${assetClass}`);

  const baseColumns = [
    'investment_id',
    'type',
    'date',
    'amount',
    'fees',
    'taxes',
    'currency',
    'note',
    'is_recurring',
    'recurrence_interval',
    'recurrence_end_date',
    'fx_rate_to_eur',
    'account_id',
  ];
  const baseValues = [
    investment_id,
    type,
    date,
    amount,
    fees || 0,
    taxes || 0,
    currency,
    note || null,
    is_recurring || false,
    recurrence_interval || null,
    recurrence_end_date || null,
    fx_rate_to_eur ?? null,
    account_id ?? null,
  ];

  const childColumns = [];
  const childValues = [];
  if (assetClass === 'stock' || assetClass === 'etf' || assetClass === 'crypto' || assetClass === 'metals') {
    childColumns.push('units', 'price_per_unit');
    childValues.push(units || null, price_per_unit || null);
  }

  const columns = [...baseColumns, ...childColumns];
  const values = [...baseValues, ...childValues];
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT INTO ${childTable} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`;

  try {
    let insertResult;
    try {
      // Savepoint so a caught 23505 inside an ambient withTransaction doesn't
      // poison the tx before the resync + retry below.
      insertResult = await withSavepointIfInTransaction('ptx_inherit_insert', () => query(insertSql, values));
    } catch (err) {
      // Resync only on an actual duplicate-id collision. Running setval()
      // unconditionally before every insert made concurrent creates race each
      // other into 23505 instead of preventing it.
      if (!isDuplicatePortfolioTransactionIdError(err, childTable)) throw err;
      await resyncPortfolioTransactionsBaseIdSequence();
      insertResult = await query(insertSql, values);
    }

    const id = insertResult.rows[0]?.id;
    if (!id) return null;
    return getByIdFn(id);
  } catch (err) {
    if (!isMissingInheritanceRelationError(err)) throw err;
    markInheritanceSchemaAbsent();
    throw err;
  }
}

export async function hardDeleteThroughInheritanceTables(id) {
  try {
    const result = await query('DELETE FROM portfolio_transactions_base WHERE id = $1', [id]);
    return result.rowCount > 0;
  } catch (err) {
    if (!isMissingInheritanceRelationError(err)) throw err;
    markInheritanceSchemaAbsent();
    throw err;
  }
}

export async function updateThroughInheritanceTables(id, fields, getByIdFn) {
  try {
    const existing = await getByIdFn(id);
    if (!existing) return null;

    const investmentResult = await query('SELECT asset_class FROM investments WHERE id = $1', [existing.investment_id]);
    const assetClass = investmentResult.rows[0]?.asset_class;
    const childTable = TRANSACTION_TABLE_BY_ASSET_CLASS[assetClass];
    const childAllowed = CHILD_ALLOWED_FIELDS_BY_ASSET_CLASS[assetClass] || [];

    if (!childTable) return existing;

    const baseUpdate = buildUpdateSql('portfolio_transactions_base', id, fields, BASE_ALLOWED_FIELDS);
    const childUpdate = buildUpdateSql(childTable, id, fields, childAllowed);

    if (!baseUpdate && !childUpdate) return existing;

    await withTransaction(async (client) => {
      if (baseUpdate) await client.query(baseUpdate.sql, baseUpdate.params);
      if (childUpdate) await client.query(childUpdate.sql, childUpdate.params);
    });

    return getByIdFn(id);
  } catch (err) {
    if (!isMissingInheritanceRelationError(err)) throw err;
    markInheritanceSchemaAbsent();
    throw err;
  }
}
