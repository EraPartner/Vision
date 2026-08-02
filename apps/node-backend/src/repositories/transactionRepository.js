/**
 * Transaction Repository - data access for transactions table.
 *
 *
 * Performance notes:
 * - create() uses a CTE to INSERT and immediately JOIN in a single round-trip,
 *   eliminating the old INSERT RETURNING + separate getById pattern.
 * - getAllWithCount() uses COUNT(*) OVER () window function so pagination callers
 *   get rows and total count in one DB call instead of two.
 *
 * Row shapes are declared against the shared contracts in `src/types/rows.js`;
 * mind that `amount`/`balance` are pg NUMERIC (strings) and `date` is a `Date`.
 */

import { query, queryPrepared, withTransaction } from '../database/connection.js';
import { sanitizeUpdateFields } from '../middleware/validation.js';
import { buildTransactionWhere } from '../lib/filterBuilder.js';
import { buildSetClauses } from '../lib/sqlClauses.js';
import { accountRepository } from './accountRepository.js';

/**
 * ADR-088 UPDATE-path decouple, shared by this repo and
 * plannedTransactionRepository: when an update writes `bank_account`, resolve
 * the label to an account and stamp `account_id` into the same SET.
 *
 * Without this, an API edit to a first-seen label leaves a GHOST row — string
 * set, FK NULL/stale — because the 0062 sync trigger is deliberately
 * lookup-only on UPDATE (it never creates). Every flipped read then surfaces
 * the OLD account's name (the edit silently "reverts"), and the import dedup
 * probe, now keyed on account_id, mis-verdicts against the ghost in both
 * directions. Resolution uses the trigger's own lower(btrim) identity
 * (resolveOrCreateByName), so the trigger's UPDATE-time lookup lands on the
 * very account created here — the two writes cannot disagree. An accepted
 * blank/null label resolves to NULL, matching the trigger's blank-detach.
 * The string itself keeps being written too (pre-drop dual-write contract);
 * raw-SQL/DB-editor updates intentionally keep the 0062 lookup-only guard.
 *
 * Mutates and returns `sanitized`. Called AFTER sanitizeUpdateFields, so a
 * request body can never set account_id directly (it is not whitelisted).
 *
 * @param {Record<string, any>} sanitized output of sanitizeUpdateFields
 * @returns {Promise<Record<string, any>>}
 */
export async function stampAccountIdForUpdate(sanitized) {
  if (Object.hasOwn(sanitized, 'bank_account')) {
    sanitized.account_id =
      (await accountRepository.resolveOrCreateByName(sanitized.bank_account)) ?? null;
  }
  return sanitized;
}

/** @typedef {import('../types/rows.js').TransactionRow} TransactionRow */
/** @typedef {import('../types/rows.js').EnrichedTransactionRow} EnrichedTransactionRow */
/** @typedef {import('../types/rows.js').UnlinkedTransactionRow} UnlinkedTransactionRow */

/**
 * Filters shared by getAll / getCount / getAllWithCount / getUncategorised*.
 * Every field is optional; `null` means "not filtered".
 *
 * @typedef {object} TransactionFilters
 * @property {number|null} [transactionId]
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {string|null} [startDate] 'YYYY-MM-DD'
 * @property {string|null} [endDate] 'YYYY-MM-DD'
 * @property {number|null} [accountId]
 * @property {string|null} [bankAccount]
 * @property {number|null} [categoryId]
 * @property {number[]|null} [categoryIds]
 * @property {number|null} [recipientId]
 * @property {number|null} [recipientGroupId]
 * @property {string|null} [recipientName]
 * @property {string|null} [search]
 * @property {boolean} [active]
 * @property {string|null} [sortBy]
 * @property {'asc'|'desc'|null} [sortDir]
 * @property {boolean} [includeBalance]
 * @property {'income'|'expense'|null} [transactionType]
 * @property {number|null} [amountMin]
 * @property {number|null} [amountMax]
 * @property {boolean} [amountSigned]
 * @property {string[]|null} [tagSlugs]
 */

// Shared JOIN fragment used by every multi-join query.
// `acct` carries the canonical account label (ADR-088): read paths derive
// `bank_account` from accounts.name over the FK — see ACCOUNT_LABEL_SQL —
// so nothing here breaks when the retired string column is dropped
// (alembic/manual/contract_drop_bank_account).
const TRANSACTION_JOINS = `
  LEFT JOIN recipients r ON t.recipient_id = r.id
  LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
  LEFT JOIN categories c ON t.category_id = c.id
  LEFT JOIN categories rc ON r.default_category_id = rc.id
  LEFT JOIN categories pc ON pr.default_category_id = pc.id
  LEFT JOIN accounts acct ON t.account_id = acct.id
`;

