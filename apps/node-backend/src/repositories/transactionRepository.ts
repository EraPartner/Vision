/**
 * Transaction Repository - data access for transactions table.
 *
 *
 * Performance notes:
 * - create() uses a CTE to INSERT and immediately JOIN in a single round-trip,
 *   eliminating the old INSERT RETURNING + separate getById pattern.
 * - getAllWithCount() keeps the row query pipelined under LIMIT and briefly
 *   caches the separate filtered count across page requests.
 *
 * Row shapes are declared against the shared contracts in `src/types/rows.ts`;
 * mind that `amount`/`balance` are pg NUMERIC (strings) and `date` is a `Date`.
 */

import {
  query,
  queryPrepared,
  withTransaction,
} from "../database/connection.ts";
import { sanitizeUpdateFields } from "../lib/validation.ts";
import { buildTransactionWhere } from "../lib/filterBuilder.ts";
import { buildSetClauses } from "../lib/sqlClauses.ts";
import { accountRepository } from "./accountRepository.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import type {
  EnrichedTransactionRow,
  QueryRunner,
  TransactionRow,
  TransactionTagRef,
  UnlinkedTransactionRow,
} from "../types/rows.ts";

/**
 * Validate canonical account identity before dynamic SET clauses are built.
 * A stray legacy label is discarded and never reaches persistence.
 *
 * Mutates and returns `sanitized`. Called after sanitizeUpdateFields, which
 * admits the canonical account_id only.
 *
 * @param sanitized output of sanitizeUpdateFields
 */
export async function stampAccountIdForUpdate(
  sanitized: Record<string, unknown>,
  client?: QueryRunner,
): Promise<Record<string, unknown>> {
  if (Object.hasOwn(sanitized, "account_id")) {
    if (
      sanitized.account_id != null &&
      !(await accountRepository.findActiveId(sanitized.account_id, { client }))
    ) {
      throw new ValidationError("account_id must reference an active account");
    }
  }
  delete sanitized.bank_account;
  return sanitized;
}

export type { TransactionRow, EnrichedTransactionRow, UnlinkedTransactionRow };

/** A list/detail projection row before `attachTagsToRows` adds `tags`. */
type EnrichedTransactionDbRow = Omit<EnrichedTransactionRow, "tags">;

/** The `create()` payload. */
export interface TransactionCreateInput {
  /** 'YYYY-MM-DD' */
  transaction_date: string;
  /** Canonical account identity. */
  account_id?: number | null;
  recipient_id?: number | null;
  amount: number | string;
  /** Upper-cased before insert. */
  memo?: string | null;
  /** Defaults to 'EUR' (the column is NOT NULL — migration 0046). */
  currency?: string | null;
  category_id?: number | null;
  comment?: string | null;
  /** `null` means "do not touch tags". */
  tags?: string[] | null;
}

/** The `insertImportedRow()` payload. */
export interface ImportedTransactionInput {
  /** 'YYYY-MM-DD' */
  date: string;
  /** Resolved account id for the label (commit.js). */
  accountId: number | null;
  recipientId: number | null;
  categoryId: number | null;
  amount: number | string;
  memo: string | null;
  currency: string | null;
  /** Bank-stamped running balance (anchors ADR-094). */
  balance: number | string | null;
  comment: string | null;
  importBatchId: number | string | null;
  matchedPatternId: number | null;
  sourceRecordHash?: string | null;
  dedupFingerprint?: string | null;
  fingerprintVersion?: number | null;
}

/**
 * Filters shared by getAll / getCount / getAllWithCount / getUncategorised*.
 * Every field is optional; `null` means "not filtered".
 */
export interface TransactionFilters {
  transactionId?: number | null;
  limit?: number;
  offset?: number;
  /** 'YYYY-MM-DD' */
  startDate?: string | null;
  /** 'YYYY-MM-DD' */
  endDate?: string | null;
  accountId?: number | null;
  bankAccount?: string | null;
  categoryId?: number | null;
  categoryIds?: number[] | null;
  recipientId?: number | null;
  recipientGroupId?: number | null;
  recipientName?: string | null;
  search?: string | null;
  active?: boolean;
  sortBy?: string | null;
  sortDir?: "asc" | "desc" | null;
  includeBalance?: boolean;
  transactionType?: "income" | "expense" | null;
  amountMin?: number | null;
  amountMax?: number | null;
  amountSigned?: boolean;
  tagSlugs?: string[] | null;
}

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
const ACCOUNT_LABEL_SQL = "acct.name AS bank_account";

