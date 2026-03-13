/**
 * Recipient Repository - data access for recipients table.
 *
 * Mirrors: apps/backend/repositories/recipient_repository.py
 *
 * Performance notes:
 * - textNormalization is imported at module level to avoid per-call dynamic import overhead.
 * - createOrGet uses INSERT ... ON CONFLICT (normalized_name) DO NOTHING to reduce
 *   the old getByName + getById (2-3 round-trips) to 1 round-trip for new recipients,
 *   and adds a fast SELECT path for existing ones (1 round-trip).
 * - getAll + getCount share the same WHERE predicate but are kept separate for clarity.
 *   Callers that need both can call them concurrently via Promise.all.
 */

import { query } from '../database/connection.js';
import { normalizeForMatching } from '../services/textNormalization.js';

// Allowed sort columns for recipients (maps frontend key -> SQL expression)
const RECIPIENT_SORT_COLUMNS = {
  name: 'r.name',
  default_category_name: `CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE NULL END`,
  primary_bank_account: `(SELECT rba.account_number FROM recipient_bank_accounts rba
                          WHERE rba.recipient_id = r.id AND rba.is_active = true
                          ORDER BY rba.is_primary DESC LIMIT 1)`,
  alias_count: `(SELECT count(*) FROM recipients alias WHERE alias.primary_recipient_id = r.id)`,
  notes: 'r.notes',
  is_active: 'r.is_active',
};

/** Build the shared WHERE clause and params array for filter-based queries. */
function buildWhereClause({ name, defaultCategoryId, search, active, uncategorized }) {
  let sql = `WHERE 1=1`;
  const params = [];
  let p = 1;

  if (active) sql += ` AND r.is_active = true`;
  if (name) { sql += ` AND r.name ILIKE $${p++}`; params.push(`%${name}%`); }
  if (uncategorized) {
    sql += ` AND r.default_category_id IS NULL`;
  } else if (defaultCategoryId != null) {
    sql += ` AND r.default_category_id = $${p++}`;
    params.push(defaultCategoryId);
  }
  if (search) {
    const sp = `%${search}%`;
    // Use GIN trigram index on r.name for fast ILIKE; other columns fall back to seq scan
    sql += ` AND (
      r.name ILIKE $${p} OR
      r.notes ILIKE $${p} OR
      c.general ILIKE $${p} OR
      c.detail ILIKE $${p} OR
      EXISTS (SELECT 1 FROM recipient_bank_accounts rba WHERE rba.recipient_id = r.id AND rba.account_number ILIKE $${p})
    )`;
    p++;
    params.push(sp);
  }

  return { sql, params, nextParam: p };
}

