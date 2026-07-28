/**
 * Watchlist Repository - data access for watchlist (prospective investments) table.
 */

import { query } from '../database/connection.js';
import { coerceNumericFields } from '../lib/money.js';
import { buildSetClauses } from '../lib/sqlClauses.js';

// target_price is NUMERIC (node-postgres returns it as a string); coerce on
// emit so it matches the `number` API/TS type. current_price/price_change are
// added later by the route from the price provider, not read from this table.
const WATCHLIST_NUMERIC_FIELDS = ['target_price', 'added_price'];

/** @typedef {import('../types/rows.js').WatchlistRow} WatchlistRow */
/** @typedef {import('../types/rows.js').FormattedWatchlistRow} FormattedWatchlistRow */

/**
 * @param {any} row A raw {@link WatchlistRow}.
 * @returns {FormattedWatchlistRow}
 */
const mapWatchlistRow = (row) => coerceNumericFields(row, WATCHLIST_NUMERIC_FIELDS);

export const watchlistRepository = {
  /**
   * @param {{ assetClass?: string|null }} [filters]
   * @returns {{ where: string, params: any[], nextParam: number }}
   */
  buildWhereClause({ assetClass = null } = {}) {
    let where = 'WHERE 1=1';
    const params = [];
    let idx = 1;

    if (assetClass) {
      where += ` AND asset_class = $${idx++}`;
      params.push(assetClass);
    }

    return { where, params, nextParam: idx };
  },

  /**
   * @param {{ limit?: number, offset?: number, assetClass?: string|null }} [opts]
   * @returns {Promise<FormattedWatchlistRow[]>}
   */
  async getAll({ limit = 50, offset = 0, assetClass = null } = {}) {
    const { where, params, nextParam } = this.buildWhereClause({ assetClass });
    let sql = `SELECT * FROM watchlist ${where}`;
    let idx = nextParam;

    sql += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows.map(mapWatchlistRow);
  },

  /**
   * @param {{ limit?: number, offset?: number, assetClass?: string|null }} [opts]
   * @returns {Promise<{ rows: FormattedWatchlistRow[], total: number }>}
   */
  async getAllWithCount({ limit = 50, offset = 0, assetClass = null } = {}) {
    const { where, params, nextParam } = this.buildWhereClause({ assetClass });
    let idx = nextParam;
    const sql = `
      SELECT w.*, COUNT(*) OVER () AS total_count
      FROM watchlist w
      ${where.replace(/\basset_class\b/g, 'w.asset_class')}
      ORDER BY w.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const queryParams = [...params, limit, offset];
    const result = await query(sql, queryParams);
    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    const rows = result.rows.map(
      (/** @type {WatchlistRow & { total_count: string }} */ { total_count: _total_count, ...row }) =>
        mapWatchlistRow(row),
    );
    return { rows, total };
  },

  /**
   * @param {{ assetClass?: string|null }} [filters]
   * @returns {Promise<number>}
   */
  async getCount({ assetClass = null } = {}) {
    const { where, params } = this.buildWhereClause({ assetClass });
    const sql = `SELECT count(*) FROM watchlist ${where}`;

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * @param {number} id
   * @returns {Promise<FormattedWatchlistRow|null>}
   */
  async getById(id) {
    const result = await query('SELECT * FROM watchlist WHERE id = $1', [id]);
    return result.rows[0] ? mapWatchlistRow(result.rows[0]) : null;
  },

  /**
   * @param {{
   *   name: string,
   *   symbol?: string|null,
   *   asset_class: string,
   *   target_price: number|string,
   *   currency?: string,
   *   notes?: string|null,
   *   price_provider_id?: string|null,
   *   added_price?: number|string|null,
   * }} input
   * @returns {Promise<FormattedWatchlistRow>}
   */
  async create({ name, symbol, asset_class, target_price, currency = 'EUR', notes, price_provider_id, added_price }) {
    const result = await query(
      `INSERT INTO watchlist (name, symbol, asset_class, target_price, currency, notes, price_provider_id, added_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, symbol || null, asset_class, target_price, currency, notes || null, price_provider_id || null, added_price ?? null]
    );
    return mapWatchlistRow(result.rows[0]);
  },

  /**
   * @param {number} id
   * @param {Record<string, any>} fields Patch; only `allowed` keys are applied.
   * @returns {Promise<FormattedWatchlistRow|null>}
   */
  async update(id, fields) {
    const allowed = ['name', 'symbol', 'asset_class', 'target_price', 'currency', 'notes', 'price_provider_id'];
    const { clauses: setClauses, params, nextIdx: idx } = buildSetClauses(fields, { allowed });

    if (setClauses.length === 0) return this.getById(id);

    params.push(id);
    const sql = `UPDATE watchlist SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] ? mapWatchlistRow(result.rows[0]) : null;
  },

  /**
   * @param {number} id
   * @returns {Promise<boolean>} true if a row was removed
   */
  async delete(id) {
    const result = await query('DELETE FROM watchlist WHERE id = $1', [id]);
    return result.rowCount > 0;
  },
};

export default watchlistRepository;
