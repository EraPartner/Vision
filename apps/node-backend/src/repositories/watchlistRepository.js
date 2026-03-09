/**
 * Watchlist Repository - data access for watchlist (prospective investments) table.
 */

import { query } from '../database/connection.js';

export const watchlistRepository = {
  async getAll({ limit = 50, offset = 0, assetClass = null } = {}) {
    let sql = `SELECT * FROM watchlist WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (assetClass) {
      sql += ` AND asset_class = $${idx++}`;
      params.push(assetClass);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows;
  },

  async getCount({ assetClass = null } = {}) {
    let sql = `SELECT count(*) FROM watchlist WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (assetClass) { sql += ` AND asset_class = $${idx++}`; params.push(assetClass); }

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id) {
    const result = await query('SELECT * FROM watchlist WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async create({ name, symbol, asset_class, target_price, currency = 'EUR', notes, price_provider_id }) {
    const result = await query(
      `INSERT INTO watchlist (name, symbol, asset_class, target_price, currency, notes, price_provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, symbol || null, asset_class, target_price, currency, notes || null, price_provider_id || null]
    );
    return result.rows[0];
  },

  async update(id, fields) {
    const allowed = ['name', 'symbol', 'asset_class', 'target_price', 'currency', 'notes', 'price_provider_id'];
    const setClauses = [];
    const params = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (allowed.includes(key) && value !== undefined) {
        setClauses.push(`${key} = $${idx++}`);
        params.push(value);
      }
    }

    if (setClauses.length === 0) return this.getById(id);

    params.push(id);
    const sql = `UPDATE watchlist SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] || null;
  },

  async delete(id) {
    const result = await query('DELETE FROM watchlist WHERE id = $1', [id]);
    return result.rowCount > 0;
  },
};

export default watchlistRepository;
