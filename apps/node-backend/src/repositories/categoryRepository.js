/**
 * Category Repository - data access for categories table.
 *
 */

import { query } from '../database/connection.js';
import { buildSetClauses } from '../lib/sqlClauses.js';

/** @typedef {import('../types/rows.js').EnrichedCategoryRow} EnrichedCategoryRow */

/**
 * @typedef {object} CategoryFilters
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {string|null} [general]
 * @property {string|null} [detail]
 * @property {string|null} [search]
 * @property {boolean} [active]
 */

export const categoryRepository = {
  /**
   * @param {CategoryFilters} [filters]
   * @returns {Promise<EnrichedCategoryRow[]>}
   */
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

    sql += ` ORDER BY general, detail LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows.map(enrichCategory);
  },

  /**
   * @param {CategoryFilters} [filters]
   * @returns {Promise<number>}
   */
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
      params.push(sp);
    }

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * @param {number} id
   * @returns {Promise<EnrichedCategoryRow|null>}
   */
  async getById(id) {
    const result = await query('SELECT * FROM categories WHERE id = $1', [id]);
    return result.rows[0] ? enrichCategory(result.rows[0]) : null;
  },

  /**
   * @param {string} general
   * @param {string} detail
   * @returns {Promise<EnrichedCategoryRow|null>}
   */
  async getByGeneralDetail(general, detail) {
    const result = await query(
      'SELECT * FROM categories WHERE general = $1 AND detail = $2',
      [general.toUpperCase(), detail.toUpperCase()]
    );
    return result.rows[0] ? enrichCategory(result.rows[0]) : null;
  },

  /**
   * @param {{ general: string, detail: string, description?: string|null }} input
   * @returns {Promise<{ category: EnrichedCategoryRow|null, created: boolean }>}
   */
  async createOrGet({ general, detail, description = null }) {
    const g = general.toUpperCase().trim();
    const d = detail.toUpperCase().trim();

    const insertResult = await query(
      `INSERT INTO categories (general, detail, description, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (general, detail) DO NOTHING
       RETURNING *`,
      [g, d, description]
    );

    if (insertResult.rows.length > 0) {
      return { category: enrichCategory(insertResult.rows[0]), created: true };
    }

    const existing = await this.getByGeneralDetail(g, d);
    return { category: existing, created: false };
  },

  /**
   * @param {number} id
   * @param {{ general?: string|null, detail?: string|null, description?: string|null, is_active?: boolean|null }} fields
   * @returns {Promise<EnrichedCategoryRow|null>}
   */
  async update(id, { general, detail, description, is_active }) {
    // Shared clause builder (lib/sqlClauses.js): undefined fields are skipped.
    // null general/detail/is_active mean "leave unchanged" (pre-mapped to
    // undefined); description accepts an explicit null write.
    const { clauses: setClauses, params, nextIdx: paramIdx } = buildSetClauses({
      general: general != null ? general.toUpperCase().trim() : undefined,
      detail: detail != null ? detail.toUpperCase().trim() : undefined,
      description,
      is_active: is_active ?? undefined,
    });

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE categories SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] ? enrichCategory(result.rows[0]) : null;
  },

  /**
   * @param {number} id
   * @returns {Promise<boolean>}
   */
  async hardDelete(id) {
    const result = await query('DELETE FROM categories WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  /**
   * @param {number} categoryId
   * @param {number[]} recipientIds
   * @returns {Promise<number|null>} rows updated (pg `rowCount`)
   */
  async assignToRecipients(categoryId, recipientIds) {
    const sql = `UPDATE recipients SET default_category_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])`;
    const result = await query(sql, [categoryId, recipientIds]);
    return result.rowCount;
  },
};

/**
 * Add the `GENERAL:DETAIL` display name to a `categories` row.
 *
 * @param {any} row
 * @returns {EnrichedCategoryRow|null}
 */
function enrichCategory(row) {
  if (!row) return null;
  return {
    ...row,
    category_name: `${row.general}:${row.detail}`,
  };
}

export default categoryRepository;