// Wire-compat account label (ADR-088 contract phase). Selected AFTER `t.*` so
// the projected `bank_account` key resolves to accounts.name (node-postgres
// keeps the LAST duplicate field), which both survives the out-of-band column
// drop and stays byte-identical pre-drop under the dual-write parity
// invariant (sync trigger + rename propagation keep string == accounts.name).
const ACCOUNT_LABEL_SQL = 'acct.name AS bank_account';

// Effective category = own → recipient default → primary-recipient default
// (3-level, alias-aware). Requires TRANSACTION_JOINS. Shared so the single-row
// getById/create paths resolve categories identically to the list paths — an
// alias recipient must not show categorized in lists but uncategorized on GET.
const EFFECTIVE_CATEGORY_ID_SQL = 'COALESCE(t.category_id, r.default_category_id, pr.default_category_id)';
// Displayed name for exactly the category EFFECTIVE_CATEGORY_ID_SQL resolves,
// so the two can never denote different categories. The branch order therefore
// mirrors that COALESCE: own (c) → recipient default (rc) → primary-recipient
// default (pc). It used to test `pc` before `rc`, so an ALIAS recipient with its
// own default whose PRIMARY carried a different one reported the alias's
// category id next to the primary's category name — and the aggregation
// surfaces, which follow the id, then disagreed with this list's label.
// (The same CASE is inlined at the sort-column map and in getAll /
// getAllWithCount below; all four copies share this order.)
const CATEGORY_NAME_SQL = `CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
               ELSE NULL
             END`;
const RECIPIENT_NAME_SQL = 'COALESCE(pr.name, r.name)';

// Stamped-balance date range per account, keyed on the ORIGINAL account_id —
// the account-merge guard (§1 F2) must read this before the repoint.
const STAMP_RANGES_SQL = `
  SELECT account_id,
         to_char(MIN(date), 'YYYY-MM-DD') AS min_date,
         to_char(MAX(date), 'YYYY-MM-DD') AS max_date
  FROM transactions
  WHERE account_id = ANY($1::int[]) AND is_active = true AND balance IS NOT NULL
  GROUP BY account_id`;

// Opening-balance anchors per account, keyed on the ORIGINAL account_id — the
// account-merge collision guard must read this before the repoint. Not filtered
// on is_active: `ux_transactions_opening_anchor` is
// (account_id, currency) WHERE transfer_source = 'opening' with no is_active
// predicate, so a deactivated anchor still collides.
const OPENING_ANCHORS_SQL = `
  SELECT account_id, currency
  FROM transactions
  WHERE account_id = ANY($1::int[]) AND transfer_source = 'opening'`;

// Mark one leg of a transfer pair (SIMP-50). The `auto` variant guards against
// clobbering a concurrent manual mark or already-paired row; the `manual`
// variant is unconditional (the caller has already released prior peers).
const MARK_AUTO_LEG_SQL = `UPDATE transactions SET is_transfer = true, transfer_peer_id = $2, transfer_source = 'auto'
            WHERE id = $1 AND is_transfer = false AND transfer_source IS NULL`;
const MARK_MANUAL_LEG_SQL = `UPDATE transactions SET is_transfer = true, transfer_peer_id = $2, transfer_source = 'manual' WHERE id = $1`;
// Undo a leg WE just auto-marked (guarded on the peer we set + source='auto') so
// a half-applied pair is never committed when the sibling leg's guarded UPDATE misses.
const REVERT_AUTO_LEG_SQL = `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL
            WHERE id = $1 AND transfer_peer_id = $2 AND transfer_source = 'auto'`;

// Allowed sort columns for transactions (maps frontend key -> SQL expression)
/** @type {Record<string, string>} */
const TRANSACTION_SORT_COLUMNS = {
  date: 't.date',
  amount: 't.amount',
  memo: 't.memo',
  recipient: 'COALESCE(pr.name, r.name)',
  category: `CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
               ELSE NULL
             END`,
  bank: 'acct.name',
  currency: 't.currency',
};

/**
 * Attach the `tags` sub-collection to transaction rows in one extra round-trip.
 * Takes raw `result.rows` (pg is untyped, hence `any[]`) and narrows on the way out.
 *
 * @param {any[]} rows
 * @returns {Promise<EnrichedTransactionRow[]>}
 */
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

