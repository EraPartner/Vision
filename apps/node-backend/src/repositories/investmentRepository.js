/**
 * Investment Repository - data access for investments table.
 */

import { query, withTransaction } from '../database/connection.js';
import { toWireDate } from '../lib/dateFormat.js';
import { coerceNumericFields } from '../lib/money.js';

// NUMERIC columns node-postgres returns as strings; coerce to numbers on emit
// so rows match the `number` API/TS types (the inheritance create/update paths
// all return through getById, so coercing the methods below covers them too).
const INVESTMENT_NUMERIC_FIELDS = ['current_price', 'interest_rate', 'cadastral_income', 'municipality_tax_rate'];
const mapInvestmentRow = (row) => {
  const mapped = coerceNumericFields(row, INVESTMENT_NUMERIC_FIELDS);
  // DATE column: calendar-day string, not a raw pg Date (previous-day ISO
  // timestamp east of UTC once JSON-serialized).
  if (mapped && mapped.maturity_date instanceof Date) mapped.maturity_date = toWireDate(mapped.maturity_date);
  return mapped;
};

let _hasInvestmentInheritanceSchema;
let _hasMetalsInheritanceTable;

async function hasInvestmentInheritanceSchema() {
  if (_hasInvestmentInheritanceSchema !== undefined) return _hasInvestmentInheritanceSchema;

  const result = await query("SELECT to_regclass('public.investments_base') AS investments_base");
  _hasInvestmentInheritanceSchema = Boolean(result.rows[0]?.investments_base);
  return _hasInvestmentInheritanceSchema;
}

export function __resetInvestmentSchemaCache() {
  _hasInvestmentInheritanceSchema = undefined;
  _hasMetalsInheritanceTable = undefined;
}

async function hasMetalsInheritanceTable() {
  if (_hasMetalsInheritanceTable !== undefined) return _hasMetalsInheritanceTable;
  const result = await query("SELECT to_regclass('public.metals_investments') AS metals_investments");
  _hasMetalsInheritanceTable = Boolean(result.rows[0]?.metals_investments);
  return _hasMetalsInheritanceTable;
}

function isNonUpdatableInvestmentsViewError(err) {
  const msg = err?.message || '';
  return msg.includes('cannot update view "investments"')
    || msg.includes("cannot insert into view \"investments\"")
    || msg.includes("cannot delete from view \"investments\"");
}

function isUndefinedColumnError(err, columnName) {
  if (err?.code !== '42703') return false;
  const msg = err?.message || '';
  if (!columnName) return msg.includes('column');
  return msg.includes(`column "${columnName}"`);
}

function isMissingInheritanceRelationError(err) {
  if (err?.code === '42P01') return true;
  const msg = err?.message || '';
  return msg.includes('relation "investments_base" does not exist')
    || msg.includes('relation "stock_investments" does not exist')
    || msg.includes('relation "etf_investments" does not exist')
    || msg.includes('relation "crypto_investments" does not exist')
    || msg.includes('relation "real_estate_investments" does not exist')
    || msg.includes('relation "savings_investments" does not exist')
    || msg.includes('relation "bond_investments" does not exist')
    || msg.includes('relation "metals_investments" does not exist');
}

function isDuplicateInvestmentIdError(err, childTable) {
  if (err?.code !== '23505') return false;
  const msg = err?.message || '';
  const detail = err?.detail || '';
  const constraint = err?.constraint || '';
  return (constraint === `${childTable}_pkey` || msg.includes(`${childTable}_pkey`))
    && (detail.includes('Key (id)=') || msg.includes('Key (id)='));
}

async function resyncInvestmentsBaseIdSequence() {
  await query(
    "SELECT setval(pg_get_serial_sequence('investments_base', 'id'), COALESCE((SELECT MAX(id) FROM investments_base), 0) + 1, false)"
  );
}

const INHERITED_TABLE_BY_ASSET_CLASS = {
  stock: 'stock_investments',
  etf: 'etf_investments',
  crypto: 'crypto_investments',
  metals: 'metals_investments',
  real_estate: 'real_estate_investments',
  savings: 'savings_investments',
  bond: 'bond_investments',
};

async function resolveChildTable(assetClass) {
  if (assetClass !== 'metals') return INHERITED_TABLE_BY_ASSET_CLASS[assetClass];
  const hasMetalsTable = await hasMetalsInheritanceTable();
  return hasMetalsTable ? 'metals_investments' : 'stock_investments';
}

