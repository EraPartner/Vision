/**
 * Tag Repository — data access for the tags table.
 *
 * Tags are globally unique by slug to support soft-delete reactivation
 * while preserving junction row history.
 */

import { query } from '../database/connection.js';
import { buildLimitOffset, buildSetClauses } from '../lib/sqlClauses.js';

/** @typedef {import('../types/rows.js').TagRow} TagRow */

export const tagRepository = {
  /**
   * List tags, optionally filtered by active status.
   *
   * `limit` is optional and defaults to unbounded — the tag pickers/filters
   * render every tag and have no paging, so only an explicit limit/offset
   * narrows the list (buildLimitOffset).
   *
   * @param {{ active?: boolean|null, limit?: number|null, offset?: number }} [opts]
   * @returns {Promise<TagRow[]>}
   */
  async getAll({ active = null, limit = null, offset = 0 } = {}) {
    let sql = 'SELECT * FROM tags WHERE 1=1';

    if (active === true) {
      sql += ` AND is_active = true`;
    } else if (active === false) {
      sql += ` AND is_active = false`;
    }

    sql += ` ORDER BY slug`;
    /** @type {any[]} */
    const params = [];
    sql += buildLimitOffset(params, { limit, offset });
    const result = await query(sql, params);
    return result.rows;
  },

  /**
   * Count tags matching the active filter (for paginated list totals).
   * @param {{ active?: boolean|null }} [opts]
   * @returns {Promise<number>} `COUNT(*)` is a bigint string; parsed here.
   */
  async getCount({ active = null } = {}) {
    let sql = 'SELECT COUNT(*) FROM tags WHERE 1=1';
    /** @type {any[]} */
    const params = [];

    if (active === true) {
      sql += ` AND is_active = true`;
    } else if (active === false) {
      sql += ` AND is_active = false`;
    }

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * @param {number} id
   * @returns {Promise<TagRow|null>}
   */
  async getById(id) {
    const result = await query('SELECT * FROM tags WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  },

  /**
   * @param {string} slug
   * @returns {Promise<TagRow|null>}
   */
  async getBySlug(slug) {
    const result = await query('SELECT * FROM tags WHERE slug = $1', [slug]);
    return result.rows[0] ?? null;
  },

  /**
   * Look up tags by slug array. Returns only rows that exist.
   * @param {string[]} slugs
   * @returns {Promise<TagRow[]>}
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
   * @param {string|null} [color]
   * @returns {Promise<{ tag: TagRow, reactivated: boolean }>}
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
   *
   * @param {number} id
   * @param {{ color?: string|null, is_active?: boolean|null }} fields
   * @returns {Promise<TagRow|null>}
   */
  async update(id, { color, is_active }) {
    // Shared clause builder (lib/sqlClauses.js): undefined fields are skipped;
    // null is_active means "leave unchanged" (pre-mapped to undefined).
    const { clauses: setClauses, params, nextIdx: idx } = buildSetClauses({
      color,
      is_active: is_active ?? undefined,
    });

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
   *
   * @param {number} id
   * @returns {Promise<TagRow|null>}
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
   *
   * @param {number} tagId
   * @returns {Promise<number>}
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
