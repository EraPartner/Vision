/**
 * Investment Repository - data access for investments table.
 *
 * `investments` is a plain flat table on every install: fresh installs get it from the
 * 0001 baseline and legacy table-inheritance installs are converted by migration 0087
 * (ADR-109) before the backend starts listening, so no schema-shape probing is needed.
 */

import { query } from "../database/connection.js";
import { VALID_ASSET_CLASSES } from "../lib/assetClasses.js";
import { toWireDate } from "../lib/dateFormat.js";
import { coerceNumericFields } from "../lib/money.js";
import { makeValidationError } from "../lib/repositoryErrors.js";
import { buildSetClauses } from "../lib/sqlClauses.js";

/** @typedef {import('../types/rows.js').InvestmentRow} InvestmentRow */

/**
 * The caller-facing create payload — one key per column in
 * INVESTMENT_INSERT_FIELDS. Every field except `name` / `asset_class` is
 * optional and falls back to a per-column default.
 *
 * @typedef {object} InvestmentCreateFields
 * @property {string} name
 * @property {string} asset_class
 * @property {string|null} [symbol]
 * @property {string} [currency]
 * @property {number|string|null} [current_price]
 * @property {number|string|null} [interest_rate]
 * @property {string|null} [maturity_date] 'YYYY-MM-DD'
 * @property {string|null} [location]
 * @property {string|null} [municipality]
 * @property {number|string|null} [cadastral_income]
 * @property {number|string|null} [municipality_tax_rate]
 * @property {string|null} [notes]
 * @property {string|null} [price_provider]
 * @property {string|null} [price_provider_id]
 * @property {string|null} [price_provider_url]
 * @property {string|null} [price_provider_latest_url]
 * @property {string|null} [price_provider_latest_path]
 * @property {string|null} [price_provider_history_url]
 * @property {string|null} [price_provider_history_path]
 * @property {string|null} [price_provider_history_ts_path]
 * @property {string|null} [price_provider_history_price_path]
 */

// NUMERIC columns node-postgres returns as strings; coerce to numbers on emit
// so rows match the `number` API/TS types.
const INVESTMENT_NUMERIC_FIELDS = [
  "current_price",
  "interest_rate",
  "cadastral_income",
  "municipality_tax_rate",
];
/**
 * Coerce an `investments` row to its emitted shape: the four NUMERIC columns
 * become numbers and the DATE `maturity_date` a calendar-day string.
 *
 * @param {any} row
 * @returns {InvestmentRow}
 */
const mapInvestmentRow = (row) => {
  const mapped = coerceNumericFields(row, INVESTMENT_NUMERIC_FIELDS);
  // DATE column: calendar-day string, not a raw pg Date (previous-day ISO
  // timestamp east of UTC once JSON-serialized).
  if (mapped && mapped.maturity_date instanceof Date)
    mapped.maturity_date = toWireDate(mapped.maturity_date);
  return mapped;
};

// Single source of truth for the investment INSERT column list and the
// coalescing defaults each column applies. Order is load-bearing — it drives
// placeholder numbering.
/** @type {Array<{ column: string, value: (f: any) => any }>} */
const INVESTMENT_INSERT_FIELDS = [
  { column: "name", value: (f) => f.name },
  { column: "symbol", value: (f) => f.symbol || null },
  { column: "asset_class", value: (f) => f.asset_class },
  { column: "currency", value: (f) => f.currency },
  { column: "current_price", value: (f) => f.current_price || null },
  { column: "interest_rate", value: (f) => f.interest_rate || null },
  { column: "maturity_date", value: (f) => f.maturity_date || null },
  { column: "location", value: (f) => f.location || null },
  { column: "municipality", value: (f) => f.municipality || null },
  { column: "cadastral_income", value: (f) => f.cadastral_income ?? null },
  {
    column: "municipality_tax_rate",
    value: (f) => f.municipality_tax_rate ?? null,
  },
  { column: "notes", value: (f) => f.notes || null },
  { column: "price_provider", value: (f) => f.price_provider || "manual" },
  { column: "price_provider_id", value: (f) => f.price_provider_id || null },
  { column: "price_provider_url", value: (f) => f.price_provider_url || null },
  {
    column: "price_provider_latest_url",
    value: (f) => f.price_provider_latest_url || null,
  },
  {
    column: "price_provider_latest_path",
    value: (f) => f.price_provider_latest_path || null,
  },
  {
    column: "price_provider_history_url",
    value: (f) => f.price_provider_history_url || null,
  },
  {
    column: "price_provider_history_path",
    value: (f) => f.price_provider_history_path || null,
  },
  {
    column: "price_provider_history_ts_path",
    value: (f) => f.price_provider_history_ts_path || null,
  },
  {
    column: "price_provider_history_price_path",
    value: (f) => f.price_provider_history_price_path || null,
  },
];