const BASE_ALLOWED_FIELDS = [
  'name',
  'currency',
  'notes',
  'is_active',
  'price_provider',
  'price_provider_id',
  'price_provider_url',
  'price_provider_latest_url',
  'price_provider_latest_path',
  'price_provider_history_url',
  'price_provider_history_path',
  'price_provider_history_ts_path',
  'price_provider_history_price_path',
  'price_updated_at',
];

const CHILD_ALLOWED_FIELDS_BY_ASSET_CLASS = {
  stock: ['symbol', 'current_price'],
  etf: ['symbol', 'current_price'],
  crypto: ['symbol', 'current_price'],
  metals: ['symbol', 'current_price'],
  real_estate: ['current_price', 'location', 'municipality', 'cadastral_income', 'municipality_tax_rate'],
  savings: ['current_price', 'interest_rate'],
  bond: ['current_price', 'interest_rate', 'maturity_date'],
};

function makeValidationError(message) {
  const err = /** @type {Error & { code?: string }} */ (new Error(message));
  err.code = 'VALIDATION_ERROR';
  return err;
}

function normalizeSymbol(value) {
  if (typeof value !== 'string') return value;
  return value.trim().toUpperCase();
}

async function ensureSymbolIsUnique(symbol, excludeId) {
  const result = await query(
    'SELECT id FROM investments WHERE LOWER(symbol) = LOWER($1) AND id <> $2 LIMIT 1',
    [symbol, excludeId]
  );

  if (result.rows[0]) {
    throw makeValidationError('symbol must be unique');
  }
}

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

async function updateThroughInheritanceTables(id, fields, getByIdFn) {
  try {
    const existing = await getByIdFn(id);
    if (!existing) return null;

    const assetClass = existing.asset_class;
    const childTable = await resolveChildTable(assetClass);
    const childAllowed = CHILD_ALLOWED_FIELDS_BY_ASSET_CLASS[assetClass] || [];

    if (!childTable) return existing;

    const baseUpdate = buildUpdateSql('investments_base', id, fields, BASE_ALLOWED_FIELDS);
    const childUpdate = buildUpdateSql(childTable, id, fields, childAllowed);

    if (!baseUpdate && !childUpdate) return existing;

    await withTransaction(async (client) => {
      if (baseUpdate) await client.query(baseUpdate.sql, baseUpdate.params);
      if (childUpdate) await client.query(childUpdate.sql, childUpdate.params);
    });
    return getByIdFn(id);
  } catch (err) {
    if (!isMissingInheritanceRelationError(err)) throw err;
    _hasInvestmentInheritanceSchema = false;
    throw err;
  }
}

