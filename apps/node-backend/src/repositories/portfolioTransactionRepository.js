/**
 * Portfolio Transaction Repository - data access for portfolio_transactions table.
 */

import { query } from '../database/connection.js';

let _hasPortfolioTransactionInheritanceSchema;

async function hasPortfolioTransactionInheritanceSchema() {
  if (_hasPortfolioTransactionInheritanceSchema !== undefined) {
    return _hasPortfolioTransactionInheritanceSchema;
  }

  const result = await query("SELECT to_regclass('public.portfolio_transactions_base') AS portfolio_transactions_base");
  _hasPortfolioTransactionInheritanceSchema = Boolean(result.rows[0]?.portfolio_transactions_base);
  return _hasPortfolioTransactionInheritanceSchema;
}

export function __resetPortfolioTransactionSchemaCache() {
  _hasPortfolioTransactionInheritanceSchema = undefined;
}

function isNonUpdatablePortfolioTransactionsViewError(err) {
  const msg = err?.message || '';
  return msg.includes('cannot update view "portfolio_transactions"')
    || msg.includes('cannot insert into view "portfolio_transactions"')
    || msg.includes('cannot delete from view "portfolio_transactions"');
}

function isMissingInheritanceRelationError(err) {
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

const TRANSACTION_TABLE_BY_ASSET_CLASS = {
  stock: 'stock_transactions',
  etf: 'etf_transactions',
  crypto: 'crypto_transactions',
  metals: 'metals_transactions',
  real_estate: 'real_estate_transactions',
  savings: 'savings_transactions',
  bond: 'bond_transactions',
};

const UNIT_BASED_ASSET_CLASSES = new Set(['stock', 'etf', 'crypto', 'metals']);

function makeValidationError(message) {
  const err = new Error(message);
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

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
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

  if (!hasAmount) nextAmount = roundTo(nextUnits * nextPrice, 4);
  if (!hasUnits) nextUnits = roundTo(nextAmount / nextPrice, 8);
  if (!hasPrice) nextPrice = roundTo(nextAmount / nextUnits, 6);

  const expectedAmount = roundTo(nextUnits * nextPrice, 4);
  const comparableAmount = roundTo(nextAmount, 4);
  if (Math.abs(expectedAmount - comparableAmount) > 0.01) {
    throw makeValidationError('amount must equal units * price_per_unit for buy/sell transactions');
  }

  return {
    amount: comparableAmount,
    units: roundTo(nextUnits, 8),
    price_per_unit: roundTo(nextPrice, 6),
  };
}

function normalizeTransactionPayload(payload, { assetClass } = {}) {
  const type = payload.type;
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
      units: roundTo(units, 8),
      price_per_unit: pricePerUnit !== undefined ? roundTo(pricePerUnit, 6) : undefined,
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

async function getNetUnitsOnOrBeforeDate(investmentId, date, { excludeTransactionId } = {}) {
  if (!investmentId || !date) return 0;

  const hasExcludedTxn = Number.isInteger(excludeTransactionId) && excludeTransactionId > 0;
  const params = [investmentId, date];
  let sql = `
    SELECT COALESCE(SUM(
      CASE
        WHEN type IN ('buy', 'gift') THEN COALESCE(units, 0)
        WHEN type = 'sell' THEN -COALESCE(units, 0)
        ELSE 0
      END
    ), 0) AS net_units
    FROM portfolio_transactions
    WHERE investment_id = $1
      AND date <= $2::date
  `;

  if (hasExcludedTxn) {
    params.push(excludeTransactionId);
    sql += ` AND id <> $3`;
  }

  const result = await query(sql, params);
  return parseFloat(result.rows[0]?.net_units ?? 0) || 0;
}

async function validateSellUnitsAvailability({
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

const BASE_ALLOWED_FIELDS = [
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
];

const CHILD_ALLOWED_FIELDS_BY_ASSET_CLASS = {
  stock: ['units', 'price_per_unit'],
  etf: ['units', 'price_per_unit'],
  crypto: ['units', 'price_per_unit'],
  metals: ['units', 'price_per_unit'],
  real_estate: [],
  savings: [],
  bond: [],
};

function buildUpdateSql(tableName, id, fields, allowedFields) {
  const setClauses = [];
  const params = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClauses.push(`${key} = $${idx++}`);
      params.push(value);
    }
  }

  if (!setClauses.length) return null;

  params.push(id);
  return {
    sql: `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    params,
  };
}

async function createThroughInheritanceTables(fields, getByIdFn, preloadedAssetClass) {
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
    await resyncPortfolioTransactionsBaseIdSequence();

    let insertResult;
    try {
      insertResult = await query(insertSql, values);
    } catch (err) {
      if (!isDuplicatePortfolioTransactionIdError(err, childTable)) throw err;
      await resyncPortfolioTransactionsBaseIdSequence();
      insertResult = await query(insertSql, values);
    }

    const id = insertResult.rows[0]?.id;
    if (!id) return null;
    return getByIdFn(id);
  } catch (err) {
    if (!isMissingInheritanceRelationError(err)) throw err;
    _hasPortfolioTransactionInheritanceSchema = false;
    throw err;
  }
}

async function hardDeleteThroughInheritanceTables(id) {
  try {
    const result = await query('DELETE FROM portfolio_transactions_base WHERE id = $1', [id]);
    return result.rowCount > 0;
  } catch (err) {
    if (!isMissingInheritanceRelationError(err)) throw err;
    _hasPortfolioTransactionInheritanceSchema = false;
    throw err;
  }
}

async function updateThroughInheritanceTables(id, fields, getByIdFn) {
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

    if (baseUpdate) await query(baseUpdate.sql, baseUpdate.params);
    if (childUpdate) await query(childUpdate.sql, childUpdate.params);

    if (!baseUpdate && !childUpdate) return existing;
    return getByIdFn(id);
  } catch (err) {
    if (!isMissingInheritanceRelationError(err)) throw err;
    _hasPortfolioTransactionInheritanceSchema = false;
    throw err;
  }
}

export const portfolioTransactionRepository = {
  async getAll({ investmentId = null, type = null, limit = 200, offset = 0 } = {}) {
    let sql = `SELECT * FROM portfolio_transactions WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (investmentId) { sql += ` AND investment_id = $${idx++}`; params.push(investmentId); }
    if (type) { sql += ` AND type = $${idx++}`; params.push(type); }

    sql += ` ORDER BY date DESC, id DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows;
  },

  async getCount({ investmentId = null, type = null } = {}) {
    let sql = `SELECT count(*) FROM portfolio_transactions WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (investmentId) { sql += ` AND investment_id = $${idx++}`; params.push(investmentId); }
    if (type) { sql += ` AND type = $${idx++}`; params.push(type); }

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id) {
    const result = await query('SELECT * FROM portfolio_transactions WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async create({ investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency = 'EUR', note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur }) {
    const investmentResult = await query('SELECT asset_class FROM investments WHERE id = $1', [investment_id]);
    const assetClass = investmentResult.rows[0]?.asset_class;

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
        return await createThroughInheritanceTables(payload, this.getById.bind(this), assetClass);
      } catch (err) {
        if (!isMissingInheritanceRelationError(err)) throw err;
      }
    }

    try {
      const result = await query(
        `INSERT INTO portfolio_transactions
         (investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
        ]
      );
      return result.rows[0];
    } catch (err) {
      if (!isNonUpdatablePortfolioTransactionsViewError(err)) throw err;
      _hasPortfolioTransactionInheritanceSchema = true;
      return createThroughInheritanceTables(payload, this.getById.bind(this), assetClass);
    }
  },

  async update(id, fields) {
    const allowed = ['date', 'amount', 'units', 'price_per_unit', 'fees', 'taxes', 'currency', 'note', 'is_recurring', 'recurrence_interval', 'recurrence_end_date', 'fx_rate_to_eur'];

    const existing = await this.getById(id);
    if (!existing) return null;

    if (Object.prototype.hasOwnProperty.call(fields, 'type') && fields.type !== existing.type) {
      throw makeValidationError('type cannot be changed');
    }

    const merged = {
      ...existing,
      ...fields,
    };
    const investmentResult = await query('SELECT asset_class FROM investments WHERE id = $1', [existing.investment_id]);
    const assetClass = investmentResult.rows[0]?.asset_class;
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
      return updateThroughInheritanceTables(id, normalizedFields, this.getById.bind(this));
    }

    normalizedParams.push(id);
    const sql = `UPDATE portfolio_transactions SET ${normalizedSetClauses.join(', ')} WHERE id = $${normalizedIdx} RETURNING *`;
    try {
      const result = await query(sql, normalizedParams);
      return result.rows[0] || null;
    } catch (err) {
      if (!isNonUpdatablePortfolioTransactionsViewError(err)) throw err;
      _hasPortfolioTransactionInheritanceSchema = true;
      return updateThroughInheritanceTables(id, normalizedFields, this.getById.bind(this));
    }
  },

  async hardDelete(id) {
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
      _hasPortfolioTransactionInheritanceSchema = true;
      return hardDeleteThroughInheritanceTables(id);
    }
  },

  /** Get summary stats for an investment */
  async getSummary(investmentId) {
    const result = await query(`
      SELECT
        type,
        SUM(amount) as total_amount,
        SUM(units) as total_units,
        SUM(fees) as total_fees,
        SUM(taxes) as total_taxes,
        COUNT(*) as count
      FROM portfolio_transactions
      WHERE investment_id = $1
      GROUP BY type
    `, [investmentId]);
    return result.rows;
  },
};

export default portfolioTransactionRepository;
