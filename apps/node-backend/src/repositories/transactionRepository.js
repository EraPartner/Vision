/**
 * Transaction Repository - data access for transactions table.
 *
 * Mirrors: apps/backend/repositories/transaction_repository.py
 *
 * Performance notes:
 * - create() uses a CTE to INSERT and immediately JOIN in a single round-trip,
 *   eliminating the old INSERT RETURNING + separate getById pattern.
 * - getAllWithCount() uses COUNT(*) OVER () window function so pagination callers
 *   get rows and total count in one DB call instead of two.
 */

import { query, queryPrepared, withTransaction } from '../database/connection.js';
import { sanitizeUpdateFields } from '../middleware/validation.js';
import { buildTransactionWhere } from '../services/filterBuilder.js';

// Shared JOIN fragment used by every multi-join query
const TRANSACTION_JOINS = `
  LEFT JOIN recipients r ON t.recipient_id = r.id
  LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
  LEFT JOIN categories c ON t.category_id = c.id
  LEFT JOIN categories rc ON r.default_category_id = rc.id
  LEFT JOIN categories pc ON pr.default_category_id = pc.id
`;

// Allowed sort columns for transactions (maps frontend key -> SQL expression)
const TRANSACTION_SORT_COLUMNS = {
  date: 't.date',
  amount: 't.amount',
  memo: 't.memo',
  recipient: 'COALESCE(pr.name, r.name)',
  category: `CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END`,
  bank: 't.bank_account',
  currency: 't.currency',
};

async function attachTagsToRows(rows) {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const result = await query(
    `SELECT tt.transaction_id, tg.id, tg.slug, tg.color, tg.is_active
     FROM transaction_tags tt
     JOIN tags tg ON tg.id = tt.tag_id
     WHERE tt.transaction_id = ANY($1::int[])`,
    [ids],
  );
  const tagMap = new Map();
  for (const row of result.rows) {
    const list = tagMap.get(row.transaction_id) ?? [];
    list.push({ id: row.id, slug: row.slug, color: row.color, is_active: row.is_active });
    tagMap.set(row.transaction_id, list);
  }
  return rows.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] }));
}

async function setTransactionTags(client, transactionId, slugs) {
  await client.query('DELETE FROM transaction_tags WHERE transaction_id = $1', [transactionId]);
  if (!slugs || slugs.length === 0) return;
  const resolved = await client.query(
    'SELECT id FROM tags WHERE slug = ANY($1::text[]) AND is_active = true',
    [slugs],
  );
  if (resolved.rows.length === 0) return;
  const tagIds = resolved.rows.map((r) => r.id);
  await client.query(
    `INSERT INTO transaction_tags (transaction_id, tag_id)
     SELECT $1, unnest($2::int[])
     ON CONFLICT DO NOTHING`,
    [transactionId, tagIds],
  );
}