async function createThroughInheritanceTables(fields, getByIdFn) {
  const {
    name,
    symbol,
    asset_class,
    currency = 'EUR',
    current_price,
    interest_rate,
    maturity_date,
    location,
    municipality,
    cadastral_income,
    municipality_tax_rate,
    notes,
    price_provider,
    price_provider_id,
    price_provider_url,
    price_provider_latest_url,
    price_provider_latest_path,
    price_provider_history_url,
    price_provider_history_path,
    price_provider_history_ts_path,
    price_provider_history_price_path,
  } = fields;

  const childTable = await resolveChildTable(asset_class);
  if (!childTable) {
    throw new Error(`Unsupported asset_class: ${asset_class}`);
  }

  const baseColumns = [
    'name',
    'currency',
    'notes',
    'price_provider',
    'price_provider_id',
    'price_provider_url',
    'price_provider_latest_url',
    'price_provider_latest_path',
    'price_provider_history_url',
    'price_provider_history_path',
    'price_provider_history_ts_path',
    'price_provider_history_price_path',
  ];
  const baseValues = [
    name,
    currency,
    notes || null,
    price_provider || 'manual',
    price_provider_id || null,
    price_provider_url || null,
    price_provider_latest_url || null,
    price_provider_latest_path || null,
    price_provider_history_url || null,
    price_provider_history_path || null,
    price_provider_history_ts_path || null,
    price_provider_history_price_path || null,
  ];

  const childColumns = [];
  const childValues = [];

  if (asset_class === 'stock' || asset_class === 'etf' || asset_class === 'crypto' || asset_class === 'metals') {
    childColumns.push('symbol', 'current_price');
    childValues.push(symbol || null, current_price || null);
  } else if (asset_class === 'real_estate') {
    childColumns.push('current_price', 'location', 'municipality', 'cadastral_income', 'municipality_tax_rate');
    childValues.push(current_price || null, location || null, municipality || null, cadastral_income ?? null, municipality_tax_rate ?? null);
  } else if (asset_class === 'savings') {
    childColumns.push('current_price', 'interest_rate');
    childValues.push(current_price || null, interest_rate || null);
  } else if (asset_class === 'bond') {
    childColumns.push('current_price', 'interest_rate', 'maturity_date');
    childValues.push(current_price || null, interest_rate || null, maturity_date || null);
  }

  const columns = [...baseColumns, ...childColumns];
  const values = [...baseValues, ...childValues];
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT INTO ${childTable} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`;

  const legacyProviderUrl = price_provider_url || price_provider_latest_url || null;
  const legacyProviderId = price_provider_id || price_provider_latest_path || null;
  const legacyBaseColumns = [
    'name',
    'currency',
    'notes',
    'price_provider',
    'price_provider_id',
    'price_provider_url',
  ];
  const legacyBaseValues = [
    name,
    currency,
    notes || null,
    price_provider || 'manual',
    legacyProviderId,
    legacyProviderUrl,
  ];
  const legacyColumns = [...legacyBaseColumns, ...childColumns];
  const legacyValues = [...legacyBaseValues, ...childValues];
  const legacyPlaceholders = legacyValues.map((_, i) => `$${i + 1}`).join(', ');
  const legacyInsertSql = `INSERT INTO ${childTable} (${legacyColumns.join(', ')}) VALUES (${legacyPlaceholders}) RETURNING id`;

  try {
    const insertWithColumnFallback = async () => {
      try {
        return await query(insertSql, values);
      } catch (err) {
        if (!isUndefinedColumnError(err, 'price_provider_latest_url')) throw err;
        return query(legacyInsertSql, legacyValues);
      }
    };

    let insertResult;
    try {
      insertResult = await insertWithColumnFallback();
    } catch (err) {
      if (!isDuplicateInvestmentIdError(err, childTable)) throw err;
      await resyncInvestmentsBaseIdSequence();
      insertResult = await insertWithColumnFallback();
    }

    const id = insertResult.rows[0]?.id;
    if (!id) return null;
    return getByIdFn(id);
  } catch (err) {
    if (!isMissingInheritanceRelationError(err)) throw err;
    _hasInvestmentInheritanceSchema = false;
    throw err;
  }
}

async function hardDeleteThroughInheritanceTables(id) {
  try {
    const result = await query('DELETE FROM investments_base WHERE id = $1', [id]);
    return result.rowCount > 0;
  } catch (err) {
    if (!isMissingInheritanceRelationError(err)) throw err;
    _hasInvestmentInheritanceSchema = false;
    throw err;
  }
}

// Per-investment ticker visibility lives in a side table (migration 0061) so the
// preference works whether `investments` is a plain table or the legacy
// inheritance VIEW — neither of which we have to alter. Reads LEFT JOIN it
// (absent row = visible); the toggle UPSERTs it via update() below.
const TICKER_PREF_SELECT = 'COALESCE(tp.show_in_ticker, true) AS show_in_ticker';
const TICKER_PREF_JOIN = 'LEFT JOIN investment_ticker_prefs tp ON tp.investment_id = i.id';

async function setTickerPreference(id, show) {
  await query(
    `INSERT INTO investment_ticker_prefs (investment_id, show_in_ticker)
       VALUES ($1, $2)
       ON CONFLICT (investment_id) DO UPDATE SET show_in_ticker = EXCLUDED.show_in_ticker`,
    [id, show]
  );
}

export const investmentRepository = {
  async getAll({ limit = 50, offset = 0, assetClass = null, active = true } = {}) {
    let sql = `SELECT i.*, ${TICKER_PREF_SELECT} FROM investments i ${TICKER_PREF_JOIN} WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (active) sql += ` AND i.is_active = true`;
    if (assetClass) {
      sql += ` AND i.asset_class = $${idx++}`;
      params.push(assetClass);
    }

    sql += ` ORDER BY i.name LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows.map(mapInvestmentRow);
  },

  async getCount({ assetClass = null, active = true } = {}) {
    let sql = `SELECT count(*) FROM investments WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (active) sql += ` AND is_active = true`;
    if (assetClass) { sql += ` AND asset_class = $${idx}`; params.push(assetClass); }

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getAllWithCount({ limit = 50, offset = 0, assetClass = null, active = true } = {}) {
    let sql = `
      SELECT i.*, ${TICKER_PREF_SELECT}, COUNT(*) OVER () AS total_count
      FROM investments i
      ${TICKER_PREF_JOIN}
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (active) sql += ` AND i.is_active = true`;
    if (assetClass) {
      sql += ` AND i.asset_class = $${idx++}`;
      params.push(assetClass);
    }

    sql += ` ORDER BY i.name LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    const rows = result.rows.map(({ total_count: _total_count, ...row }) => mapInvestmentRow(row));
    return { rows, total };
  },

  async getById(id) {
    const result = await query(
      `SELECT i.*, ${TICKER_PREF_SELECT} FROM investments i ${TICKER_PREF_JOIN} WHERE i.id = $1`,
      [id]
    );
    return result.rows[0] ? mapInvestmentRow(result.rows[0]) : null;
  },

  async create({ name, symbol, asset_class, currency = 'EUR', current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path }) {
    const payload = {
      name,
      symbol,
      asset_class,
      currency,
      current_price,
      interest_rate,
      maturity_date,
      location,
      municipality,
      cadastral_income,
      municipality_tax_rate,
      notes,
      price_provider,
      price_provider_id,
      price_provider_url,
      price_provider_latest_url,
      price_provider_latest_path,
      price_provider_history_url,
      price_provider_history_path,
      price_provider_history_ts_path,
      price_provider_history_price_path,
    };

    if (await hasInvestmentInheritanceSchema()) {
      try {
        return await createThroughInheritanceTables(payload, this.getById.bind(this));
      } catch (err) {
        if (!isMissingInheritanceRelationError(err)) throw err;
      }
    }

    const modernValues = [
      name,
      symbol || null,
      asset_class,
      currency,
      current_price || null,
      interest_rate || null,
      maturity_date || null,
      location || null,
      municipality || null,
      cadastral_income ?? null,
      municipality_tax_rate ?? null,
      notes || null,
      price_provider || 'manual',
      price_provider_id || null,
      price_provider_url || null,
      price_provider_latest_url || null,
      price_provider_latest_path || null,
      price_provider_history_url || null,
      price_provider_history_path || null,
      price_provider_history_ts_path || null,
      price_provider_history_price_path || null,
    ];

    try {
      const result = await query(
        `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
        modernValues
      );
      return mapInvestmentRow(result.rows[0]);
    } catch (err) {
      if (isUndefinedColumnError(err, 'price_provider_latest_url')) {
        const legacyProviderUrl = price_provider_url || price_provider_latest_url || null;
        const legacyProviderId = price_provider_id || price_provider_latest_path || null;
        const legacyValues = [
          name,
          symbol || null,
          asset_class,
          currency,
          current_price || null,
          interest_rate || null,
          maturity_date || null,
          location || null,
          municipality || null,
          cadastral_income ?? null,
          municipality_tax_rate ?? null,
          notes || null,
          price_provider || 'manual',
          legacyProviderId,
          legacyProviderUrl,
        ];
        try {
          const legacyResult = await query(
            `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, price_provider, price_provider_id, price_provider_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
            legacyValues
          );
          return mapInvestmentRow(legacyResult.rows[0]);
        } catch (legacyErr) {
          if (!isNonUpdatableInvestmentsViewError(legacyErr)) throw legacyErr;
          _hasInvestmentInheritanceSchema = true;
          return createThroughInheritanceTables(payload, this.getById.bind(this));
        }
      }
      if (!isNonUpdatableInvestmentsViewError(err)) throw err;
      _hasInvestmentInheritanceSchema = true;
      return createThroughInheritanceTables(payload, this.getById.bind(this));
    }
  },

  async update(id, fields) {
    const allowed = ['name', 'symbol', 'currency', 'current_price', 'interest_rate', 'maturity_date', 'location', 'municipality', 'cadastral_income', 'municipality_tax_rate', 'notes', 'is_active', 'price_provider', 'price_provider_id', 'price_provider_url', 'price_provider_latest_url', 'price_provider_latest_path', 'price_provider_history_url', 'price_provider_history_path', 'price_provider_history_ts_path', 'price_provider_history_price_path', 'price_updated_at'];
    const existing = await this.getById(id);
    if (!existing) return null;

    if (Object.prototype.hasOwnProperty.call(fields, 'asset_class') && fields.asset_class !== existing.asset_class) {
      throw makeValidationError('asset_class cannot be changed');
    }

    // show_in_ticker is not an investments column — it's a side-table preference
    // (migration 0061). Peel it off; UPSERT it after the field validations below
    // so an invalid symbol can't leave a stray preference behind.
    const { show_in_ticker: showInTicker, ...rest } = fields;

    const normalizedFields = { ...rest };
    if (Object.prototype.hasOwnProperty.call(normalizedFields, 'symbol')) {
      const symbol = normalizeSymbol(normalizedFields.symbol);
      if (!symbol) {
        throw makeValidationError('symbol is required');
      }
      await ensureSymbolIsUnique(symbol, id);
      normalizedFields.symbol = symbol;
    }

    if (showInTicker !== undefined) {
      await setTickerPreference(id, showInTicker);
    }

    const setClauses = [];
    const params = [];
    let idx = 1;

    for (const [key, value] of Object.entries(normalizedFields)) {
      if (allowed.includes(key) && value !== undefined) {
        setClauses.push(`${key} = $${idx++}`);
        params.push(value);
      }
    }

    // Nothing else changed — re-read only if the ticker pref moved (to reflect it).
    if (setClauses.length === 0) {
      return showInTicker !== undefined ? this.getById(id) : existing;
    }

    if (await hasInvestmentInheritanceSchema()) {
      return updateThroughInheritanceTables(id, normalizedFields, this.getById.bind(this));
    }

    params.push(id);
    const sql = `UPDATE investments SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`;
    try {
      const result = await query(sql, params);
      if (!result.rows[0]) return null;
      // Re-read when the ticker pref changed so the joined value is in the response.
      return showInTicker !== undefined ? this.getById(id) : mapInvestmentRow(result.rows[0]);
    } catch (err) {
      if (!isNonUpdatableInvestmentsViewError(err)) throw err;
      _hasInvestmentInheritanceSchema = true;
      return updateThroughInheritanceTables(id, normalizedFields, this.getById.bind(this));
    }
  },

  async updatePrice(id, { current_price, price_updated_at }) {
    const fields = { current_price, price_updated_at };
    // Mirror update(): only go through the inheritance tables when that schema
    // is actually present. On a flat `investments` schema the inheritance path
    // throws, which previously broke the live-price scheduler entirely.
    if (await hasInvestmentInheritanceSchema()) {
      return updateThroughInheritanceTables(id, fields, this.getById.bind(this));
    }
    try {
      const result = await query(
        `UPDATE investments
            SET current_price = $1, price_updated_at = $2
          WHERE id = $3
        RETURNING *`,
        [current_price, price_updated_at, id]
      );
      return result.rows[0] ? mapInvestmentRow(result.rows[0]) : null;
    } catch (err) {
      if (!isNonUpdatableInvestmentsViewError(err)) throw err;
      _hasInvestmentInheritanceSchema = true;
      return updateThroughInheritanceTables(id, fields, this.getById.bind(this));
    }
  },

  async getLatestPriceUpdatedAt() {
    const result = await query(
      `SELECT MAX(price_updated_at) AS latest
         FROM investments
        WHERE is_active = true
          AND price_provider IS NOT NULL
          AND price_provider <> 'manual'`
    );
    return result.rows[0]?.latest ?? null;
  },

  async hardDelete(id) {
    if (await hasInvestmentInheritanceSchema()) {
      try {
        return await hardDeleteThroughInheritanceTables(id);
      } catch (err) {
        if (!isMissingInheritanceRelationError(err)) throw err;
      }
    }

    try {
      const result = await query('DELETE FROM investments WHERE id = $1', [id]);
      return result.rowCount > 0;
    } catch (err) {
      if (!isNonUpdatableInvestmentsViewError(err)) throw err;
      _hasInvestmentInheritanceSchema = true;
      return hardDeleteThroughInheritanceTables(id);
    }
  },
};

export default investmentRepository;
