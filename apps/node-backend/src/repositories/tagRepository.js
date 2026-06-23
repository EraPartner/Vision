/**
 * Tag Repository — data access for the tags table.
 *
 * Tags are globally unique by slug to support soft-delete reactivation
 * while preserving junction row history.
 */

import { query } from '../database/connection.js';

export const tagRepository = {
  /**
   * List tags, optionally filtered by active status.
   * @param {{ active?: boolean|null }} opts
   */
  async getAll({ active = null } = {}) {
    let sql = 'SELECT * FROM tags WHERE 1=1';
    const params = [];

    if (active === true) {
      sql += ` AND is_active = true`;
    } else if (active === false) {
      sql += ` AND is_active = false`;
    }

    sql += ' ORDER BY slug';
    const result = await query(sql, params);
    return result.rows;
  },

  async getById(id) {
    const result = await query('SELECT * FROM tags WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  },

  async getBySlug(slug) {
    const result = await query('SELECT * FROM tags WHERE slug = $1', [slug]);
    return result.rows[0] ?? null;
  },

  /**
   * Look up tags by slug array. Returns only rows that exist.
   * @param {string[]} slugs
   */
  async getManyBySlugs(slugs) {
    if (slugs.length === 0) return [];
    const result = await query(
      'SELECT * FROM tags WHERE slug = ANY($1::text[])',
      [slugs]
    );
    return result.rows;
  },

  /**
   * Atomic find-or-create with reactivation.
   * If slug exists and is soft-deleted, it is reactivated.
   * Color is preserved if already set; new color is applied only if column was NULL.
   *
   * @param {string} slug  Already normalized by caller
   * @param {string|null} color
   * @returns {Promise<{ tag: object, reactivated: boolean }>}
   */
  async findOrCreateBySlug(slug, color = null) {
    const result = await query(
      `INSERT INTO tags (slug, color)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE
         SET is_active = true,
             color     = COALESCE(tags.color, EXCLUDED.color),
             updated_at = NOW()
       RETURNING *, (xmax <> 0) AS was_conflict`,
      [slug, color]
    );
    const row = result.rows[0];
    const reactivated = row.was_conflict && row.is_active;
    const { was_conflict: _wc, ...tag } = row;
    return { tag, reactivated };
  },

  /**
   * Update allowed mutable fields: color and/or is_active.
   * Slug is immutable.
   */
  async update(id, { color, is_active }) {
    const setClauses = [];
    const params = [];
    let idx = 1;

    if (color !== undefined) { setClauses.push(`color = $${idx++}`); params.push(color); }
    if (is_active !== undefined && is_active !== null) { setClauses.push(`is_active = $${idx++}`); params.push(is_active); }

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push('updated_at = NOW()');
    params.push(id);
    const result = await query(
      `UPDATE tags SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] ?? null;
  },

  /**
   * Soft delete: set is_active = false.
   */
  async softDelete(id) {
    const result = await query(
      `UPDATE tags SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    return result.rows[0] ?? null;
  },

  /**
   * Count how many transactions reference a given tag (for reactivation toast).
   */
  async countTransactionReferences(tagId) {
    const result = await query(
      'SELECT COUNT(*) FROM transaction_tags WHERE tag_id = $1',
      [tagId]
    );
    return parseInt(result.rows[0].count, 10);
  },
};

export default tagRepository;
