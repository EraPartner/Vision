/**
 * Recipient Repository - data access for recipients table.
 *
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
import { normalizeForMatching } from '../lib/textNormalization.js';
import { buildSetClauses } from '../lib/sqlClauses.js';

// Allowed sort columns for recipients (maps frontend key -> SQL expression)
const RECIPIENT_SORT_COLUMNS = {
  name: 'r.name',
  default_category_name: `CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE NULL END`,
  primary_bank_account: 'primary_bank_account',
  alias_count: 'alias_count',
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
    // Phase 6: only surface recipients that both lack a default category
    // *and* have recorded activity. This previously read the trigger-maintained
    // `agg_recipient_totals` table (dropped in migration 0080 as pure write
    // overhead); it now probes `transactions` directly. Semantics are preserved
    // exactly: `agg_recipient_totals.transaction_count > 0` counted active,
    // non-transfer, currency-bearing rows keyed on the raw recipient_id (see
    // migrations 0035/0045), so the equivalent existence check is an active,
    // non-transfer transaction with a currency for this recipient. Served by
    // idx_transactions_recipient_date_active (recipient_id ... WHERE is_active).
    sql += ` AND r.default_category_id IS NULL
             AND EXISTS (
               SELECT 1 FROM transactions t
               WHERE t.recipient_id = r.id
                 AND t.is_active = true
                 AND t.is_transfer = false
                 AND t.currency IS NOT NULL
             )`;
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
             pba.account_number AS primary_bank_account,
             pr.name AS primary_recipient_name,
             COALESCE(ac.alias_count, 0) AS alias_count
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN LATERAL (
        SELECT rba.account_number
        FROM recipient_bank_accounts rba
        WHERE rba.recipient_id = r.id AND rba.is_active = true
        ORDER BY rba.is_primary DESC
        LIMIT 1
      ) pba ON true
      LEFT JOIN (
        SELECT primary_recipient_id, count(*)::int AS alias_count
        FROM recipients
        WHERE primary_recipient_id IS NOT NULL
        GROUP BY primary_recipient_id
      ) ac ON ac.primary_recipient_id = r.id
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
             pba.account_number AS primary_bank_account,
             pr.name AS primary_recipient_name,
             COALESCE(ac.alias_count, 0) AS alias_count
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN LATERAL (
        SELECT rba.account_number
        FROM recipient_bank_accounts rba
        WHERE rba.recipient_id = r.id AND rba.is_active = true
        ORDER BY rba.is_primary DESC
        LIMIT 1
      ) pba ON true
      LEFT JOIN (
        SELECT primary_recipient_id, count(*)::int AS alias_count
        FROM recipients
        WHERE primary_recipient_id IS NOT NULL
        GROUP BY primary_recipient_id
      ) ac ON ac.primary_recipient_id = r.id
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

  /**
   * @param {any} id
   * @param {{ name?: any, default_category_id?: any, notes?: any, is_active?: any }} fields
   */
  async update(id, { name, default_category_id, notes, is_active }) {
    // Shared clause builder (lib/sqlClauses.js): undefined fields are skipped.
    // A name write always updates the derived normalized_name alongside it;
    // null name / is_active mean "leave unchanged" (pre-mapped to undefined).
    const hasName = name !== undefined && name !== null;
    const { clauses: setClauses, params, nextIdx: paramIdx } = buildSetClauses({
      name: hasName ? name.toUpperCase().trim() : undefined,
      normalized_name: hasName ? normalizeForMatching(name) : undefined,
      default_category_id,
      notes,
      is_active: is_active ?? undefined,
    });

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `
      WITH updated AS (
        UPDATE recipients
        SET ${setClauses.join(', ')}
        WHERE id = $${paramIdx}
        RETURNING *
      )
      SELECT u.*,
             CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE NULL END AS default_category_name,
             pba.account_number AS primary_bank_account,
             pr.name AS primary_recipient_name,
             COALESCE(ac.alias_count, 0) AS alias_count
      FROM updated u
      LEFT JOIN categories c ON u.default_category_id = c.id
      LEFT JOIN recipients pr ON u.primary_recipient_id = pr.id
      LEFT JOIN LATERAL (
        SELECT rba.account_number
        FROM recipient_bank_accounts rba
        WHERE rba.recipient_id = u.id AND rba.is_active = true
        ORDER BY rba.is_primary DESC
        LIMIT 1
      ) pba ON true
      LEFT JOIN (
        SELECT primary_recipient_id, count(*)::int AS alias_count
        FROM recipients
        WHERE primary_recipient_id IS NOT NULL
        GROUP BY primary_recipient_id
      ) ac ON ac.primary_recipient_id = u.id
    `;
    const result = await query(sql, params);
    return result.rows[0] || null;
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

  /**
   * Resolve recipient ids to their cluster root (primary_recipient_id ?? id).
   * Returns a Map<recipientId, clusterRootId> for the ids that exist.
   */
  async getClusterRootMap(recipientIds) {
    const ids = [...new Set((recipientIds || []).filter((id) => id != null))];
    if (ids.length === 0) return new Map();
    const result = await query(
      `SELECT id, COALESCE(primary_recipient_id, id) AS cluster_root
         FROM recipients
        WHERE id = ANY($1::int[])`,
      [ids]
    );
    const map = new Map();
    for (const row of result.rows) map.set(row.id, row.cluster_root);
    return map;
  },
};

export default recipientRepository;
