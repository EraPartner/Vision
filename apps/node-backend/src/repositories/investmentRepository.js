/**
 * Investment Repository - data access for investments table.
 */

import { query } from '../database/connection.js';

export const investmentRepository = {
  async getAll({ limit = 50, offset = 0, assetClass = null, active = true } = {}) {
    let sql = `SELECT * FROM investments WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (active) sql += ` AND is_active = true`;
    if (assetClass) {
      sql += ` AND asset_class = $${idx++}`;
      params.push(assetClass);
    }

    sql += ` ORDER BY name LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows;
  },

  async getCount({ assetClass = null, active = true } = {}) {
    let sql = `SELECT count(*) FROM investments WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (active) sql += ` AND is_active = true`;
    if (assetClass) { sql += ` AND asset_class = $${idx++}`; params.push(assetClass); }

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id) {
    const result = await query('SELECT * FROM investments WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async create({ name, symbol, asset_class, currency = 'EUR', current_price, interest_rate, maturity_date, location, notes, price_provider, price_provider_id, price_provider_url }) {
    const result = await query(
      `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, notes, price_provider, price_provider_id, price_provider_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [name, symbol || null, asset_class, currency, current_price || null, interest_rate || null, maturity_date || null, location || null, notes || null,
       price_provider || 'manual', price_provider_id || null, price_provider_url || null]
    );
    return result.rows[0];
  },

  async update(id, fields) {
    const allowed = ['name', 'symbol', 'asset_class', 'currency', 'current_price', 'interest_rate', 'maturity_date', 'location', 'notes', 'is_active'];
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
    const sql = `UPDATE investments SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] || null;
  },

  async hardDelete(id) {
    const result = await query('DELETE FROM investments WHERE id = $1', [id]);
    return result.rowCount > 0;
  },
};

export default investmentRepository;
