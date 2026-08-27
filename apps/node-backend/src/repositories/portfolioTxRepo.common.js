/**
 * Portfolio transaction repo — shared helpers:
 *   - import_batch_id column probe (0086 rollout window) + reset
 *   - validation (normalizeTransactionPayload, validateSellUnitsAvailability)
 *   - asset-class helpers (unit-based set)
 *
 * `portfolio_transactions` is a plain flat table on every install: fresh installs get it
 * from the 0001 baseline and legacy table-inheritance installs are converted by migration
 * 0087 (ADR-109) before the backend starts listening, so no schema-shape probing is needed.
 */

import { query } from '../database/connection.js';
import { toDecimal, toNumber, roundMoney, multiply, divide } from '../lib/money.js';
import { VALID_PORTFOLIO_TXN_TYPES } from '../lib/portfolioTxnTypes.js';
import { makeValidationError } from '../lib/repositoryErrors.js';
import { UNIT_BASED_ASSET_CLASSES as UNIT_BASED_ASSET_CLASS_LIST } from '@vision/types/assetClasses';
import { PORTFOLIO_RECURRENCE_INTERVALS } from '@vision/types/recurrence';

/** @typedef {import('../types/rows.js').PortfolioTransactionRow} PortfolioTransactionRow */

/**
 * The caller-facing portfolio-transaction payload, before/after
 * {@link normalizeTransactionPayload} fills in the derived unit math.
 *
 * @typedef {object} PortfolioTransactionInput
 * @property {number} investment_id
 * @property {string} type
 * @property {string} date 'YYYY-MM-DD'
 * @property {number|string} [amount]
 * @property {number|string|null} [units]
 * @property {number|string|null} [price_per_unit]
 * @property {number|string|null} [fees]
 * @property {number|string|null} [taxes]
 * @property {string} [currency]
 * @property {string|null} [note]
 * @property {boolean} [is_recurring]
 * @property {string|null} [recurrence_interval]
 * @property {string|null} [recurrence_end_date]
 * @property {number|string|null} [fx_rate_to_eur]
 * @property {number|null} [account_id]
 * @property {number|string|null} [import_batch_id] The portfolio import batch that
 *           created this lot (migration 0086) — set only by the import commit path,
 *           NULL for manual entry. Rollback bulk-deletes on it.
 * @property {string} [preloaded_asset_class]
 */

// The recurrence_interval DB enum (migration 0001) / frontend RecurrenceInterval
// union, single-sourced in @vision/types/recurrence — note the hyphenated
// 'bi-weekly' spelling, which is NOT the planned-transaction vocabulary. An
// out-of-set value has no DB CHECK and otherwise surfaces as a raw enum-cast 500.
// Widened to Set<string>: callers probe raw, untrusted values with .has().
export const VALID_RECURRENCE_INTERVALS = new Set(
  /** @type {readonly string[]} */ (PORTFOLIO_RECURRENCE_INTERVALS)
);

/** @type {boolean|undefined} */
let _hasPortfolioTransactionImportBatchIdColumn;

/**
 * Whether portfolio_transactions carries `import_batch_id` (migration 0086).
 *
 * Migrations are applied at app boot, not by the code that needs them, so there
 * is a window on an un-migrated database where the column does not exist yet.
 * Probing (once per process) lets the import commit path omit the column from
 * its INSERT instead of 500-ing every row with 42703, and lets rollback fall
 * back to its per-id path — see 0086's docstring.
 *
 * @returns {Promise<boolean>}
 */