export const recipientRepository = {
  async getAll({ limit = 50, offset = 0, name = null, defaultCategoryId = null, search = null, active = true, uncategorized = false, sortBy = null, sortDir = null } = {}) {
    const { sql: where, params, nextParam: p } = buildWhereClause({ name, defaultCategoryId, search, active, uncategorized });

    const sortCol = RECIPIENT_SORT_COLUMNS[sortBy] || 'r.name';
    const sortDirection = sortDir === 'desc' ? 'DESC' : 'ASC';
    const orderBy = sortBy && RECIPIENT_SORT_COLUMNS[sortBy]
      ? `${sortCol} ${sortDirection}, r.name ASC`
      : `r.name ASC`;

    const sql = `
      SELECT r.*,
             CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE NULL END AS default_category_name,
             (SELECT rba.account_number FROM recipient_bank_accounts rba
              WHERE rba.recipient_id = r.id AND rba.is_active = true
              ORDER BY rba.is_primary DESC LIMIT 1) AS primary_bank_account,
             pr.name AS primary_recipient_name,
             (SELECT count(*) FROM recipients alias WHERE alias.primary_recipient_id = r.id) AS alias_count
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      ${where}
      ORDER BY ${orderBy} LIMIT $${p} OFFSET $${p + 1}
    `;

    const result = await query(sql, [...params, limit, offset]);
    return result.rows;
  },

  async getCount({ name = null, defaultCategoryId = null, search = null, active = true, uncategorized = false } = {}) {
    const { sql: where, params } = buildWhereClause({ name, defaultCategoryId, search, active, uncategorized });

    const sql = `
      SELECT count(*) FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      ${where}
    `;
    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id) {
    const sql = `
      SELECT r.*,
             CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE NULL END AS default_category_name,
             (SELECT rba.account_number FROM recipient_bank_accounts rba
              WHERE rba.recipient_id = r.id AND rba.is_active = true
              ORDER BY rba.is_primary DESC LIMIT 1) AS primary_bank_account,
             pr.name AS primary_recipient_name,
             (SELECT count(*) FROM recipients alias WHERE alias.primary_recipient_id = r.id) AS alias_count
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE r.id = $1
    `;
    const result = await query(sql, [id]);
    return result.rows[0] || null;
  },

  async getByName(name) {
    const normalized = normalizeForMatching(name);
    const result = await query(
      `SELECT * FROM recipients WHERE normalized_name = $1`,
      [normalized]
    );
    return result.rows[0] || null;
  },

  /**
   * Get or create a recipient by name using a single upsert round-trip.
   *
   * Strategy:
   *  1. INSERT ... ON CONFLICT (normalized_name) DO NOTHING RETURNING id
   *     - If the row is new, we get the id back immediately (1 round-trip total).
   *     - If the row exists, RETURNING is empty (DO NOTHING path).
   *  2. On conflict (empty result), fall back to a single SELECT to retrieve the
   *     existing row's id — still only 2 round-trips max vs the old 3-4.
   */
  async createOrGet({ name }) {
    const upperName = name.toUpperCase().trim();
    const normalizedName = normalizeForMatching(name);

    // Attempt insert; silent on conflict (normalized_name has unique constraint)
    const insertResult = await query(
      `INSERT INTO recipients (name, normalized_name, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (normalized_name) DO NOTHING
       RETURNING id`,
      [upperName, normalizedName]
    );

    let recipientId;
    let created;

    if (insertResult.rows.length > 0) {
      // Newly inserted
      recipientId = insertResult.rows[0].id;
      created = true;
    } else {
      // Already existed
      const existingResult = await query(
        `SELECT id FROM recipients WHERE normalized_name = $1`,
        [normalizedName]
      );
      if (!existingResult.rows.length) {
        throw new Error(`Recipient not found after conflict: ${normalizedName}`);
      }
      recipientId = existingResult.rows[0].id;
      created = false;
    }

    const full = await this.getById(recipientId);
    return { recipient: full, created };
  },

  async update(id, { name, default_category_id, notes, is_active }) {
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    if (name !== undefined && name !== null) {
      const upperName = name.toUpperCase().trim();
      setClauses.push(`name = $${paramIdx++}`);
      params.push(upperName);
      setClauses.push(`normalized_name = $${paramIdx++}`);
      params.push(normalizeForMatching(name));
    }
    if (default_category_id !== undefined) { setClauses.push(`default_category_id = $${paramIdx++}`); params.push(default_category_id); }
    if (notes !== undefined) { setClauses.push(`notes = $${paramIdx++}`); params.push(notes); }
    if (is_active !== undefined && is_active !== null) { setClauses.push(`is_active = $${paramIdx++}`); params.push(is_active); }

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE recipients SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    const result = await query(sql, params);
    if (result.rows.length === 0) return null;
    return this.getById(id);
  },

  async hardDelete(id) {
    const result = await query('DELETE FROM recipients WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  /**
   * Merge: set primary_recipient_id on alias recipients pointing to a primary.
   */
  async mergeRecipients(primaryId, aliasIds) {
    if (!aliasIds.length) return [];
    const placeholders = aliasIds.map((_, i) => `$${i + 2}`).join(',');
    const sql = `UPDATE recipients SET primary_recipient_id = $1, updated_at = NOW() WHERE id IN (${placeholders}) AND id != $1 RETURNING id`;
    const result = await query(sql, [primaryId, ...aliasIds]);
    return result.rows.map(r => r.id);
  },

  /**
   * Unmerge: remove primary_recipient_id from a recipient.
   */
  async unmergeRecipient(id) {
    const sql = `UPDATE recipients SET primary_recipient_id = NULL, updated_at = NOW() WHERE id = $1 RETURNING id`;
    const result = await query(sql, [id]);
    return result.rows.length > 0;
  },

  /**
   * Get all aliases for a primary recipient.
   */
  async getAliases(primaryId) {
    const sql = `
      SELECT r.*,
             CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE NULL END AS default_category_name
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      WHERE r.primary_recipient_id = $1
      ORDER BY r.name
    `;
    const result = await query(sql, [primaryId]);
    return result.rows;
  },
};

export default recipientRepository;