export const transactionRepository = {
  /**
   * Get transactions with pagination and filtering.
   */
  async getAll({
    transactionId = null,
    limit = 50,
    offset = 0,
    startDate = null,
    endDate = null,
    bankAccount = null,
    categoryId = null,
    recipientId = null,
    recipientGroupId = null,
    recipientName = null,
    search = null,
    active = true,
    sortBy = null,
    sortDir = null,
    includeBalance = false,
    tagSlugs = null,
  } = {}) {
    const { sql: where, params, nextParamIdx: p } = buildTransactionWhere({
      transactionId, startDate, endDate, bankAccount, categoryId, recipientId, recipientGroupId, recipientName, search, active, tagSlugs,
    });

    // Build ORDER BY — fall back to default date DESC when no valid sort supplied
    const sortCol = TRANSACTION_SORT_COLUMNS[sortBy] || 't.date';
    const sortDirection = sortDir === 'asc' ? 'ASC' : 'DESC';
    // Secondary sort by date DESC keeps rows stable when primary column has
    // ties; t.id DESC is the unique final tiebreaker so LIMIT/OFFSET pages can't
    // duplicate or skip same-date rows across separate query executions.
    const orderBy = sortBy && TRANSACTION_SORT_COLUMNS[sortBy]
      ? `${sortCol} ${sortDirection}, t.date DESC, t.id DESC`
      : `t.date DESC, t.id DESC`;

    // Partition by bank_account: a running balance is a per-account ledger
    // figure. Without the partition, a list spanning multiple accounts summed
    // them into one meaningless cross-account total. (The window itself is
    // evaluated over the full filtered set, before LIMIT/OFFSET, so the value
    // is still correct across pages.)
    const runningBalanceCol = includeBalance
      ? `, SUM(t.amount) OVER (PARTITION BY t.bank_account ORDER BY t.date ASC, t.id ASC) AS running_balance`
      : '';

    const sql = `
      SELECT t.*,
             COALESCE(pr.name, r.name) AS recipient_name,
             COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS effective_category_id,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name${runningBalanceCol}
      FROM transactions t
      ${TRANSACTION_JOINS}
      WHERE ${where}
      ORDER BY ${orderBy} LIMIT $${p} OFFSET $${p + 1}
    `;
    params.push(limit, offset);

    const result = await query(sql, params);
    return attachTagsToRows(result.rows);
  },

  /**
   * Get total count with optional filters (reuses the same WHERE builder as getAll).
   */
  async getCount({
    transactionId = null,
    startDate = null,
    endDate = null,
    bankAccount = null,
    categoryId = null,
    recipientId = null,
    recipientGroupId = null,
    recipientName = null,
    search = null,
    active = true,
    tagSlugs = null,
  } = {}) {
    const { sql: where, params } = buildTransactionWhere({
      transactionId, startDate, endDate, bankAccount, categoryId, recipientId, recipientGroupId, recipientName, search, active, tagSlugs,
    });

    const sql = `
      SELECT count(*) FROM transactions t
      ${TRANSACTION_JOINS}
      WHERE ${where}
    `;

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * Get uncategorised transactions (recipient has no default category and transaction has no category).
   */
  async getUncategorised({ limit = 50, offset = 0, startDate = null, endDate = null, bankAccount = null, recipientId = null, recipientName = null } = {}) {
    let sql = `
      SELECT t.*,
             r.name AS recipient_name,
             NULL AS category_name
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      WHERE t.is_active = true
        AND t.category_id IS NULL
        AND (r.default_category_id IS NULL)
    `;
    const params = [];
    let paramIdx = 1;

    if (startDate) { sql += ` AND t.date >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND t.date <= $${paramIdx++}`; params.push(endDate); }
    if (bankAccount) { sql += ` AND t.bank_account ILIKE $${paramIdx++}`; params.push(`%${bankAccount}%`); }
    if (recipientId != null) { sql += ` AND t.recipient_id = $${paramIdx++}`; params.push(recipientId); }
    if (recipientName) { sql += ` AND r.name ILIKE $${paramIdx++}`; params.push(`%${recipientName}%`); }

    sql += ` ORDER BY t.date DESC, t.id DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return attachTagsToRows(result.rows);
  },

  /**
   * Get uncategorised transactions plus total in a single round-trip.
   *
   * Important behavior note:
   * - `rows` preserve uncategorised filtering semantics from getUncategorised().
   * - `total` preserves historical route semantics from getCount(), which may include
   *   additional filters such as search/category that are not applied to uncategorised rows.
   */
  async getUncategorisedWithCount({
    transactionId = null,
    limit = 50,
    offset = 0,
    startDate = null,
    endDate = null,
    bankAccount = null,
    categoryId = null,
    recipientId = null,
    recipientName = null,
    search = null,
    active = true,
  } = {}) {
    const {
      sql: totalWhere,
      params: totalParams,
      nextParamIdx: totalNextParam,
    } = buildTransactionWhere({
      transactionId,
      startDate,
      endDate,
      bankAccount,
      categoryId,
      recipientId,
      recipientName,
      search,
      active,
    });

    const params = [...totalParams];
    let paramIdx = totalNextParam;

    let uncategorisedWhere = `
      t.is_active = true
      AND t.category_id IS NULL
      AND (r.default_category_id IS NULL)
    `;

    if (startDate) {
      uncategorisedWhere += ` AND t.date >= $${paramIdx++}`;
      params.push(startDate);
    }
    if (endDate) {
      uncategorisedWhere += ` AND t.date <= $${paramIdx++}`;
      params.push(endDate);
    }
    if (bankAccount) {
      uncategorisedWhere += ` AND t.bank_account ILIKE $${paramIdx++}`;
      params.push(`%${bankAccount}%`);
    }
    if (recipientId != null) {
      uncategorisedWhere += ` AND t.recipient_id = $${paramIdx++}`;
      params.push(recipientId);
    }
    if (recipientName) {
      uncategorisedWhere += ` AND r.name ILIKE $${paramIdx++}`;
      params.push(`%${recipientName}%`);
    }

    const limitParam = paramIdx;
    const offsetParam = paramIdx + 1;
    params.push(limit, offset);

    const sql = `
      WITH total_cte AS (
        SELECT count(*)::int AS total
        FROM transactions t
        ${TRANSACTION_JOINS}
        WHERE ${totalWhere}
      ),
      uncategorised_rows AS (
        SELECT t.*,
               r.name AS recipient_name,
               NULL AS category_name
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        WHERE ${uncategorisedWhere}
        ORDER BY t.date DESC, t.id DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      )
      SELECT u.*,
             tc.total AS total_count
      FROM total_cte tc
      LEFT JOIN uncategorised_rows u ON true
      ORDER BY u.date DESC NULLS LAST, u.id DESC NULLS LAST
    `;

    const result = await query(sql, params);
    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    const rows = result.rows
      .filter((row) => row.id != null)
      .map(({ total_count: _total_count, ...row }) => row);

    return { rows: await attachTagsToRows(rows), total };
  },

  /**
   * Get a single transaction by ID.
   */
  async getById(id) {
    const sql = `
      SELECT t.*,
             r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      WHERE t.id = $1
    `;
    const result = await queryPrepared('tx_get_by_id', sql, [id]);
    const row = result.rows[0] || null;
    if (!row) return null;
    const [enriched] = await attachTagsToRows([row]);
    return enriched;
  },

  /**
   * Create a new transaction and return the full enriched row in a single round-trip.
   *
   * Uses a CTE to INSERT the row and immediately JOIN with recipients/categories so
   * callers get the complete representation without a second SELECT (getById) call.
   */
  async create({ transaction_date, bank_account, recipient_id, amount, memo, currency, balance, category_id, comment, tags = null }) {
    const sql = `
      WITH inserted AS (
        INSERT INTO transactions (date, bank_account, recipient_id, amount, memo, currency, balance, category_id, comment, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
        RETURNING *
      )
      SELECT t.*,
             r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name
      FROM inserted t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
    `;
    const sqlParams = [
      transaction_date,
      bank_account ? bank_account.toUpperCase() : null,
      recipient_id,
      amount,
      memo ? memo.toUpperCase() : null,
      // Default to EUR rather than NULL: currency is NOT NULL at the DB level
      // (migration 0046) and the read layer already coalesces missing → EUR.
      currency ? currency.toUpperCase() : 'EUR',
      balance,
      category_id,
      comment,
    ];

    let row;
    if (tags !== null) {
      row = await withTransaction(async (client) => {
        const res = await client.query(sql, sqlParams);
        const inserted = res.rows[0];
        if (!inserted) return null;
        await setTransactionTags(client, inserted.id, tags);
        return inserted;
      });
    } else {
      const result = await queryPrepared('tx_create', sql, sqlParams);
      row = result.rows[0] || null;
    }

    if (!row) return null;
    const [enriched] = await attachTagsToRows([row]);
    return enriched;
  },

  /**
   * Get transactions AND total count in a single DB round-trip using COUNT(*) OVER ().
   * Use this instead of calling getAll() + getCount() separately in paginated views.
   *
   * Returns: { rows: [...], total: number }
   */
  async getAllWithCount({
    transactionId = null,
    limit = 50,
    offset = 0,
    startDate = null,
    endDate = null,
    bankAccount = null,
    categoryId = null,
    categoryIds = null,
    recipientId = null,
    recipientGroupId = null,
    recipientName = null,
    search = null,
    active = true,
    sortBy = null,
    sortDir = null,
    includeBalance = false,
    transactionType = null,
    tagSlugs = null,
  } = {}) {
    const { sql: where, params, nextParamIdx: p } = buildTransactionWhere({
      transactionId, startDate, endDate, bankAccount, categoryId, categoryIds, recipientId, recipientGroupId, recipientName, search, active, transactionType, tagSlugs,
    });

    const sortCol = TRANSACTION_SORT_COLUMNS[sortBy] || 't.date';
    const sortDirection = sortDir === 'asc' ? 'ASC' : 'DESC';
    // t.id DESC is the unique final tiebreaker — without it LIMIT/OFFSET pages
    // can duplicate or skip same-date rows across separate query executions.
    const orderBy = sortBy && TRANSACTION_SORT_COLUMNS[sortBy]
      ? `${sortCol} ${sortDirection}, t.date DESC, t.id DESC`
      : `t.date DESC, t.id DESC`;

    // Partition by bank_account: a running balance is a per-account ledger
    // figure. Without the partition, a list spanning multiple accounts summed
    // them into one meaningless cross-account total. (The window itself is
    // evaluated over the full filtered set, before LIMIT/OFFSET, so the value
    // is still correct across pages.)
    const runningBalanceCol = includeBalance
      ? `, SUM(t.amount) OVER (PARTITION BY t.bank_account ORDER BY t.date ASC, t.id ASC) AS running_balance`
      : '';

    const sql = `
      SELECT t.*,
             COALESCE(pr.name, r.name) AS recipient_name,
             COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS effective_category_id,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name,
             COUNT(*) OVER () AS total_count${runningBalanceCol}
      FROM transactions t
      ${TRANSACTION_JOINS}
      WHERE ${where}
      ORDER BY ${orderBy} LIMIT $${p} OFFSET $${p + 1}
    `;
    params.push(limit, offset);

    const result = await query(sql, params);
    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    const rows = result.rows.map(({ total_count: _total_count, ...row }) => row);
    return { rows: await attachTagsToRows(rows), total };
  },

  /**
   * Update a transaction.
   * When `tags` is present in fields, junction rows are replaced atomically.
   * When `tags` is absent, existing tags are untouched.
   */
  async update(id, fields) {
    const { tags, ...txFields } = fields;
    // Sanitize field names to prevent SQL injection via column names
    const sanitized = sanitizeUpdateFields('transactions', txFields);
    const setClauses = [];
    const updateParams = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(sanitized)) {
      if (value === undefined) continue;
      // Map frontend field names to DB columns
      const dbCol = key === 'transaction_date' ? 'date' : key;
      setClauses.push(`"${dbCol}" = $${paramIdx++}`);
      updateParams.push(value);
    }

    const fetchSql = `
      SELECT t.*, r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      WHERE t.id = $1
    `;

    if (tags !== undefined) {
      const row = await withTransaction(async (client) => {
        if (setClauses.length > 0) {
          setClauses.push(`updated_at = NOW()`);
          updateParams.push(id);
          const updateSql = `
            WITH updated AS (
              UPDATE transactions SET ${setClauses.join(', ')}
              WHERE id = $${paramIdx} RETURNING id
            )
            SELECT id FROM updated
          `;
          const res = await client.query(updateSql, updateParams);
          if (!res.rows[0]) return null;
        } else {
          // Tags-only PATCH: probe existence first. Otherwise setTransactionTags'
          // junction INSERT hits the transaction_id FK for a missing row → a raw
          // 23503 surfaces as a 500 instead of the standard 404.
          const exists = await client.query('SELECT 1 FROM transactions WHERE id = $1', [id]);
          if (!exists.rows[0]) return null;
        }
        await setTransactionTags(client, id, tags ?? []);
        const res = await client.query(fetchSql, [id]);
        return res.rows[0] || null;
      });
      if (!row) return null;
      const [enriched] = await attachTagsToRows([row]);
      return enriched;
    }

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    updateParams.push(id);

    const sql = `
      WITH updated AS (
        UPDATE transactions
        SET ${setClauses.join(', ')}
        WHERE id = $${paramIdx}
        RETURNING *
      )
      SELECT t.*,
             r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name
      FROM updated t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
    `;

    const result = await query(sql, updateParams);
    const row = result.rows[0] || null;
    if (!row) return null;
    const [enriched] = await attachTagsToRows([row]);
    return enriched;
  },

  /**
   * Hard delete a transaction.
   */
  async hardDelete(id) {
    const result = await queryPrepared('tx_hard_delete', 'DELETE FROM transactions WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  // Recent active transactions not yet linked to any planned-transaction
  // execution. Feeds the match-suggestions read endpoint so already-cleared
  // transactions never resurface as candidates. Returns the cluster root so the
  // matcher can compare against planned-payment clusters directly.
  async listRecentUnlinked({ sinceDate }) {
    const result = await query(
      `SELECT t.id,
              t.recipient_id,
              COALESCE(r.primary_recipient_id, t.recipient_id) AS recipient_cluster_id,
              t.amount,
              t.date AS transaction_date,
              t.currency,
              t.memo,
              r.name AS recipient_name
         FROM transactions t
         LEFT JOIN recipients r ON t.recipient_id = r.id
        WHERE t.is_active = true
          AND t.recipient_id IS NOT NULL
          AND t.date >= $1
          AND NOT EXISTS (
            SELECT 1 FROM planned_transaction_executions pte
             WHERE pte.executed_transaction_id = t.id
          )
        ORDER BY t.date DESC, t.id DESC`,
      [sinceDate]
    );
    return result.rows;
  },
};

export default transactionRepository;