/** Column names for a create() payload — the caller-facing field set. */
const INVESTMENT_CREATE_COLUMNS = INVESTMENT_INSERT_FIELDS.map((f) => f.column);

// Widened to Set<string>: create() probes a raw payload value with .has()
// (same idiom as UNIT_BASED_ASSET_CLASSES in portfolioTransactionRules.js).
/** @type {Set<string>} */
const SUPPORTED_ASSET_CLASSES = new Set(VALID_ASSET_CLASSES);

/**
 * @param {number} count
 * @returns {string}
 */
function investmentPlaceholders(count) {
  return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(", ");
}

/**
 * Pick the investment create field set out of a request body, preserving the
 * exact key set create() expects (each key present, undefined when absent so
 * create()'s per-field defaults still apply). Lets the controller stop
 * re-destructuring the same ~21 fields by hand.
 *
 * @param {Record<string, unknown>} body
 * @returns {any}
 */
export function pickInvestmentCreateFields(body) {
  /** @type {Record<string, unknown>} */
  const picked = {};
  for (const column of INVESTMENT_CREATE_COLUMNS)
    picked[column] = body?.[column];
  return picked;
}

/**
 * @param {any} value
 * @returns {any} the trimmed/upper-cased string, or `value` unchanged when not a string
 */
function normalizeSymbol(value) {
  if (typeof value !== "string") return value;
  return value.trim().toUpperCase();
}

/**
 * @param {string} symbol
 * @param {number} excludeId
 * @returns {Promise<void>}
 */
async function ensureSymbolIsUnique(symbol, excludeId) {
  const result = await query(
    "SELECT id FROM investments WHERE LOWER(symbol) = LOWER($1) AND id <> $2 LIMIT 1",
    [symbol, excludeId],
  );

  if (result.rows[0]) {
    throw makeValidationError("symbol must be unique");
  }
}

// Per-investment ticker visibility lives in a side table (migration 0061).
// Reads LEFT JOIN it (absent row = visible); the toggle UPSERTs it via
// update() below.
const TICKER_PREF_SELECT =
  "COALESCE(tp.show_in_ticker, true) AS show_in_ticker";
const TICKER_PREF_JOIN =
  "LEFT JOIN investment_ticker_prefs tp ON tp.investment_id = i.id";

/**
 * @param {number} id
 * @param {boolean} show
 * @returns {Promise<void>}
 */
async function setTickerPreference(id, show) {
  await query(
    `INSERT INTO investment_ticker_prefs (investment_id, show_in_ticker)
       VALUES ($1, $2)
       ON CONFLICT (investment_id) DO UPDATE SET show_in_ticker = EXCLUDED.show_in_ticker`,
    [id, show],
  );
}

