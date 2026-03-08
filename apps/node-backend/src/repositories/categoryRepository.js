/**
 * Category Repository - data access for categories table.
 *
 * Mirrors: apps/backend/repositories/category_repository.py
 */

import { query } from '../database/connection.js';

export const categoryRepository = {
  async getAll({ limit = 50, offset = 0, general = null, detail = null, search = null, active = true } = {}) {
    let sql = `SELECT * FROM categories WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (active) {
      sql += ` AND is_active = true`;
    }
    if (general) {
      sql += ` AND general ILIKE $${paramIdx++}`;
      params.push(`%${general}%`);
    }
    if (detail) {
      sql += ` AND detail ILIKE $${paramIdx++}`;
      params.push(`%${detail}%`);
    }
    if (search) {
      const sp = `%${search}%`;
      sql += ` AND (general ILIKE $${paramIdx} OR detail ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`;
      paramIdx++;
      params.push(sp);
    }

    sql += ` ORDER BY general, detail LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows.map(enrichCategory);
  },

  async getCount({ general = null, detail = null, search = null, active = true } = {}) {
    let sql = `SELECT count(*) FROM categories WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (active) sql += ` AND is_active = true`;
    if (general) { sql += ` AND general ILIKE $${paramIdx++}`; params.push(`%${general}%`); }
    if (detail) { sql += ` AND detail ILIKE $${paramIdx++}`; params.push(`%${detail}%`); }
    if (search) {
      const sp = `%${search}%`;
      sql += ` AND (general ILIKE $${paramIdx} OR detail ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`;
      paramIdx++;
      params.push(sp);
    }

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id) {
    const result = await query('SELECT * FROM categories WHERE id = $1', [id]);
    return result.rows[0] ? enrichCategory(result.rows[0]) : null;
  },

  async getByGeneralDetail(general, detail) {
    const result = await query(
      'SELECT * FROM categories WHERE general = $1 AND detail = $2',
      [general.toUpperCase(), detail.toUpperCase()]
    );
    return result.rows[0] ? enrichCategory(result.rows[0]) : null;
  },

  async createOrGet({ general, detail, description = null }) {
    const g = general.toUpperCase().trim();
    const d = detail.toUpperCase().trim();

    // Try to find existing
    const existing = await this.getByGeneralDetail(g, d);
    if (existing) return { category: existing, created: false };

    const result = await query(
      `INSERT INTO categories (general, detail, description, is_active)
       VALUES ($1, $2, $3, true) RETURNING *`,
      [g, d, description]
    );
    return { category: enrichCategory(result.rows[0]), created: true };
  },

  async update(id, { general, detail, description, is_active }) {
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    if (general !== undefined && general !== null) { setClauses.push(`general = $${paramIdx++}`); params.push(general.toUpperCase().trim()); }
    if (detail !== undefined && detail !== null) { setClauses.push(`detail = $${paramIdx++}`); params.push(detail.toUpperCase().trim()); }
    if (description !== undefined) { setClauses.push(`description = $${paramIdx++}`); params.push(description); }
    if (is_active !== undefined && is_active !== null) { setClauses.push(`is_active = $${paramIdx++}`); params.push(is_active); }

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE categories SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] ? enrichCategory(result.rows[0]) : null;
  },

  async hardDelete(id) {
    const result = await query('DELETE FROM categories WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  async assignToRecipients(categoryId, recipientIds) {
    const sql = `UPDATE recipients SET default_category_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])`;
    const result = await query(sql, [categoryId, recipientIds]);
    return result.rowCount;
  },
};

function enrichCategory(row) {
  if (!row) return null;
  return {
    ...row,
    category_name: `${row.general}:${row.detail}`,
  };
}

export default categoryRepository;
