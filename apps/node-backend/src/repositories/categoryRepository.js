/**
 * Category Repository - data access for categories table.
 *
 */

import { query, withTransaction } from "../database/connection.js";
import { buildLimitOffset, buildSetClauses } from "../lib/sqlClauses.js";
import { ConflictError } from "../middleware/errorHandler.js";

/** @typedef {import('../types/rows.js').EnrichedCategoryRow} EnrichedCategoryRow */

/**
 * @typedef {object} CategoryFilters
 * @property {number|null} [limit]
 * @property {number} [offset]
 * @property {string|null} [general]
 * @property {string|null} [detail]
 * @property {string|null} [search]
 * @property {boolean} [active]
 */

export const categoryRepository = {
  /**
   * `limit` is optional and defaults to unbounded — the category pickers/pages
   * render every row and have no paging, so only an explicit limit/offset
   * narrows the list (buildLimitOffset).
   *
   * @param {CategoryFilters} [filters]
   * @returns {Promise<EnrichedCategoryRow[]>}
   */
  async getAll({
    limit = null,
    offset = 0,
    general = null,
    detail = null,
    search = null,
    active = true,
  } = {}) {
    let sql = `SELECT * FROM categories WHERE legacy_compatible = true`;
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
      sql += ` AND (general ILIKE $${paramIdx} OR detail ILIKE $${paramIdx} OR path_name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`;
      params.push(sp);
    }

    sql += ` ORDER BY general, detail`;
    sql += buildLimitOffset(params, { limit, offset });

    const result = await query(sql, params);
    return result.rows.map(enrichCategory);
  },

  /**
   * @param {CategoryFilters} [filters]
   * @returns {Promise<number>}
   */
  async getCount({
    general = null,
    detail = null,
    search = null,
    active = true,
  } = {}) {
    let sql = `SELECT count(*) FROM categories WHERE legacy_compatible = true`;
    const params = [];
    let paramIdx = 1;

    if (active) sql += ` AND is_active = true`;
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
      sql += ` AND (general ILIKE $${paramIdx} OR detail ILIKE $${paramIdx} OR path_name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`;
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
    const result = await query("SELECT * FROM categories WHERE id = $1", [id]);
    return result.rows[0] ? enrichCategory(result.rows[0]) : null;
  },

  /**
   * Resolve only active categories from a reviewed set of IDs.
   * @param {number[]} ids
   * @returns {Promise<EnrichedCategoryRow[]>}
   */
  async getActiveByIds(ids) {
    const uniqueIds = [...new Set(ids.filter(Number.isInteger))];
    if (uniqueIds.length === 0) return [];
    const result = await query(
      `SELECT * FROM categories
       WHERE id = ANY($1::int[]) AND is_active = true
       ORDER BY id`,
      [uniqueIds],
    );
    return result.rows.map(enrichCategory);
  },

  /**
   * @param {string} general
   * @param {string} detail
   * @returns {Promise<EnrichedCategoryRow|null>}
   */
  async getByGeneralDetail(general, detail) {
    const result = await query(
      "SELECT * FROM categories WHERE general = $1 AND detail = $2",
      [general.toUpperCase(), detail.toUpperCase()],
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
    return withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(1128356178, 1)");
      const alias = await query(
        `SELECT target_category_id AS id FROM category_merge_aliases
       WHERE general=$1 AND detail=$2`,
        [g, d],
      );
      if (alias.rows[0])
        return {
          category: await this.getById(alias.rows[0].id),
          created: false,
        };
      const insertResult = await query(
        `INSERT INTO categories (general, detail, description, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (general, detail) DO NOTHING
       RETURNING *`,
        [g, d, description],
      );

      if (insertResult.rows.length > 0) {
        // The hierarchy path is recomputed by an AFTER trigger, so RETURNING
        // still sees the pre-trigger placeholder. Read the committed row again.
        return {
          category: await this.getById(insertResult.rows[0].id),
          created: true,
        };
      }

      const existing = await this.getByGeneralDetail(g, d);
      return { category: existing, created: false };
    });
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
    const {
      clauses: setClauses,
      params,
      nextIdx: paramIdx,
    } = buildSetClauses({
      general: general != null ? general.toUpperCase().trim() : undefined,
      detail: detail != null ? detail.toUpperCase().trim() : undefined,
      description,
      is_active: is_active ?? undefined,
    });

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE categories SET ${setClauses.join(", ")} WHERE id = $${paramIdx} AND legacy_compatible = true RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] ? this.getById(id) : null;
  },

  /**
   * @param {number} id
   * @returns {Promise<boolean>}
   */
  async hardDelete(id) {
    try {
      const result = await query(
        "DELETE FROM categories WHERE id = $1 AND legacy_compatible = true",
        [id],
      );
      return result.rowCount > 0;
    } catch (error) {
      if (error?.code === "23503")
        throw new ConflictError(
          "Category is still referenced or has legacy merge redirects",
        );
      throw error;
    }
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
    category_name: row.path_name ?? `${row.general}:${row.detail}`,
  };
}

export default categoryRepository;