export const investmentRepository = {
  /**
   * @param {{ limit?: number, offset?: number, assetClass?: string|null, active?: boolean }} [filters]
   * @returns {Promise<InvestmentRow[]>}
   */
  async getAll({
    limit = 50,
    offset = 0,
    assetClass = null,
    active = true,
  } = {}) {
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

  /**
   * @param {{ assetClass?: string|null, active?: boolean }} [filters]
   * @returns {Promise<number>}
   */
  async getCount({ assetClass = null, active = true } = {}) {
    let sql = `SELECT count(*) FROM investments WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (active) sql += ` AND is_active = true`;
    if (assetClass) {
      sql += ` AND asset_class = $${idx}`;
      params.push(assetClass);
    }

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * @param {{ limit?: number, offset?: number, assetClass?: string|null, active?: boolean }} [filters]
   * @returns {Promise<{ rows: InvestmentRow[], total: number }>}
   */
  async getAllWithCount({
    limit = 50,
    offset = 0,
    assetClass = null,
    active = true,
  } = {}) {
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
    const total =
      result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    const rows = result.rows.map(
      (/** @type {any} */ { total_count: _total_count, ...row }) =>
        mapInvestmentRow(row),
    );
    return { rows, total };
  },

  /**
   * @param {number} id
   * @returns {Promise<InvestmentRow|null>}
   */
  async getById(id) {
    const result = await query(
      `SELECT i.*, ${TICKER_PREF_SELECT} FROM investments i ${TICKER_PREF_JOIN} WHERE i.id = $1`,
      [id],
    );
    return result.rows[0] ? mapInvestmentRow(result.rows[0]) : null;
  },

  /**
   * @param {InvestmentCreateFields} fields
   * @returns {Promise<InvestmentRow|null>}
   */
  async create({
    name,
    symbol,
    asset_class,
    currency = "EUR",
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
  }) {
    // Apply the same input hygiene as update(): reject an empty name (the
    // backend previously accepted '' silently) and normalise the symbol
    // (trim/uppercase) so a lower-case symbol can't slip in only via create.
    const trimmedName = typeof name === "string" ? name.trim() : name;
    if (!trimmedName) {
      throw makeValidationError("name is required");
    }
    name = trimmedName;
    // Same 400 the legacy inheritance path raised — without this, an unknown
    // asset_class only fails at the DB enum cast (a raw 500).
    if (!SUPPORTED_ASSET_CLASSES.has(asset_class)) {
      throw makeValidationError(`Unsupported asset_class: ${asset_class}`);
    }
    symbol = normalizeSymbol(symbol);
    // Same uniqueness rule as update() (there is no DB unique index on symbol,
    // so create was the one path that could still insert a duplicate — e.g. a
    // duplicate-on-retry). excludeId 0 matches no row: ids start at 1.
    if (typeof symbol === "string" && symbol !== "") {
      await ensureSymbolIsUnique(symbol, 0);
    }
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

    const columns = INVESTMENT_CREATE_COLUMNS.join(", ");
    const placeholders = investmentPlaceholders(
      INVESTMENT_INSERT_FIELDS.length,
    );
    const values = INVESTMENT_INSERT_FIELDS.map((f) => f.value(payload));

    const result = await query(
      `INSERT INTO investments (${columns})
       VALUES (${placeholders}) RETURNING *`,
      values,
    );
    return mapInvestmentRow(result.rows[0]);
  },

  /**
   * @param {number} id
   * @param {Record<string, any> & { show_in_ticker?: boolean }} fields
   * @returns {Promise<InvestmentRow|null>}
   */
  async update(id, fields) {
    const allowed = [
      "name",
      "symbol",
      "currency",
      "current_price",
      "interest_rate",
      "maturity_date",
      "location",
      "municipality",
      "cadastral_income",
      "municipality_tax_rate",
      "notes",
      "is_active",
      "price_provider",
      "price_provider_id",
      "price_provider_url",
      "price_provider_latest_url",
      "price_provider_latest_path",
      "price_provider_history_url",
      "price_provider_history_path",
      "price_provider_history_ts_path",
      "price_provider_history_price_path",
      "price_updated_at",
    ];
    const existing = await this.getById(id);
    if (!existing) return null;

    if (
      Object.prototype.hasOwnProperty.call(fields, "asset_class") &&
      fields.asset_class !== existing.asset_class
    ) {
      throw makeValidationError("asset_class cannot be changed");
    }

    // show_in_ticker is not an investments column — it's a side-table preference
    // (migration 0061). Peel it off; UPSERT it after the field validations below
    // so an invalid symbol can't leave a stray preference behind.
    const { show_in_ticker: showInTicker, ...rest } = fields;

    const normalizedFields = { ...rest };
    if (Object.prototype.hasOwnProperty.call(normalizedFields, "symbol")) {
      const symbol = normalizeSymbol(normalizedFields.symbol);
      if (!symbol) {
        throw makeValidationError("symbol is required");
      }
      await ensureSymbolIsUnique(symbol, id);
      normalizedFields.symbol = symbol;
    }

    if (showInTicker !== undefined) {
      await setTickerPreference(id, showInTicker);
    }

    const {
      clauses: setClauses,
      params,
      nextIdx: idx,
    } = buildSetClauses(normalizedFields, { allowed });

    // Nothing else changed — re-read only if the ticker pref moved (to reflect it).
    if (setClauses.length === 0) {
      return showInTicker !== undefined ? this.getById(id) : existing;
    }

    params.push(id);
    const sql = `UPDATE investments SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`;
    const result = await query(sql, params);
    if (!result.rows[0]) return null;
    // Re-read when the ticker pref changed so the joined value is in the response.
    return showInTicker !== undefined
      ? this.getById(id)
      : mapInvestmentRow(result.rows[0]);
  },

  /**
   * @param {number} id
   * @param {{ current_price: number|string|null, price_updated_at: string|Date|null }} fields
   * @returns {Promise<InvestmentRow|null>}
   */
  async updatePrice(id, { current_price, price_updated_at }) {
    const result = await query(
      `UPDATE investments
          SET current_price = $1, price_updated_at = $2
        WHERE id = $3
      RETURNING *`,
      [current_price, price_updated_at, id],
    );
    return result.rows[0] ? mapInvestmentRow(result.rows[0]) : null;
  },

  /**
   * Batch variant of updatePrice: one UNNEST-driven UPDATE for the whole
   * refresh instead of N sequential round trips (same pattern as
   * priceCache.saveHistoricalPointsToDatabase).
   *
   * @param {Array<{id: number, current_price: number, price_updated_at: string}>} updates
   * @returns {Promise<number>} number of rows updated
   */
  async updatePricesBulk(updates) {
    if (!Array.isArray(updates) || updates.length === 0) return 0;

    const result = await query(
      `UPDATE investments i
          SET current_price = u.current_price,
              price_updated_at = u.price_updated_at
         FROM UNNEST($1::int[], $2::numeric[], $3::timestamptz[])
              AS u(id, current_price, price_updated_at)
        WHERE i.id = u.id`,
      [
        updates.map((u) => u.id),
        updates.map((u) => u.current_price),
        updates.map((u) => u.price_updated_at),
      ],
    );
    return result.rowCount ?? 0;
  },

  /** @returns {Promise<Date|null>} TIMESTAMPTZ — a `Date`, not a string. */
  async getLatestPriceUpdatedAt() {
    const result = await query(
      `SELECT MAX(price_updated_at) AS latest
         FROM investments
        WHERE is_active = true
          AND price_provider IS NOT NULL
          AND price_provider <> 'manual'`,
    );
    return result.rows[0]?.latest ?? null;
  },

  /**
   * @param {number} id
   * @returns {Promise<boolean>}
   */
  async hardDelete(id) {
    const result = await query("DELETE FROM investments WHERE id = $1", [id]);
    return result.rowCount > 0;
  },
};

export default investmentRepository;