// Reduced join set for count-only queries over a buildTransactionWhere clause.
// `r` is the sole join alias that builder's predicates reference (recipientName's
// `r.name ILIKE`); the other five aliases in TRANSACTION_JOINS exist purely to
// project labels, which a count does not select. Dropping them cannot change
// count(*): all six are LEFT JOINs onto the target's PRIMARY KEY (recipients.id,
// categories.id, accounts.id), so each matches at most one row and none can drop
// or duplicate a transaction. Keeping `r` means a filter that DOES reference an
// unjoined alias fails loudly at the database rather than silently miscounting.
const COUNT_JOINS = `
  LEFT JOIN recipients r ON t.recipient_id = r.id
`;

/** A `listTransferSuggestionRows` display row. */
export type TransferSuggestionRow = Pick<
  TransactionRow,
  | "id"
  | "date"
  | "amount"
  | "currency"
  | "bank_account"
  | "memo"
  | "recipient_id"
>;

const COUNT_CACHE_TTL_MS = 2_000;
const COUNT_CACHE_MAX_ENTRIES = 100;
const transactionCountCache = new Map<
  string,
  { expiresAt: number; pending: boolean; promise: Promise<number> }
>();

/** Clear cached filtered transaction counts after a transaction mutation. */
export function clearTransactionCountCache(): void {
  transactionCountCache.clear();
}

function getCachedTransactionCount(
  sql: string,
  params: unknown[],
): Promise<number> {
  const now = Date.now();
  const key = JSON.stringify([sql, params]);
  const cached = transactionCountCache.get(key);
  // A pending full count remains the single-flight authority regardless of
  // how long PostgreSQL needs. The short TTL starts only after it resolves.
  if (cached && (cached.pending || cached.expiresAt > now)) {
    return cached.promise;
  }
  if (cached) transactionCountCache.delete(key);

  for (const [cacheKey, entry] of transactionCountCache) {
    if (!entry.pending && entry.expiresAt <= now) {
      transactionCountCache.delete(cacheKey);
    }
  }
  if (transactionCountCache.size >= COUNT_CACHE_MAX_ENTRIES) {
    const resolvedKey = [...transactionCountCache].find(
      ([, entry]) => !entry.pending,
    )?.[0];
    if (resolvedKey) transactionCountCache.delete(resolvedKey);
  }

  const promise: Promise<number> = query<{ total: number }>(sql, params)
    .then((result) => {
      const entry = transactionCountCache.get(key);
      if (entry?.promise === promise) {
        entry.pending = false;
        entry.expiresAt = Date.now() + COUNT_CACHE_TTL_MS;
      }
      return result.rows[0]?.total ?? 0;
    })
    .catch((err) => {
      if (transactionCountCache.get(key)?.promise === promise) {
        transactionCountCache.delete(key);
      }
      throw err;
    });
  transactionCountCache.set(key, {
    expiresAt: Number.POSITIVE_INFINITY,
    pending: true,
    promise,
  });
  return promise;
}