/**
 * Replace a transaction's tag junction rows inside the caller's transaction.
 *
 * @param {import('../types/rows.js').QueryRunner} client
 * @param {number} transactionId
 * @param {string[]|null|undefined} slugs
 * @returns {Promise<void>}
 */
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
   *
   * @param {TransactionFilters} [filters]
   * @returns {Promise<EnrichedTransactionRow[]>}
   */
  async getAll({
    transactionId = null,
    limit = 50,
    offset = 0,
    startDate = null,
    endDate = null,
    accountId = null,
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
      transactionId, startDate, endDate, accountId, bankAccount, categoryId, recipientId, recipientGroupId, recipientName, search, active, tagSlugs,
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

    // Partition by account_id (ADR-088): a running balance is a per-account ledger
    // figure. Without the partition, a list spanning multiple accounts summed
    // them into one meaningless cross-account total. account_id is the real
    // account identity (the bank_account string is being retired); it is kept in
    // sync on every write by the dual-write trigger (migration 0051). (The window
    // is evaluated over the full filtered set, before LIMIT/OFFSET, so the value
    // is still correct across pages.)
    const runningBalanceCol = includeBalance
      ? `, SUM(t.amount) OVER (PARTITION BY t.account_id ORDER BY t.date ASC, t.id ASC) AS running_balance`
      : '';

    const sql = `
      SELECT t.*,
             ${ACCOUNT_LABEL_SQL},
             COALESCE(pr.name, r.name) AS recipient_name,
             COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS effective_category_id,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
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
   *
   * @param {TransactionFilters} [filters]
   * @returns {Promise<number>} `COUNT(*)` arrives as a bigint string; parsed here.
   */
  async getCount({
    transactionId = null,
    startDate = null,
    endDate = null,
    accountId = null,
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
      transactionId, startDate, endDate, accountId, bankAccount, categoryId, recipientId, recipientGroupId, recipientName, search, active, tagSlugs,
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
   *
   * @param {TransactionFilters} [filters]
   * @returns {Promise<EnrichedTransactionRow[]>}
   */
  async getUncategorised({ limit = 50, offset = 0, startDate = null, endDate = null, accountId = null, bankAccount = null, recipientId = null, recipientName = null } = {}) {
    // "Uncategorised" means the full 3-level effective category is NULL — own
    // category, the recipient default, AND the primary-recipient default. Joining
    // pr (and using EFFECTIVE_CATEGORY_ID_SQL) stops alias-recipient rows whose
    // primary carries a category from wrongly appearing in the queue.
    let sql = `
      SELECT t.*,
             ${ACCOUNT_LABEL_SQL},
             r.name AS recipient_name,
             NULL AS category_name
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN accounts acct ON t.account_id = acct.id
      WHERE t.is_active = true
        AND ${EFFECTIVE_CATEGORY_ID_SQL} IS NULL
    `;
    const params = [];
    let paramIdx = 1;

    if (startDate) { sql += ` AND t.date >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND t.date <= $${paramIdx++}`; params.push(endDate); }
    if (accountId != null) { sql += ` AND t.account_id = $${paramIdx++}`; params.push(accountId); }
    // Bank filter via the FK (ADR-088) — matches the account's canonical name,
    // never the retired string column.
    if (bankAccount) { sql += ` AND t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name ILIKE $${paramIdx++})`; params.push(`%${bankAccount}%`); }
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
   *
   * @param {TransactionFilters} [filters]
   * @returns {Promise<{ rows: EnrichedTransactionRow[], total: number }>}
   */
  async getUncategorisedWithCount({
    transactionId = null,
    limit = 50,
    offset = 0,
    startDate = null,
    endDate = null,
    accountId = null,
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
      accountId,
      bankAccount,
      categoryId,
      recipientId,
      recipientName,
      search,
      active,
    });

    const params = [...totalParams];
    let paramIdx = totalNextParam;

    // Full 3-level effective-category IS NULL (see getUncategorised) — requires
    // the pr join added to the uncategorised_rows CTE below.
    let uncategorisedWhere = `
      t.is_active = true
      AND ${EFFECTIVE_CATEGORY_ID_SQL} IS NULL
    `;

    if (startDate) {
      uncategorisedWhere += ` AND t.date >= $${paramIdx++}`;
      params.push(startDate);
    }
    if (endDate) {
      uncategorisedWhere += ` AND t.date <= $${paramIdx++}`;
      params.push(endDate);
    }
    if (accountId != null) {
      uncategorisedWhere += ` AND t.account_id = $${paramIdx++}`;
      params.push(accountId);
    }
    if (bankAccount) {
      // Bank filter via the FK (ADR-088) — see getUncategorised.
      uncategorisedWhere += ` AND t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name ILIKE $${paramIdx++})`;
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
               ${ACCOUNT_LABEL_SQL},
               r.name AS recipient_name,
               NULL AS category_name
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
        LEFT JOIN accounts acct ON t.account_id = acct.id
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
      .filter((/** @type {any} */ row) => row.id != null)
      .map((/** @type {any} */ { total_count: _total_count, ...row }) => row);

    return { rows: await attachTagsToRows(rows), total };
  },

  /**
   * Get a single transaction by ID.
   *
   * @param {number} id
   * @returns {Promise<EnrichedTransactionRow|null>}
   */
  async getById(id) {
    const sql = `
      SELECT t.*,
             ${ACCOUNT_LABEL_SQL},
             ${RECIPIENT_NAME_SQL} AS recipient_name,
             ${EFFECTIVE_CATEGORY_ID_SQL} AS effective_category_id,
             ${CATEGORY_NAME_SQL} AS category_name
      FROM transactions t
      ${TRANSACTION_JOINS}
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
   *
   * @param {object} input
   * @param {string} input.transaction_date 'YYYY-MM-DD'
   * @param {string|null} [input.bank_account] Upper-cased before insert.
   * @param {number|null} [input.recipient_id]
   * @param {number|string} input.amount
   * @param {string|null} [input.memo] Upper-cased before insert.
   * @param {string|null} [input.currency] Defaults to 'EUR' (the column is NOT NULL — migration 0046).
   * @param {number|null} [input.category_id]
   * @param {string|null} [input.comment]
   * @param {string[]|null} [input.tags] `null` means "do not touch tags".
   * @returns {Promise<EnrichedTransactionRow|null>}
   */
  async create({ transaction_date, bank_account, recipient_id, amount, memo, currency, category_id, comment, tags = null }) {
    // `balance` is intentionally absent: manual transactions leave it NULL so the
    // account balance (ADR-094) only ever anchors on imported, bank-stamped rows.
    // The CSV import pipeline writes `balance` via its own INSERT (commit.js).
    const sql = `
      WITH inserted AS (
        INSERT INTO transactions (date, bank_account, recipient_id, amount, memo, currency, category_id, comment, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
        RETURNING *
      )
      SELECT t.*,
             ${ACCOUNT_LABEL_SQL},
             ${RECIPIENT_NAME_SQL} AS recipient_name,
             ${EFFECTIVE_CATEGORY_ID_SQL} AS effective_category_id,
             ${CATEGORY_NAME_SQL} AS category_name
      FROM inserted t
      ${TRANSACTION_JOINS}
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
   * @param {TransactionFilters} [filters]
   * @returns {Promise<{ rows: EnrichedTransactionRow[], total: number }>} `total` is `COUNT(*)::int`, a real number.
   */
  async getAllWithCount({
    transactionId = null,
    limit = 50,
    offset = 0,
    startDate = null,
    endDate = null,
    accountId = null,
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
    amountMin = null,
    amountMax = null,
    amountSigned = false,
    tagSlugs = null,
  } = {}) {
    const { sql: where, params, nextParamIdx: p } = buildTransactionWhere({
      transactionId, startDate, endDate, accountId, bankAccount, categoryId, categoryIds, recipientId, recipientGroupId, recipientName, search, active, transactionType, amountMin, amountMax, amountSigned, tagSlugs,
    });

    const sortCol = TRANSACTION_SORT_COLUMNS[sortBy] || 't.date';
    const sortDirection = sortDir === 'asc' ? 'ASC' : 'DESC';
    // t.id DESC is the unique final tiebreaker — without it LIMIT/OFFSET pages
    // can duplicate or skip same-date rows across separate query executions.
    const orderBy = sortBy && TRANSACTION_SORT_COLUMNS[sortBy]
      ? `${sortCol} ${sortDirection}, t.date DESC, t.id DESC`
      : `t.date DESC, t.id DESC`;

    // Partition by account_id (ADR-088) — see getAll for the rationale; account_id
    // is kept in sync with bank_account by the dual-write trigger (migration 0051).
    const runningBalanceCol = includeBalance
      ? `, SUM(t.amount) OVER (PARTITION BY t.account_id ORDER BY t.date ASC, t.id ASC) AS running_balance`
      : '';

    // Count as a SEPARATE query rather than `COUNT(*) OVER ()`: the window
    // function forced the planner to fully materialize + sort the whole filtered
    // 6-way join before LIMIT on every page (paid even on the unfiltered page-1
    // default with include_balance=false). Splitting it lets the data query
    // pipeline and stop at LIMIT (Nested-Loop + Memoize top-N), while the count
    // runs without the wide projection/sort/window. The `total` returned is
    // byte-identical to the old window count — same WHERE, same joins.
    const dataSql = `
      SELECT t.*,
             ${ACCOUNT_LABEL_SQL},
             COALESCE(pr.name, r.name) AS recipient_name,
             COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS effective_category_id,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
               ELSE NULL
             END AS category_name${runningBalanceCol}
      FROM transactions t
      ${TRANSACTION_JOINS}
      WHERE ${where}
      ORDER BY ${orderBy} LIMIT $${p} OFFSET $${p + 1}
    `;
    const countSql = `SELECT COUNT(*)::int AS total FROM transactions t ${TRANSACTION_JOINS} WHERE ${where}`;

    const dataParams = [...params, limit, offset];
    const [result, countResult] = await Promise.all([
      query(dataSql, dataParams),
      query(countSql, params),
    ]);
    const total = countResult.rows[0]?.total ?? 0;
    return { rows: await attachTagsToRows(result.rows), total };
  },

  /**
   * Update a transaction.
   * When `tags` is present in fields, junction rows are replaced atomically.
   * When `tags` is absent, existing tags are untouched.
   *
   * @param {number} id
   * @param {Record<string, any> & { tags?: string[] }} fields
   * @returns {Promise<EnrichedTransactionRow|null>}
   */
  async update(id, fields) {
    const { tags, ...txFields } = fields;
    // Sanitize field names to prevent SQL injection via column names
    const sanitized = sanitizeUpdateFields('transactions', txFields);
    // A bank_account edit also writes the resolved FK (ADR-088 — see
    // stampAccountIdForUpdate). Resolution happens before the row UPDATE, so
    // an edit against a missing id can mint the account without applying the
    // field change — harmless (same account the retried PATCH will then use).
    await stampAccountIdForUpdate(sanitized);
    // Map frontend field names to DB columns (transaction_date → date)
    const { clauses: setClauses, params: updateParams, nextIdx: paramIdx } = buildSetClauses(sanitized, {
      quote: true,
      mapColumn: (key) => (key === 'transaction_date' ? 'date' : key),
    });

    // Same 3-level enrichment as getById/getAll/create (shared fragments): the
    // update response must not disagree with an immediately-following GET on
    // alias-recipient rows categorised via their primary's default.
    const fetchSql = `
      SELECT t.*,
             ${ACCOUNT_LABEL_SQL},
             ${RECIPIENT_NAME_SQL} AS recipient_name,
             ${EFFECTIVE_CATEGORY_ID_SQL} AS effective_category_id,
             ${CATEGORY_NAME_SQL} AS category_name
      FROM transactions t
      ${TRANSACTION_JOINS}
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
             ${ACCOUNT_LABEL_SQL},
             ${RECIPIENT_NAME_SQL} AS recipient_name,
             ${EFFECTIVE_CATEGORY_ID_SQL} AS effective_category_id,
             ${CATEGORY_NAME_SQL} AS category_name
      FROM updated t
      ${TRANSACTION_JOINS}
    `;

    const result = await query(sql, updateParams);
    const row = result.rows[0] || null;
    if (!row) return null;
    const [enriched] = await attachTagsToRows([row]);
    return enriched;
  },

  /**
   * Hard delete a transaction.
   *
   * @param {number} id
   * @returns {Promise<boolean>} true when a row was removed
   */
  async hardDelete(id) {
    const result = await queryPrepared('tx_hard_delete', 'DELETE FROM transactions WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  // Recent active transactions not yet linked to any planned-transaction
  // execution. Feeds the match-suggestions read endpoint so already-cleared
  // transactions never resurface as candidates. Returns the cluster root so the
  // matcher can compare against planned-payment clusters directly.
  /**
   * @param {{ sinceDate: string }} args `sinceDate` is a 'YYYY-MM-DD' lower bound
   * @returns {Promise<UnlinkedTransactionRow[]>}
   */
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

  // ---------------------------------------------------------------------------
  // Account / recipient merge repoints (ADR-088, ADR-014)
  //
  // Composed by the merge services inside withTransaction; the ambient context
  // routes these onto the transaction's client, so the repoints share the
  // merge's FOR UPDATE locks and roll back with it.
  // ---------------------------------------------------------------------------

  /**
   * Stamped-balance date range per account. Run BEFORE an account-merge repoint,
   * while rows still carry their original account_id — the repoint erases that
   * provenance. Backs the overlapping-stamp guard (§1 F2).
   * `min_date`/`max_date` are `to_char`-formatted, so calendar-day strings.
   *
   * @param {number[]} accountIds
   * @returns {Promise<{account_id:number,min_date:string,max_date:string}[]>}
   */
  async getStampedDateRangesByAccount(accountIds) {
    const result = await query(STAMP_RANGES_SQL, [accountIds]);
    return result.rows;
  },

  /**
   * Opening-balance anchors (`transfer_source = 'opening'`) per account. Run
   * BEFORE an account-merge repoint, for the same reason as
   * {@link getStampedDateRangesByAccount}: the repoint erases the provenance
   * this guard needs — and, since the repoint moves every anchor onto the
   * survivor, it is also what would violate `ux_transactions_opening_anchor`.
   *
   * @param {number[]} accountIds
   * @returns {Promise<{account_id:number,currency:string}[]>}
   */
  async getOpeningAnchorsByAccount(accountIds) {
    const result = await query(OPENING_ANCHORS_SQL, [accountIds]);
    return result.rows;
  },

  /**
   * Repoint transactions off merged-away source accounts onto the survivor.
   * Also stamps `bank_account` with the survivor's name so the dual-write
   * trigger (migration 0051) keeps account_id at the target and a later edit
   * can't re-resolve the old name into a fresh account (un-merge).
   *
   * @param {number} targetId
   * @param {string} targetName
   * @param {number[]} sourceIds
   * @returns {Promise<number>} rows repointed
   */
  async repointAccount(targetId, targetName, sourceIds) {
    const result = await query(
      `UPDATE transactions SET account_id = $1, bank_account = $2 WHERE account_id = ANY($3::int[])`,
      [targetId, targetName, sourceIds],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Repoint transactions off merged alias recipients onto the primary.
   *
   * @param {number} primaryId
   * @param {number[]} aliasIds
   * @returns {Promise<number>} rows repointed
   */
  async repointRecipient(primaryId, aliasIds) {
    const result = await query(
      `UPDATE transactions
          SET recipient_id = $1
        WHERE recipient_id = ANY($2::int[])`,
      [primaryId, aliasIds],
    );
    return result.rowCount ?? 0;
  },

  // ---------------------------------------------------------------------------
  // Internal-transfer reconciliation (ADR-083)
  // ---------------------------------------------------------------------------

  /**
   * Candidate (outflow, inflow) pairs among open rows: equal-and-opposite
   * amount, same currency, two different own accounts, within ±windowDays.
   * Fixing the outflow side (amount < 0) yields each pair exactly once. Uses the
   * (amount, date) index added in migration 0044. Pairs the user explicitly
   * rejected (transfer_dismissals, migration 0070) are excluded — the PAIR, not
   * the rows: each leg stays matchable with every other candidate.
   *
   * @param {number} windowDays
   * @returns {Promise<{ outId: number, inId: number }[]>}
   */
  async listTransferCandidatePairs(windowDays) {
    const { rows } = await query(
      `SELECT a.id AS "outId", b.id AS "inId"
       FROM transactions a
       JOIN transactions b
         ON b.amount = -a.amount
        AND COALESCE(b.currency, 'EUR') = COALESCE(a.currency, 'EUR')
        AND b.account_id IS DISTINCT FROM a.account_id
        AND a.account_id IS NOT NULL AND b.account_id IS NOT NULL
        AND b.date BETWEEN a.date - $1::int AND a.date + $1::int
      WHERE a.is_active AND b.is_active
        AND a.is_transfer = false AND b.is_transfer = false
        AND a.transfer_source IS NULL AND b.transfer_source IS NULL
        AND a.amount < 0
        AND NOT EXISTS (
          SELECT 1 FROM transfer_dismissals d
           WHERE d.txn_a_id = LEAST(a.id, b.id)
             AND d.txn_b_id = GREATEST(a.id, b.id)
        )`,
      [windowDays],
    );
    return rows;
  },

  /**
   * Release transfers whose peer was deleted (the FK set transfer_peer_id NULL).
   * Only reconciler-owned rows ('auto'/'manual'): system rows — opening anchors,
   * reconcile adjustments, trade cash legs — are also is_transfer=true with a
   * NULL peer but are NOT reconciler pairs.
   */
  async releaseOrphanedTransfers() {
    await query(
      `UPDATE transactions
        SET is_transfer = false, transfer_source = NULL
      WHERE is_transfer = true AND transfer_peer_id IS NULL
        AND transfer_source IN ('auto', 'manual')`,
    );
  },

  /**
   * Release auto-pairs whose legs no longer satisfy the match rule (e.g. an
   * amount or date was edited). The predicate is symmetric, so both legs of a
   * now-invalid pair qualify and are released together.
   *
   * @param {number} windowDays
   * @returns {Promise<void>}
   */
  async releaseInvalidAutoTransferPairs(windowDays) {
    await query(
      `UPDATE transactions t
        SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL
      WHERE t.transfer_source = 'auto' AND t.transfer_peer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM transactions p
           WHERE p.id = t.transfer_peer_id
             -- Reciprocity: the peer must still point back at t. Without this,
             -- when markTransfer re-points one leg elsewhere the stranded auto
             -- leg stayed is_transfer=true forever (a phantom one-way transfer,
             -- excluded from cash-flow aggregates).
             AND p.transfer_peer_id = t.id
             AND p.amount = -t.amount
             AND COALESCE(p.currency, 'EUR') = COALESCE(t.currency, 'EUR')
             AND p.account_id IS DISTINCT FROM t.account_id
             AND p.account_id IS NOT NULL AND t.account_id IS NOT NULL
             AND p.date BETWEEN t.date - $1::int AND t.date + $1::int
             AND p.is_active AND t.is_active
        )`,
      [windowDays],
    );
  },

  /**
   * Display rows for the ambiguous-match suggestions endpoint.
   *
   * @param {number[]} ids
   * @returns {Promise<Pick<TransactionRow, 'id'|'date'|'amount'|'currency'|'bank_account'|'memo'|'recipient_id'>[]>}
   */
  async listTransferSuggestionRows(ids) {
    // bank_account is derived from accounts.name over the FK (ADR-088) so the
    // display label survives the out-of-band drop of the string column.
    const { rows } = await query(
      `SELECT t.id, t.date, t.amount, t.currency, acct.name AS bank_account, t.memo, t.recipient_id
       FROM transactions t
       LEFT JOIN accounts acct ON t.account_id = acct.id
       WHERE t.id = ANY($1)`,
      [ids],
    );
    return rows;
  },

  /**
   * Mark one leg of an auto-detected pair. Guarded against clobbering a
   * concurrent manual mark or an already-paired row; returns rows affected so
   * the caller can detect a half-applied pair.
   *
   * @param {number} id
   * @param {number} peerId
   * @returns {Promise<number>} rows affected (0 when the guard rejected the mark)
   */
  async markAutoTransferLeg(id, peerId) {
    const result = await query(MARK_AUTO_LEG_SQL, [id, peerId]);
    return result.rowCount ?? 0;
  },

  /**
   * Mark one leg of a manual pair (unconditional — caller released prior peers).
   *
   * @param {number} id
   * @param {number} peerId
   * @returns {Promise<number>} rows affected
   */
  async markManualTransferLeg(id, peerId) {
    const result = await query(MARK_MANUAL_LEG_SQL, [id, peerId]);
    return result.rowCount ?? 0;
  },

  /**
   * Undo a leg WE just auto-marked (guarded on the peer we set + source='auto')
   * so a half-applied pair is never committed when the sibling leg's guarded
   * UPDATE misses.
   *
   * @param {number} id
   * @param {number} peerId
   * @returns {Promise<number>} rows affected
   */
  async revertAutoTransferLeg(id, peerId) {
    const result = await query(REVERT_AUTO_LEG_SQL, [id, peerId]);
    return result.rowCount ?? 0;
  },

  /**
   * Lock both legs of a manual mark and read what markTransfer validates.
   *
   * @param {number[]} ids
   * @returns {Promise<Pick<TransactionRow, 'id'|'amount'|'account_id'|'is_active'>[]>}
   */
  async lockTransferLegs(ids) {
    const { rows } = await query(
      `SELECT id, amount, account_id, is_active FROM transactions WHERE id = ANY($1) FOR UPDATE`,
      [ids],
    );
    return rows;
  },

  /**
   * Release any existing peer of the given legs before re-pairing them, so a
   * prior counterpart isn't stranded as a phantom one-way transfer. The
   * stranded peer goes back to open (NULL), not dismissed.
   *
   * @param {number[]} ids
   * @returns {Promise<number>} rows released
   */
  async releaseTransferPeersOf(ids) {
    const result = await query(
      `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL
        WHERE transfer_peer_id = ANY($1) AND id <> ALL($1)`,
      [ids],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Lock a row and read its peer pointer (unmarkTransfer's reciprocity check).
   *
   * @param {number} id
   * @returns {Promise<number|undefined>} the peer id; `undefined` when the row is gone OR unpaired (the `?? undefined` collapses both)
   */
  async lockTransferPeerPointer(id) {
    const { rows } = await query(
      'SELECT transfer_peer_id FROM transactions WHERE id = $1 FOR UPDATE',
      [id],
    );
    return rows[0]?.transfer_peer_id ?? undefined;
  },

  /**
   * Record a rejected pairing (sticky, per-pair — migration 0070).
   *
   * @param {number} aId
   * @param {number} bId
   * @returns {Promise<void>}
   */
  async insertTransferDismissal(aId, bId) {
    await query(
      `INSERT INTO transfer_dismissals (txn_a_id, txn_b_id)
         VALUES (LEAST($1::int, $2::int), GREATEST($1::int, $2::int))
         ON CONFLICT DO NOTHING`,
      [aId, bId],
    );
  },

  /**
   * Reset a single leg back to open.
   *
   * @param {number} id
   * @returns {Promise<number>} rows affected
   */
  async clearTransferMark(id) {
    const result = await query(
      `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL WHERE id = $1`,
      [id],
    );
    return result.rowCount ?? 0;
  },

  // ---------------------------------------------------------------------------
  // Import commit (import-specific — deliberately NOT create()/getById())
  // ---------------------------------------------------------------------------

  /**
   * Field-based duplicate probe for the import commit path: date + amount +
   * recipient + memo + currency, scoped to the same account, and skipped when
   * both rows carry a tx_hash and the hashes DIFFER within this batch (the hash
   * is the identity then). See commit.js for the full rationale — the predicate
   * is load-bearing for import idempotency and is moved here verbatim.
   *
   * Currency is part of the identity because an account may hold several
   * currencies (ADR-089 addendum: Revolut keeps ONE account whose rows carry
   * their own currency), so the account no longer discriminates them the way
   * it does for the one-account-per-currency banks. −25.00 EUR and −25.00 USD at
   * the same merchant on the same day are two transactions, not one.
   *
   * The "same account" guard compares `t.account_id` (ADR-088): the caller
   * resolves the staging label to an account id (commit.js, the same
   * lower(btrim) mapping the sync trigger uses) and the probe never touches
   * the retired bank_account string.
   *
   * @param {object} probe
   * @param {string} probe.date 'YYYY-MM-DD'
   * @param {number|string} probe.amount
   * @param {number|null} probe.recipientId
   * @param {string} probe.memo Already TRIM'd by the caller (compared to `COALESCE(TRIM(t.memo), '')`).
   * @param {number|null} probe.accountId Resolved account id of the staging row's label (null when the row carries no label).
   * @param {string} probe.currency Already trimmed and defaulted by the caller
   *   (commit.js `currencyKeyOf`) to the same value the insert will store —
   *   trimmed because VARCHAR(3) silently drops trailing spaces on write, so an
   *   untrimmed probe would miss the stored row. `transactions.currency` is
   *   NOT NULL, so plain `=` is safe.
   * @param {string|null} probe.txHash
   * @param {number|string} probe.batchId
   * @returns {Promise<number|undefined>} the duplicate's id, or undefined
   */
  async findImportDuplicate({ date, amount, recipientId, memo, accountId, currency, txHash, batchId }) {
    const result = await query(
      `SELECT t.id
             FROM transactions t
            WHERE t.date = $1
              AND t.amount = $2
              AND (
                ($3::integer IS NOT NULL AND t.recipient_id = $3)
                OR ($3::integer IS NULL AND t.recipient_id IS NULL)
              )
              AND COALESCE(TRIM(t.memo), '') = $4
              AND t.account_id IS NOT DISTINCT FROM $5::integer
              AND t.currency = $8
              AND NOT (t.import_batch_id = $7 AND t.tx_hash IS NOT NULL AND $6::text IS NOT NULL AND t.tx_hash <> $6)
              AND t.is_active = true
            LIMIT 1`,
      [date, amount, recipientId, memo, accountId, txHash, batchId, currency],
    );
    return result.rows[0]?.id ?? undefined;
  },

  /**
   * Insert a committed import row. Distinct from create(): the import writes
   * `balance` (bank-stamped, anchors ADR-094), `import_batch_id`,
   * `matched_pattern_id` and `tx_hash`, and relies on ON CONFLICT over the
   * partial unique index on tx_hash to stay race-safe against a concurrent
   * import. A conflict yields no row.
   *
   * Dual-write contract (ADR-088, pre-drop): BOTH the label string and the
   * resolved `account_id` are written. The 0051/0083 sync trigger derives
   * account_id FROM bank_account on INSERT, so the string must keep flowing
   * until the out-of-band contract drop; the explicit account_id write is the
   * decoupled half (the trigger re-resolves to the same id — commit.js
   * resolves with the trigger's own lower(btrim) mapping).
   *
   * @param {object} row
   * @param {string} row.date 'YYYY-MM-DD'
   * @param {string|null} row.bankAccount
   * @param {number|null} row.accountId Resolved account id for the label (commit.js).
   * @param {number|null} row.recipientId
   * @param {number|null} row.categoryId
   * @param {number|string} row.amount
   * @param {string|null} row.memo
   * @param {string|null} row.currency
   * @param {number|string|null} row.balance Bank-stamped running balance (anchors ADR-094).
   * @param {string|null} row.comment
   * @param {number|string|null} row.importBatchId
   * @param {number|null} row.matchedPatternId
   * @param {string|null} row.txHash
   * @returns {Promise<number|undefined>} inserted id, or undefined on conflict
   */
  async insertImportedRow({ date, bankAccount, accountId, recipientId, categoryId, amount, memo, currency, balance, comment, importBatchId, matchedPatternId, txHash }) {
    const result = await query(
      `INSERT INTO transactions
                (date, bank_account, account_id, recipient_id, category_id, amount, memo, currency, balance, comment,
                 import_batch_id, matched_pattern_id, tx_hash, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
             ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO NOTHING
             RETURNING id`,
      [date, bankAccount, accountId ?? null, recipientId, categoryId, amount, memo, currency, balance, comment, importBatchId, matchedPatternId, txHash],
    );
    return result.rows[0]?.id ?? undefined;
  },
};

export default transactionRepository;