export async function hasPortfolioTransactionImportBatchIdColumn() {
  if (_hasPortfolioTransactionImportBatchIdColumn !== undefined) {
    return _hasPortfolioTransactionImportBatchIdColumn;
  }

  const result = await query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('public.portfolio_transactions')
          AND attname = 'import_batch_id'
          AND attnum > 0
          AND NOT attisdropped
     ) AS present`
  );
  _hasPortfolioTransactionImportBatchIdColumn = Boolean(result.rows[0]?.present);
  return _hasPortfolioTransactionImportBatchIdColumn;
}

export function __resetPortfolioTransactionSchemaCache() {
  _hasPortfolioTransactionImportBatchIdColumn = undefined;
}

// Derived from the shared canonical subset (@vision/types/assetClasses) so it
// cannot drift from the frontend's copy. Widened to Set<string>: callers probe
// raw payload values with .has().
export const UNIT_BASED_ASSET_CLASSES = new Set(/** @type {readonly string[]} */ (UNIT_BASED_ASSET_CLASS_LIST));

/**
 * @param {{ investmentId?: number|null, type?: string|null }} [filters]
 * @returns {{ where: string, params: any[], nextParam: number }}
 */
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

/**
 * @param {any} value
 * @param {string} fieldName
 * @returns {number|undefined}
 */
function parseOptionalNumber(value, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw makeValidationError(`${fieldName} must be a valid number`);
  }
  return parsed;
}

/**
 * @param {{ amount?: number, units?: number, pricePerUnit?: number }} input
 * @returns {{ amount: number, units: number, price_per_unit: number }}
 */
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
  // recurrence_interval is a DB enum with no CHECK constraint; an out-of-set
  // value 500'd at insert. The import path never sets it (undefined).
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
 * Whether the investment still has broker-unassigned lot rows (buy/gift/sell
 * with `account_id IS NULL`) — the ADR-108 transition predicate. While true,
 * sell validation stays investment-global; per-broker scoping only turns on
 * once every lot row names its account.
 *
 * @param {any} investmentId
 * @param {{ excludeTransactionId?: number }} [options]
 * @returns {Promise<boolean>}
 */
async function hasUnassignedLotRows(investmentId, { excludeTransactionId } = {}) {
  const hasExcludedTxn = Number.isInteger(excludeTransactionId) && excludeTransactionId > 0;
  const params = [investmentId];
  let sql = `
    SELECT EXISTS (
      SELECT 1 FROM portfolio_transactions
      WHERE investment_id = $1
        AND type IN ('buy', 'gift', 'sell')
        AND account_id IS NULL
  `;
  if (hasExcludedTxn) {
    params.push(excludeTransactionId);
    sql += ` AND id <> $2`;
  }
  sql += `) AS present`;
  const result = await query(sql, params);
  return Boolean(result.rows[0]?.present);
}

/**
 * Units available at ONE broker account on or before `date` — the per-account
 * variant of getNetUnitsOnOrBeforeDate, replaying the same availability rules
 * per (investment, account) partition (ADR-108): buys/gifts add to their own
 * account, sells consume at most what their own account holds (mirroring the
 * lot engine's clamp), and a `split` — an investment-wide event whose `units`
 * is the new absolute GLOBAL total — rescales every partition by the global
 * ratio, with the same no-phantom-units guard as the global replay
 * (merger/spinoff/return_of_capital: no unit change).
 *
 * @param {any} investmentId
 * @param {number} accountId
 * @param {any} date
 * @param {{ excludeTransactionId?: number }} [options]
 * @returns {Promise<number>}
 */
async function getAccountUnitsOnOrBeforeDate(investmentId, accountId, date, { excludeTransactionId } = {}) {
  if (!investmentId || !date) return 0;

  const hasExcludedTxn = Number.isInteger(excludeTransactionId) && excludeTransactionId > 0;
  const params = [investmentId, date];
  let sql = `
    SELECT type, COALESCE(units, 0) AS units, account_id
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
  const ZERO = toDecimal(0);
  /** @type {Map<number|null, import('decimal.js').default>} */
  const held = new Map();
  const keyOf = (/** @type {any} */ row) => (row.account_id == null ? null : Number(row.account_id));
  const totalHeld = () => [...held.values()].reduce((sum, h) => sum.plus(h), ZERO);

  for (const row of result.rows) {
    const units = toDecimal(row.units || 0);
    if (row.type === 'buy' || row.type === 'gift') {
      const key = keyOf(row);
      held.set(key, (held.get(key) ?? ZERO).plus(units));
    } else if (row.type === 'sell') {
      const key = keyOf(row);
      const before = held.get(key) ?? ZERO;
      held.set(key, before.minus(units.gt(before) ? before : units));
    } else if (row.type === 'split' && units.gt(0)) {
      const before = totalHeld();
      if (before.gt(0)) {
        const ratio = units.dividedBy(before);
        for (const [key, h] of held) held.set(key, h.times(ratio));
      }
    }
  }
  return toNumber(held.get(Number(accountId)) ?? ZERO);
}

/**
 * Display label for a broker account, for user-facing validation errors.
 * @param {number} accountId
 * @returns {Promise<string>}
 */
async function getAccountLabel(accountId) {
  try {
    const result = await query(
      'SELECT display_name, name FROM accounts WHERE id = $1',
      [accountId],
    );
    const row = result.rows[0];
    return row?.display_name || row?.name || `account #${accountId}`;
  } catch {
    return `account #${accountId}`;
  }
}

/**
 * Reject a sell that exceeds available units. Scope (ADR-108):
 *  - account-scoped when the sell names a broker account AND every lot row of
 *    the instrument is broker-assigned — you cannot sell at broker A what is
 *    held at broker B, even if investment-wide units would cover it; the
 *    error names the broker;
 *  - investment-global otherwise (unassigned sell, or transition rule: the
 *    instrument still has unassigned lots).
 *
 * @param {{ investmentId: any, assetClass: any, type: any, date: any, units: any, accountId?: any, excludeTransactionId?: any }} params
 */
export async function validateSellUnitsAvailability({
  investmentId,
  assetClass,
  type,
  date,
  units,
  accountId,
  excludeTransactionId,
}) {
  if (type !== 'sell') return;
  if (!UNIT_BASED_ASSET_CLASSES.has(assetClass)) return;

  const sellUnits = Number(units) || 0;
  if (sellUnits <= 0) return;

  const EPSILON = 1e-8;
  const numericAccountId = accountId == null ? undefined : Number(accountId);
  const accountScoped = Number.isInteger(numericAccountId)
    && numericAccountId > 0
    && !(await hasUnassignedLotRows(investmentId, { excludeTransactionId }));

  if (accountScoped) {
    const availableAtAccount = await getAccountUnitsOnOrBeforeDate(
      investmentId, numericAccountId, date, { excludeTransactionId },
    );
    if (sellUnits - availableAtAccount > EPSILON) {
      const label = await getAccountLabel(numericAccountId);
      throw makeValidationError(
        `sell units exceed available holdings at ${label} `
        + `(${toNumber(roundMoney(availableAtAccount, 8))} units held there)`,
      );
    }
    return;
  }

  const availableUnits = await getNetUnitsOnOrBeforeDate(investmentId, date, { excludeTransactionId });
  if (sellUnits - availableUnits > EPSILON) {
    throw makeValidationError('sell units exceed available holdings');
  }
}