// Effective category = own → recipient default → primary-recipient default
// (3-level, alias-aware). Requires TRANSACTION_JOINS. Shared so the single-row
// getById/create paths resolve categories identically to the list paths — an
// alias recipient must not show categorized in lists but uncategorized on GET.
const EFFECTIVE_CATEGORY_ID_SQL =
  "COALESCE(t.category_id, r.default_category_id, pr.default_category_id)";
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
               WHEN c.id IS NOT NULL THEN c.path_name
               WHEN rc.id IS NOT NULL THEN rc.path_name
               WHEN pc.id IS NOT NULL THEN pc.path_name
               ELSE NULL
             END`;
const RECIPIENT_NAME_SQL = "COALESCE(pr.name, r.name)";

/** Carry stamped balances over the same filtered rows used by the list. */
function runningBalanceCtes(where: string, joins: string): string {
  // Same identity as accountBalanceSql's daily series: cumulative amount plus
  // the latest stamp's (balance - cumulative amount). A zero-amount opening
  // row resets the balance, and later unstamped rows advance it normally.
  return `
    ledger_amounts AS (
      SELECT t.id, t.date, t.account_id,
             COALESCE(t.currency, 'EUR') AS currency, t.balance,
             SUM(t.amount) OVER (PARTITION BY t.account_id, COALESCE(t.currency, 'EUR') ORDER BY t.date ASC, t.id ASC) AS cumulative
      FROM transactions t
      ${joins}
      WHERE ${where}
    ),
    ledger_carry AS (
      SELECT id, cumulative,
             MAX(CASE WHEN balance IS NOT NULL
                      THEN ARRAY[(date - DATE '2000-01-01')::numeric, id::numeric, balance - cumulative]
                 END) OVER (PARTITION BY account_id, currency ORDER BY date ASC, id ASC) AS stamp
      FROM ledger_amounts
    ),
    ledger_balances AS (
      SELECT id, cumulative + COALESCE(stamp[3], 0) AS running_balance
      FROM ledger_carry
    )`;
}

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
// on is_active: `uq_transactions_opening_anchor` is
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
const TRANSACTION_SORT_COLUMNS: Record<string, string> = {
  date: "t.date",
  amount: "t.amount",
  memo: "t.memo",
  recipient: "COALESCE(pr.name, r.name)",
  category: `CASE
               WHEN c.id IS NOT NULL THEN c.path_name
               WHEN rc.id IS NOT NULL THEN rc.path_name
               WHEN pc.id IS NOT NULL THEN pc.path_name
               ELSE NULL
             END`,
  bank: "acct.name",
  currency: "t.currency",
};

/**
 * Attach the `tags` sub-collection to transaction rows in one extra round-trip,
 * dropping the internal import-identity columns on the way out.
 */
async function attachTagsToRows(
  rows: EnrichedTransactionDbRow[],
): Promise<EnrichedTransactionRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const result = await query<TransactionTagRef & { transaction_id: number }>(
    `SELECT tt.transaction_id, tg.id, tg.slug, tg.color, tg.is_active
     FROM transaction_tags tt
     JOIN tags tg ON tg.id = tt.tag_id
     WHERE tt.transaction_id = ANY($1::int[])`,
    [ids],
  );
  const tagMap = new Map<number, TransactionTagRef[]>();
  for (const row of result.rows) {
    const list = tagMap.get(row.transaction_id) ?? [];
    list.push({
      id: row.id,
      slug: row.slug,
      color: row.color,
      is_active: row.is_active,
    });
    tagMap.set(row.transaction_id, list);
  }
  return rows.map(
    ({
      source_record_hash: _sourceRecordHash,
      dedup_fingerprint: _dedupFingerprint,
      dedup_fingerprint_version: _dedupFingerprintVersion,
      ...r
    }) => ({ ...r, tags: tagMap.get(r.id) ?? [] }),
  );
}

/**
 * Replace a transaction's tag junction rows inside the caller's transaction.
 */
async function setTransactionTags(
  client: QueryRunner,
  transactionId: number,
  slugs: string[] | null | undefined,
): Promise<void> {
  await client.query("DELETE FROM transaction_tags WHERE transaction_id = $1", [
    transactionId,
  ]);
  if (!slugs || slugs.length === 0) return;
  const resolved = await client.query(
    "SELECT id FROM tags WHERE slug = ANY($1::text[]) AND is_active = true",
    [slugs],
  );
  if (resolved.rows.length === 0) return;
  const tagIds = resolved.rows.map((r: { id: number }) => r.id);
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
  }: TransactionFilters = {}): Promise<EnrichedTransactionRow[]> {
    const {
      sql: where,
      params,
      nextParamIdx: p,
    } = buildTransactionWhere({
      transactionId,
      startDate,
      endDate,
      accountId,
      bankAccount,
      categoryId,
      recipientId,
      recipientGroupId,
      recipientName,
      search,
      active,
      tagSlugs,
    });

    // Build ORDER BY — fall back to default date DESC when no valid sort supplied
    // (String(): the old untyped lookup coerced a null sortBy the same way).
    const sortCol = TRANSACTION_SORT_COLUMNS[String(sortBy)] || "t.date";
    const sortDirection = sortDir === "asc" ? "ASC" : "DESC";
    // Secondary sort by date DESC keeps rows stable when primary column has
    // ties; t.id DESC is the unique final tiebreaker so LIMIT/OFFSET pages can't
    // duplicate or skip same-date rows across separate query executions.
    const orderBy =
      sortBy && TRANSACTION_SORT_COLUMNS[sortBy]
        ? `${sortCol} ${sortDirection}, t.date DESC, t.id DESC`
        : `t.date DESC, t.id DESC`;

    // Partition by account and currency: adding unlike currencies is never a
    // meaningful ledger balance. The window is evaluated over the full filtered
    // set, before LIMIT/OFFSET, so each currency balance stays correct across
    // pages. Legacy NULL currency rows are treated as EUR consistently with the
    // rest of the transaction API.
    const runningBalanceCol = includeBalance ? ", lb.running_balance" : "";

    const sql = `
      ${includeBalance ? `WITH ${runningBalanceCtes(where, TRANSACTION_JOINS)}` : ""}
      SELECT t.*,
             ${ACCOUNT_LABEL_SQL},
             COALESCE(pr.name, r.name) AS recipient_name,
             COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS effective_category_id,
             CASE
               WHEN c.id IS NOT NULL THEN c.path_name
               WHEN rc.id IS NOT NULL THEN rc.path_name
               WHEN pc.id IS NOT NULL THEN pc.path_name
               ELSE NULL
             END AS category_name${runningBalanceCol}
      FROM transactions t
      ${TRANSACTION_JOINS}
      ${includeBalance ? "JOIN ledger_balances lb ON lb.id = t.id" : ""}
      WHERE ${where}
      ORDER BY ${orderBy} LIMIT $${p} OFFSET $${p + 1}
    `;
    params.push(limit, offset);

    const result = await query<EnrichedTransactionDbRow>(sql, params);
    return attachTagsToRows(result.rows);
  },

  /**
   * Get total count with optional filters (reuses the same WHERE builder as getAll).
   *
   * @returns `COUNT(*)` arrives as a bigint string; parsed here.
   */
  async getCount({
    transactionId = null,
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
    transactionType = null,
    amountMin = null,
    amountMax = null,
    amountSigned = false,
    tagSlugs = null,
  }: TransactionFilters = {}): Promise<number> {
    const { sql: where, params } = buildTransactionWhere({
      transactionId,
      startDate,
      endDate,
      accountId,
      bankAccount,
      categoryId,
      categoryIds,
      recipientId,
      recipientGroupId,
      recipientName,
      search,
      active,
      transactionType,
      amountMin,
      amountMax,
      amountSigned,
      tagSlugs,
    });

    const sql = `
      SELECT count(*) FROM transactions t
      ${COUNT_JOINS}
      WHERE ${where}
    `;

    const result = await query<{ count: string }>(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * Get uncategorised transactions (recipient has no default category and transaction has no category).
   */
  async getUncategorised({
    transactionId = null,
    limit = 50,
    offset = 0,
    startDate = null,
    endDate = null,
    accountId = null,
    bankAccount = null,
    recipientId = null,
    recipientGroupId = null,
    recipientName = null,
    search = null,
    transactionType = null,
    amountMin = null,
    amountMax = null,
    amountSigned = false,
    tagSlugs = null,
  }: TransactionFilters = {}): Promise<EnrichedTransactionRow[]> {
    // "Uncategorised" means the full 3-level effective category is NULL — own
    // category, the recipient default, AND the primary-recipient default. Joining
    // pr (and using EFFECTIVE_CATEGORY_ID_SQL) stops alias-recipient rows whose
    // primary carries a category from wrongly appearing in the queue.
    const {
      sql: where,
      params,
      nextParamIdx: paramIdx,
    } = buildTransactionWhere({
      transactionId,
      startDate,
      endDate,
      accountId,
      bankAccount,
      recipientId,
      recipientGroupId,
      recipientName,
      search,
      active: true,
      transactionType,
      amountMin,
      amountMax,
      amountSigned,
      tagSlugs,
    });
    const sql = `
      SELECT t.*,
             ${ACCOUNT_LABEL_SQL},
             r.name AS recipient_name,
             NULL AS category_name
      FROM transactions t
      ${TRANSACTION_JOINS}
      WHERE ${where}
        AND ${EFFECTIVE_CATEGORY_ID_SQL} IS NULL
      ORDER BY t.date DESC, t.id DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(limit, offset);

    const result = await query<EnrichedTransactionDbRow>(sql, params);
    return attachTagsToRows(result.rows);
  },

  /**
   * Get uncategorised transactions plus total in a single round-trip.
   *
   * - `rows` and `total` use the same uncategorised filtering semantics: the queue is always the
   *   ACTIVE rows whose full 3-level effective category is NULL (see
   *   getUncategorised), narrowed by every filter the caller set.
   * - Category filters are ignored because this queue has no effective category.
   * - Pagination limits rows only; `total` includes all matching queue rows even
   *   when the requested page is empty.
   */
  async getUncategorisedWithCount({
    transactionId = null,
    limit = 50,
    offset = 0,
    startDate = null,
    endDate = null,
    accountId = null,
    bankAccount = null,
    recipientId = null,
    recipientGroupId = null,
    recipientName = null,
    search = null,
    sortBy = null,
    sortDir = null,
    includeBalance = false,
    transactionType = null,
    amountMin = null,
    amountMax = null,
    amountSigned = false,
    tagSlugs = null,
  }: TransactionFilters = {}): Promise<{
    rows: EnrichedTransactionRow[];
    total: number;
  }> {
    // Build the predicate once for both the page and its count. The queue is an
    // active-rows worklist, exactly as getUncategorised.
    const {
      sql: rowsWhere,
      params: rowsParams,
      nextParamIdx: rowsNextParam,
    } = buildTransactionWhere({
      transactionId,
      startDate,
      endDate,
      accountId,
      bankAccount,
      recipientId,
      recipientGroupId,
      recipientName,
      search,
      active: true,
      transactionType,
      amountMin,
      amountMax,
      amountSigned,
      tagSlugs,
    });

    const params = [...rowsParams];

    const sortCol = TRANSACTION_SORT_COLUMNS[String(sortBy)] || "t.date";
    const sortDirection = sortDir === "asc" ? "ASC" : "DESC";
    const orderBy =
      sortBy && TRANSACTION_SORT_COLUMNS[sortBy]
        ? `${sortCol} ${sortDirection}, t.date DESC, t.id DESC`
        : "t.date DESC, t.id DESC";
    const runningBalanceCol = includeBalance ? ", lb.running_balance" : "";

    // Full 3-level effective-category IS NULL (see getUncategorised) — requires
    // the pr join in both CTEs below.
    const uncategorisedWhere = `${rowsWhere}
      AND ${EFFECTIVE_CATEGORY_ID_SQL} IS NULL`;
    const uncategorisedJoins = `
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN accounts acct ON t.account_id = acct.id`;

    const limitParam = rowsNextParam;
    const offsetParam = rowsNextParam + 1;
    params.push(limit, offset);

    const sql = `
      ${includeBalance ? `WITH ${runningBalanceCtes(uncategorisedWhere, uncategorisedJoins)},` : "WITH"} total_cte AS (
        SELECT count(*)::int AS total
        FROM transactions t
        ${COUNT_JOINS}
        LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
        WHERE ${uncategorisedWhere}
      ),
      uncategorised_rows AS (
        SELECT t.*,
               ${ACCOUNT_LABEL_SQL},
               r.name AS recipient_name,
               NULL AS category_name${runningBalanceCol},
               ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS _row_order
        FROM transactions t
        ${uncategorisedJoins}
        ${includeBalance ? "JOIN ledger_balances lb ON lb.id = t.id" : ""}
        WHERE ${uncategorisedWhere}
        ORDER BY ${orderBy}
        LIMIT $${limitParam} OFFSET $${offsetParam}
      )
      SELECT u.*,
             tc.total AS total_count
      FROM total_cte tc
      LEFT JOIN uncategorised_rows u ON true
      ORDER BY u._row_order NULLS LAST
    `;

    // The LEFT JOIN onto total_cte yields one all-NULL row when the page is
    // empty, so `id` may be null here.
    const result = await query<
      Omit<EnrichedTransactionDbRow, "id"> & {
        id: number | null;
        total_count: number;
        _row_order: string | null;
      }
    >(sql, params);
    // String(): total_count is COUNT(*)::int; parseInt coerced it the same way.
    const total =
      result.rows.length > 0
        ? parseInt(String(result.rows[0].total_count), 10)
        : 0;
    const rows = result.rows
      .filter((row): row is typeof row & { id: number } => row.id != null)
      .map(({ total_count: _total_count, _row_order, ...row }) => row);

    return { rows: await attachTagsToRows(rows), total };
  },

  /**
   * Get a single transaction by ID.
   */
  async getById(id: number): Promise<EnrichedTransactionRow | null> {
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
    const result = await queryPrepared("tx_get_by_id", sql, [id]);
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
  async create({
    transaction_date,
    account_id,
    recipient_id,
    amount,
    memo,
    currency,
    category_id,
    comment,
    tags = null,
  }: TransactionCreateInput): Promise<EnrichedTransactionRow | null> {
    // `balance` is intentionally absent: manual transactions leave it NULL so the
    // account balance (ADR-094) only ever anchors on imported, bank-stamped rows.
    // The CSV import pipeline writes `balance` via its own INSERT (commit.js).
    const sql = `
      WITH inserted AS (
        INSERT INTO transactions (date, account_id, recipient_id, amount, memo, currency, category_id, comment, is_active)
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
    const row = await withTransaction<EnrichedTransactionDbRow | null>(
      async (client) => {
        // Resolve inside this transaction so a failed create cannot leave an
        // orphan account that the former INSERT trigger would have rolled back.
        const accountId = account_id ?? null;
        if (accountId != null) {
          if (!(await accountRepository.findActiveId(accountId, { client }))) {
            throw new ValidationError(
              "account_id must reference an active account",
            );
          }
        }
        const res = await client.query(sql, [
          transaction_date,
          accountId,
          recipient_id,
          amount,
          memo ? memo.toUpperCase() : null,
          // Default to EUR rather than NULL: currency is NOT NULL at the DB level
          // (migration 0046) and the read layer already coalesces missing → EUR.
          currency ? currency.toUpperCase() : "EUR",
          category_id,
          comment,
        ]);
        const inserted = res.rows[0];
        if (!inserted) return null;
        if (tags !== null) {
          await setTransactionTags(client, inserted.id, tags);
        }
        return inserted;
      },
    );

    if (!row) return null;
    const [enriched] = await attachTagsToRows([row]);
    clearTransactionCountCache();
    return enriched;
  },

  /**
   * Get transactions and a briefly cached total count. The data query remains
   * independently pipelined under LIMIT while page changes reuse the same
   * filter count.
   *
   * @returns `total` is `COUNT(*)::int`, a real number.
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
  }: TransactionFilters = {}): Promise<{
    rows: EnrichedTransactionRow[];
    total: number;
  }> {
    const {
      sql: where,
      params,
      nextParamIdx: p,
    } = buildTransactionWhere({
      transactionId,
      startDate,
      endDate,
      accountId,
      bankAccount,
      categoryId,
      categoryIds,
      recipientId,
      recipientGroupId,
      recipientName,
      search,
      active,
      transactionType,
      amountMin,
      amountMax,
      amountSigned,
      tagSlugs,
    });

    const sortCol = TRANSACTION_SORT_COLUMNS[String(sortBy)] || "t.date";
    const sortDirection = sortDir === "asc" ? "ASC" : "DESC";
    // t.id DESC is the unique final tiebreaker — without it LIMIT/OFFSET pages
    // can duplicate or skip same-date rows across separate query executions.
    const orderBy =
      sortBy && TRANSACTION_SORT_COLUMNS[sortBy]
        ? `${sortCol} ${sortDirection}, t.date DESC, t.id DESC`
        : `t.date DESC, t.id DESC`;

    // Partition by account and currency — see getAll for the rationale.
    const runningBalanceCol = includeBalance ? ", lb.running_balance" : "";

    // Count as a SEPARATE query rather than `COUNT(*) OVER ()`: the window
    // function forced the planner to fully materialize + sort the whole filtered
    // 6-way join before LIMIT on every page (paid even on the unfiltered page-1
    // default with include_balance=false). Splitting it lets the data query
    // pipeline and stop at LIMIT (Nested-Loop + Memoize top-N), while the count
    // runs without the wide projection/sort/window. The `total` returned is
    // byte-identical: it uses the same WHERE and retains its sole referenced
    // join (`r`); the omitted LEFT JOINs target primary keys and therefore
    // cannot drop or multiply transaction rows.
    const dataSql = `
      ${includeBalance ? `WITH ${runningBalanceCtes(where, TRANSACTION_JOINS)}` : ""}
      SELECT t.*,
             ${ACCOUNT_LABEL_SQL},
             COALESCE(pr.name, r.name) AS recipient_name,
             COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS effective_category_id,
             CASE
               WHEN c.id IS NOT NULL THEN c.path_name
               WHEN rc.id IS NOT NULL THEN rc.path_name
               WHEN pc.id IS NOT NULL THEN pc.path_name
               ELSE NULL
             END AS category_name${runningBalanceCol}
      FROM transactions t
      ${TRANSACTION_JOINS}
      ${includeBalance ? "JOIN ledger_balances lb ON lb.id = t.id" : ""}
      WHERE ${where}
      ORDER BY ${orderBy} LIMIT $${p} OFFSET $${p + 1}
    `;
    const countSql = `SELECT COUNT(*)::int AS total FROM transactions t ${COUNT_JOINS} WHERE ${where}`;

    const dataParams = [...params, limit, offset];
    const [result, total] = await Promise.all([
      query<EnrichedTransactionDbRow>(dataSql, dataParams),
      getCachedTransactionCount(countSql, params),
    ]);
    return { rows: await attachTagsToRows(result.rows), total };
  },

  /**
   * Update a transaction.
   * When `tags` is present in fields, junction rows are replaced atomically.
   * When `tags` is absent, existing tags are untouched.
   */
  async update(
    id: number,
    fields: Record<string, unknown> & { tags?: string[] | null },
  ): Promise<EnrichedTransactionRow | null> {
    const { tags, ...txFields } = fields;
    // Sanitize field names to prevent SQL injection via column names
    const sanitized = sanitizeUpdateFields("transactions", txFields);

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

    const row = await withTransaction<EnrichedTransactionDbRow | null>(
      async (client) => {
        // Resolve the compatibility label on this connection. A missing target
        // row or failed update then rolls back any account minted for the label.
        await stampAccountIdForUpdate(sanitized, client);
        const {
          clauses: setClauses,
          params: updateParams,
          nextIdx: paramIdx,
        } = buildSetClauses(sanitized, {
          quote: true,
          mapColumn: (key) => (key === "transaction_date" ? "date" : key),
        });

        if (setClauses.length > 0) {
          setClauses.push(`updated_at = NOW()`);
          updateParams.push(id);
          const updateSql = `
          UPDATE transactions SET ${setClauses.join(", ")}
          WHERE id = $${paramIdx} RETURNING id
        `;
          const res = await client.query(updateSql, updateParams);
          if (!res.rows[0]) return null;
        } else {
          // Tags-only or empty PATCH: probe existence first. Otherwise the tag
          // junction INSERT would expose a raw FK error instead of the usual 404.
          const exists = await client.query(
            "SELECT 1 FROM transactions WHERE id = $1",
            [id],
          );
          if (!exists.rows[0]) return null;
        }

        if (tags !== undefined) {
          await setTransactionTags(client, id, tags ?? []);
        }
        const res = await client.query(fetchSql, [id]);
        return res.rows[0] || null;
      },
    );
    if (!row) return null;
    const [enriched] = await attachTagsToRows([row]);
    clearTransactionCountCache();
    return enriched;
  },

  /**
   * Hard delete a transaction.
   *
   * @returns true when a row was removed
   */
  async hardDelete(id: number): Promise<boolean> {
    const result = await queryPrepared(
      "tx_hard_delete",
      "DELETE FROM transactions WHERE id = $1",
      [id],
    );
    const deleted = (result.rowCount ?? 0) > 0;
    if (deleted) clearTransactionCountCache();
    return deleted;
  },

  // Recent active transactions not yet linked to any planned-transaction
  // execution. Feeds the match-suggestions read endpoint so already-cleared
  // transactions never resurface as candidates. Returns the cluster root so the
  // matcher can compare against planned-payment clusters directly.
  /** @param args `sinceDate` is a 'YYYY-MM-DD' lower bound */
  async listRecentUnlinked({
    sinceDate,
  }: {
    sinceDate: string;
  }): Promise<UnlinkedTransactionRow[]> {
    const result = await query<UnlinkedTransactionRow>(
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
      [sinceDate],
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
   */
  async getStampedDateRangesByAccount(
    accountIds: number[],
  ): Promise<{ account_id: number; min_date: string; max_date: string }[]> {
    const result = await query<{
      account_id: number;
      min_date: string;
      max_date: string;
    }>(STAMP_RANGES_SQL, [accountIds]);
    return result.rows;
  },

  /**
   * Opening-balance anchors (`transfer_source = 'opening'`) per account. Run
   * BEFORE an account-merge repoint, for the same reason as
   * {@link getStampedDateRangesByAccount}: the repoint erases the provenance
   * this guard needs — and, since the repoint moves every anchor onto the
   * survivor, it is also what would violate `uq_transactions_opening_anchor`.
   */
  async getOpeningAnchorsByAccount(
    accountIds: number[],
  ): Promise<{ account_id: number; currency: string }[]> {
    const result = await query<{ account_id: number; currency: string }>(
      OPENING_ANCHORS_SQL,
      [accountIds],
    );
    return result.rows;
  },

  /**
   * Repoint transactions off merged-away source accounts onto the survivor.
   *
   * @returns rows repointed
   */
  async repointAccount(targetId: number, sourceIds: number[]): Promise<number> {
    const result = await query(
      `UPDATE transactions SET account_id = $1 WHERE account_id = ANY($2::int[])`,
      [targetId, sourceIds],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Repoint transactions off merged alias recipients onto the primary.
   *
   * @returns rows repointed
   */
  async repointRecipient(
    primaryId: number,
    aliasIds: number[],
  ): Promise<number> {
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
   */
  async listTransferCandidatePairs(
    windowDays: number,
  ): Promise<{ outId: number; inId: number }[]> {
    const { rows } = await query<{ outId: number; inId: number }>(
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
  async releaseOrphanedTransfers(): Promise<void> {
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
   */
  async releaseInvalidAutoTransferPairs(windowDays: number): Promise<void> {
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
   */
  async listTransferSuggestionRows(
    ids: number[],
  ): Promise<TransferSuggestionRow[]> {
    // bank_account is derived from accounts.name over the FK (ADR-088) so the
    // display label survives the out-of-band drop of the string column.
    const { rows } = await query<TransferSuggestionRow>(
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
   * @returns rows affected (0 when the guard rejected the mark)
   */
  async markAutoTransferLeg(id: number, peerId: number): Promise<number> {
    const result = await query(MARK_AUTO_LEG_SQL, [id, peerId]);
    return result.rowCount ?? 0;
  },

  /**
   * Mark one leg of a manual pair (unconditional — caller released prior peers).
   *
   * @returns rows affected
   */
  async markManualTransferLeg(id: number, peerId: number): Promise<number> {
    const result = await query(MARK_MANUAL_LEG_SQL, [id, peerId]);
    return result.rowCount ?? 0;
  },

  /**
   * Undo a leg WE just auto-marked (guarded on the peer we set + source='auto')
   * so a half-applied pair is never committed when the sibling leg's guarded
   * UPDATE misses.
   *
   * @returns rows affected
   */
  async revertAutoTransferLeg(id: number, peerId: number): Promise<number> {
    const result = await query(REVERT_AUTO_LEG_SQL, [id, peerId]);
    return result.rowCount ?? 0;
  },

  /**
   * Lock both legs of a manual mark and read what markTransfer validates.
   */
  async lockTransferLegs(
    ids: number[],
  ): Promise<
    Pick<TransactionRow, "id" | "amount" | "account_id" | "is_active">[]
  > {
    const { rows } = await query<
      Pick<TransactionRow, "id" | "amount" | "account_id" | "is_active">
    >(
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
   * @returns rows released
   */
  async releaseTransferPeersOf(ids: number[]): Promise<number> {
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
   * @returns the peer id; `undefined` when the row is gone OR unpaired (the `?? undefined` collapses both)
   */
  async lockTransferPeerPointer(id: number): Promise<number | undefined> {
    const { rows } = await query<{ transfer_peer_id: number | null }>(
      "SELECT transfer_peer_id FROM transactions WHERE id = $1 FOR UPDATE",
      [id],
    );
    return rows[0]?.transfer_peer_id ?? undefined;
  },

  /**
   * Record a rejected pairing (sticky, per-pair — migration 0070).
   */
  async insertTransferDismissal(aId: number, bId: number): Promise<void> {
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
   * @returns rows affected
   */
  async clearTransferMark(id: number): Promise<number> {
    const result = await query(
      `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL WHERE id = $1`,
      [id],
    );
    return result.rowCount ?? 0;
  },

  // ---------------------------------------------------------------------------
  // Import commit (import-specific — deliberately NOT create()/getById())
  // ---------------------------------------------------------------------------

  async findImportFingerprint(
    version: number | null | undefined,
    fingerprint: string | null | undefined,
  ): Promise<number | undefined> {
    if (version == null || !fingerprint) return undefined;
    const result = await query<{ id: number }>(
      `SELECT id FROM transactions
        WHERE dedup_fingerprint_version = $1 AND dedup_fingerprint = $2
        LIMIT 1`,
      [version, fingerprint],
    );
    return result.rows[0]?.id ?? undefined;
  },

  /**
   * Compatibility count for canonical rows written before versioned import
   * identity existed. Modern rows are excluded so the legacy heuristic can no
   * longer suppress an occurrence whose fingerprint is genuinely new.
   */
  async countLegacyImportDuplicates({
    date,
    amount,
    recipientId,
    memo,
    accountId,
    currency,
  }: {
    /** 'YYYY-MM-DD' */
    date: string;
    amount: number | string;
    recipientId: number | null;
    /** Already whitespace-normalized by the caller. */
    memo: string;
    accountId: number | null;
    currency: string;
  }): Promise<number> {
    const result = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM transactions t
        WHERE t.dedup_fingerprint IS NULL
          AND t.is_active = true
          AND t.date = $1
          AND t.amount = $2
          AND t.recipient_id IS NOT DISTINCT FROM $3::integer
          AND COALESCE(BTRIM(t.memo, E' \\t\\n\\r\\f\\013'), '') = $4
          AND t.account_id IS NOT DISTINCT FROM $5::integer
          AND t.currency = $6`,
      [date, amount, recipientId, memo, accountId, currency],
    );
    return Number(result.rows[0]?.n) || 0;
  },

  /**
   * Insert a committed import row. Distinct from create(): the import writes
   * `balance` (bank-stamped, anchors ADR-094), `import_batch_id`,
   * `matched_pattern_id` and versioned fingerprint metadata. The partial
   * fingerprint index is the concurrent-import race guard.
   *
   * ADR-088 contract phase: the import pipeline resolves the compatibility
   * label first and this INSERT persists only the canonical `account_id`.
   *
   * @returns inserted id, or undefined on conflict
   */
  async insertImportedRow({
    date,
    accountId,
    recipientId,
    categoryId,
    amount,
    memo,
    currency,
    balance,
    comment,
    importBatchId,
    matchedPatternId,
    sourceRecordHash,
    dedupFingerprint,
    fingerprintVersion,
  }: ImportedTransactionInput): Promise<number | undefined> {
    const result = await query<{ id: number }>(
      `INSERT INTO transactions
                (date, account_id, recipient_id, category_id, amount, memo, currency, balance, comment,
                 import_batch_id, matched_pattern_id, source_record_hash,
                 dedup_fingerprint, dedup_fingerprint_version, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true)
             ON CONFLICT DO NOTHING
             RETURNING id`,
      [
        date,
        accountId ?? null,
        recipientId,
        categoryId,
        amount,
        memo,
        currency,
        balance,
        comment,
        importBatchId,
        matchedPatternId,
        sourceRecordHash ?? null,
        dedupFingerprint ?? null,
        fingerprintVersion ?? null,
      ],
    );
    return result.rows[0]?.id ?? undefined;
  },
};

export default transactionRepository;
