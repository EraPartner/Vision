/**
 * filterBuilder — centralized SQL WHERE/JOIN builders for transaction-like queries.
 *
 * Consolidates filter shapes previously duplicated across:
 *   - repositories/transactionRepository.js  (buildWhereClause)
 *   - repositories/infoRepository.js         (excludedCategoryIds / excludedRecipientIds
 *                                             + bankAccount/date predicates)
 *   - repositories/splitRepository.js        (primary-recipient COALESCE pattern)
 *
 * `buildTransactionWhere` and `buildExclusionClauses` both derive their
 * `opts` object type from the dotted `@param opts.field` entries in their own
 * JSDoc — TS's JSDoc support builds a structural type out of those. This
 * file's third builder, `buildAggregationFilter`, reuses both option shapes
 * via `Parameters<typeof fn>[0]` rather than re-listing every field a third
 * time.
 *
 * Phase 0 is additive: this module is created and unit-tested, but callers are NOT
 * migrated here. Call-site migration happens in Phases 2 (dashboard) and 5 (transactions).
 *
 * Return contract for every builder:
 *   { sql, params, nextParamIdx }
 * where `sql` is a composable fragment (no leading/trailing whitespace guarantees
 * beyond what's shown in tests) and `nextParamIdx` is the first unused $-index so
 * callers can append further predicates.
 */

import { validateIntArray } from '../middleware/validation.js';
import { ValidationError } from '../middleware/errorHandler.js';

const MAX_LIST_SIZE = 50;
// Free-text search terms shorter than this (after trimming) are ignored: a
// 1-character term matches nearly every row while still paying the full cost
// of the multi-branch scan below.
export const MIN_SEARCH_LENGTH = 2;

/**
 * Validate a list of PostgreSQL INT4 ids for use in a generated SQL clause.
 *
 * Rejects the whole list — it does NOT drop elements. Dropping was the bug: at
 * SQL-build time a discarded id does not 404, it silently changes which rows
 * the query covers. An exclusion list that loses an element quietly stops
 * excluding that category; one that loses every element emits no clause at all
 * and answers with the full dataset. A bulk selection that loses an element
 * writes to a smaller set than the caller named. Nothing surfaced either way.
 *
 * Delegates to validateIntArray (hence validateId), so the accepted element
 * shapes are exactly the `:id` params', the body arrays' and the aggregation
 * query params': a plain base-10 digit string or an integer number, 1..2^31-1.
 * That also fixes an off-by-one this filter used to carry on its own — it
 * bounded ids with `id < 2147483647`, so a legal int4 id at the ceiling was
 * accepted by every route-layer validator and then dropped here.
 *
 * Nullish input means "no ids" and yields `[]` (the unset convention
 * assertOptionalId and parseIdArrayQueryParam use); callers skip the clause.
 * @param {unknown} ids
 * @param {string} [fieldName]
 * @returns {number[]}
 * @throws {ValidationError} when any element is not a valid int4 id
 */
export function validateInt4Ids(ids, fieldName = 'ids') {
  if (ids === undefined || ids === null) return [];
  const result = validateIntArray(ids, fieldName);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

/**
 * Coerce one amount-filter value to a comparable number. Compares on magnitude
 * (|amount|) by default — income/expense sign belongs to transaction_type — or
 * on the signed amount when `signed` is true, so +50 and -50 are distinct.
 * Returns null for missing or unparseable input (the clause is skipped).
 *
 * Single source of truth for the list endpoint (routes/transactions.js) and
 * bulk selection (services/bulkSelection.js), which must stay in lockstep.
 * @param {unknown} value
 * @param {boolean} [signed]
 * @returns {number|null}
 */
export function parseAmountFilter(value, signed = false) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return signed ? n : Math.abs(n);
}

/**
 * Build the canonical transaction WHERE clause.
 *
 * Assumes the caller joined `transactions t` with:
 *   LEFT JOIN recipients r ON t.recipient_id = r.id
 *
 * `r` is the ONLY join alias any predicate built here references, and only the
 * `recipientName` filter references it (`r.name ILIKE`). Every other filter
 * resolves against `t` plus self-contained subqueries, so a caller that needs
 * no projection (a count) may join `r` alone — see the reduced join set used by
 * transactionRepository's uncategorised total. Callers that also project
 * recipient/category/account labels still join `pr`/`c`/`rc`/`pc`/`acct`, but
 * this builder does not require them.
 *
 * @param {object} opts
 * @param {number|null} [opts.transactionId]
 * @param {string|null} [opts.startDate]    inclusive
 * @param {string|null} [opts.endDate]      inclusive
 * @param {number|null}   [opts.accountId]     exact match on t.account_id — the preferred account
 *                                             filter (ADR-088; the bank_account string is being retired)
 * @param {number[]|null} [opts.accountIds]    multiple account ids (IN clause); ignored when accountId is set
 * @param {string|null}   [opts.bankAccount]   substring, ILIKE on the account's canonical name
 *                                             (accounts.name via t.account_id — ADR-088 contract:
 *                                             the SQL no longer touches the retired bank_account
 *                                             string) — legacy escape hatch; prefer accountId
 * @param {string[]|null} [opts.bankAccounts]  exact match on accounts.name (resolved through
 *                                             t.account_id); ignored when bankAccount is set;
 *                                             capped at MAX_LIST_SIZE
 * @param {number|null}   [opts.categoryId]    matches transaction, recipient-default or primary-default
 * @param {number[]|null} [opts.categoryIds]   multiple category IDs (IN clause); ignored when categoryId is set
 * @param {number|null} [opts.recipientId]      matches the txn recipient or any sub-recipient under it
 * @param {number|null} [opts.recipientGroupId] like recipientId but resolves the full primary group:
 *                                              includes the recipient's own primary (if it is an alias)
 *                                              and all other aliases sharing that primary
 * @param {string|null} [opts.recipientName] substring, ILIKE on r.name
 * @param {string|null} [opts.search]       multi-column substring (memo, comment, bank,
 *                                          currency, amount, recipients, categories, date
 *                                          text and tag slugs); ignored when shorter than
 *                                          MIN_SEARCH_LENGTH after trimming
 * @param {boolean}     [opts.active=true]  require t.is_active = true
 * @param {'income'|'expense'|null} [opts.transactionType] filter by amount sign
 * @param {number|null} [opts.amountMin]    inclusive lower bound on the amount. By default
 *                                          compares |amount| (magnitude, sign-agnostic); when
 *                                          amountSigned is true compares the signed amount.
 * @param {number|null} [opts.amountMax]    inclusive upper bound (see amountMin)
 * @param {boolean}     [opts.amountSigned=false] when true, amountMin/amountMax are compared
 *                                          against the signed t.amount (so -50/+50 are distinct);
 *                                          when false they compare against ABS(t.amount)
 * @param {string[]|null} [opts.tagSlugs]   OR-match: row must have at least one of these active tags
 * @param {number}      [opts.startParamIdx=1] first $-index to allocate
 */
export function buildTransactionWhere(opts = {}) {
  const {
    transactionId = null,
    startDate = null,
    endDate = null,
    accountId = null,
    accountIds = null,
    bankAccount = null,
    bankAccounts = null,
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
    startParamIdx = 1,
  } = opts;

  const clauses = ['1=1'];
  const params = [];
  let p = startParamIdx;

  if (active) clauses.push('t.is_active = true');

  if (transactionId != null) {
    clauses.push(`t.id = $${p++}`);
    params.push(transactionId);
  }
  if (startDate) {
    clauses.push(`t.date >= $${p++}`);
    params.push(startDate);
  }
  if (endDate) {
    clauses.push(`t.date <= $${p++}`);
    params.push(endDate);
  }
  if (accountId != null) {
    clauses.push(`t.account_id = $${p++}`);
    params.push(accountId);
  } else if (Array.isArray(accountIds) && accountIds.length > 0) {
    const safe = validateInt4Ids(accountIds, 'accountIds');
    if (safe.length > 0) {
      const placeholders = safe.map(() => `$${p++}`).join(', ');
      clauses.push(`t.account_id IN (${placeholders})`);
      params.push(...safe);
    }
  }
  // Both bank filters resolve through account_id (ADR-088 contract phase): the
  // label lives on accounts.name, and rows are matched by FK — never by the
  // retired transactions.bank_account string. Under the dual-write parity
  // invariant (trigger 0051/0083 + rename propagation) the observable matches
  // are identical to the old string predicates.
  if (bankAccount) {
    clauses.push(`t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name ILIKE $${p++})`);
    params.push(`%${bankAccount}%`);
  } else if (Array.isArray(bankAccounts) && bankAccounts.length > 0) {
    const safe = bankAccounts.slice(0, MAX_LIST_SIZE).map((s) => String(s).trim()).filter(Boolean);
    if (safe.length > 0) {
      const placeholders = safe.map(() => `$${p++}`).join(', ');
      clauses.push(`t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name IN (${placeholders}))`);
      params.push(...safe);
    }
  }
  if (categoryId != null) {
    // Effective-category match, expanded from COALESCE(t.category_id,
    // r.default_category_id, pr.default_category_id) = $ into an indexable
    // disjunction of semi-joins so the planner can use the category_id indexes.
    // Replicates the COALESCE precedence exactly:
    //   own category = X, OR
    //   (own NULL AND recipient default = X), OR
    //   (own NULL AND recipient default NULL AND primary default = X).
    const idx = p++;
    clauses.push(`(
      t.category_id = $${idx}
      OR (t.category_id IS NULL AND t.recipient_id IN (SELECT id FROM recipients WHERE default_category_id = $${idx}))
      OR (t.category_id IS NULL AND t.recipient_id IN (
        SELECT r2.id FROM recipients r2
        JOIN recipients pr2 ON r2.primary_recipient_id = pr2.id
        WHERE r2.default_category_id IS NULL AND pr2.default_category_id = $${idx}
      ))
    )`);
    params.push(categoryId);
  } else if (Array.isArray(categoryIds) && categoryIds.length > 0) {
    const safe = validateInt4Ids(categoryIds, 'categoryIds');
    if (safe.length > 0) {
      // Same effective-category expansion as the single-value branch above,
      // with each leaf comparing against the id list. The placeholder slots are
      // allocated once and reused across the three leaves (Postgres allows a
      // $N to appear multiple times), so the param count/order is unchanged.
      const startIdx = p;
      const placeholders = safe.map((_, i) => `$${startIdx + i}`).join(', ');
      p += safe.length;
      clauses.push(`(
        t.category_id IN (${placeholders})
        OR (t.category_id IS NULL AND t.recipient_id IN (SELECT id FROM recipients WHERE default_category_id IN (${placeholders})))
        OR (t.category_id IS NULL AND t.recipient_id IN (
          SELECT r2.id FROM recipients r2
          JOIN recipients pr2 ON r2.primary_recipient_id = pr2.id
          WHERE r2.default_category_id IS NULL AND pr2.default_category_id IN (${placeholders})
        ))
      )`);
      params.push(...safe);
    }
  }
  if (transactionType === 'income') {
    clauses.push('t.amount > 0');
  } else if (transactionType === 'expense') {
    clauses.push('t.amount < 0');
  }
  const amountCol = amountSigned ? 't.amount' : 'ABS(t.amount)';
  if (amountMin != null && Number.isFinite(Number(amountMin))) {
    clauses.push(`${amountCol} >= $${p++}`);
    params.push(Number(amountMin));
  }
  if (amountMax != null && Number.isFinite(Number(amountMax))) {
    clauses.push(`${amountCol} <= $${p++}`);
    params.push(Number(amountMax));
  }
  if (recipientId != null) {
    // Semi-join so the planner can use the t.recipient_id index instead of an
    // OR spanning t and the joined recipients r. Equivalent to
    // (t.recipient_id = $ OR r.primary_recipient_id = $): the subquery returns
    // the recipient itself plus every alias whose primary is it.
    clauses.push(`t.recipient_id IN (SELECT id FROM recipients WHERE id = $${p} OR primary_recipient_id = $${p})`);
    p++;
    params.push(recipientId);
  }
  if (recipientGroupId != null) {
    // Resolve the full primary group: match the recipient itself, any aliases under it,
    // the recipient's own primary (if it is an alias), and siblings under that primary.
    // The two subqueries return NULL when the recipient has no primary, making those
    // branches no-ops (NULL = anything is false in SQL).
    //
    // Shaped as a semi-join for the same reason as recipientId above: the four
    // branches used to OR `t.recipient_id` against the joined `r.primary_recipient_id`,
    // so the predicate spanned two relations and the planner could only evaluate it as
    // a join Filter — no BitmapOr, no Index Cond on idx_transactions_recipient_id.
    // Every branch resolves inside `recipients` here, leaving `t.recipient_id` as the
    // only transactions-side column. The branch set is unchanged: `r` is joined on
    // `t.recipient_id = r.id`, so `r.primary_recipient_id` for a row is exactly the
    // `primary_recipient_id` of the recipient whose id equals `t.recipient_id`.
    clauses.push(`t.recipient_id IN (
      SELECT id FROM recipients
      WHERE id = $${p}
         OR primary_recipient_id = $${p}
         OR id = (SELECT primary_recipient_id FROM recipients WHERE id = $${p} AND primary_recipient_id IS NOT NULL)
         OR primary_recipient_id = (SELECT primary_recipient_id FROM recipients WHERE id = $${p} AND primary_recipient_id IS NOT NULL)
    )`);
    p++;
    params.push(recipientGroupId);
  }
  if (recipientName) {
    clauses.push(`r.name ILIKE $${p++}`);
    params.push(`%${recipientName}%`);
  }
  const searchText = search == null ? '' : String(search);
  if (searchText.trim().length >= MIN_SEARCH_LENGTH) {
    // Free-text search spans every user-visible facet of a transaction: notes,
    // bank/currency, amount, recipients, categories, the date (as ISO text so
    // "2026-06" matches), and any of the row's active tag slugs.
    //
    // Shaped as `t.id IN (UNION of per-relation branches)` rather than one OR
    // chain over the outer LEFT-JOIN aliases: the planner cannot push an OR
    // that spans joined relations down to any single scan, so the old shape
    // seq-scanned transactions plus all five joins plus per-row amount/date
    // casts and a per-row tag probe on every keystroke. Each branch here is a
    // self-contained scan the planner can index (pg_trgm on memo/comment and
    // recipients.name, btree on the id hops), and the CAST branches exist only
    // when the term is made of characters the cast text can actually contain.
    const matchingCategories = `SELECT sc.id FROM categories sc WHERE sc.general ILIKE $${p} OR sc.detail ILIKE $${p}`;
    const branches = [
      `SELECT st.id FROM transactions st WHERE st.memo ILIKE $${p} OR st.comment ILIKE $${p}`,
      // Bank label via the account entity (ADR-088): the search must match the
      // canonical accounts.name through the FK, not the retired string column.
      `SELECT st.id FROM transactions st WHERE st.account_id IN (SELECT sa.id FROM accounts sa WHERE sa.name ILIKE $${p})`,
      `SELECT st.id FROM transactions st WHERE st.currency ILIKE $${p}`,
    ];
    if (/^[0-9.-]+$/.test(searchText)) {
      branches.push(`SELECT st.id FROM transactions st WHERE CAST(st.amount AS TEXT) ILIKE $${p}`);
    }
    if (/^[0-9-]+$/.test(searchText)) {
      branches.push(`SELECT st.id FROM transactions st WHERE CAST(st.date AS TEXT) ILIKE $${p}`);
    }
    branches.push(
      // Recipient name — the transaction's own recipient (r.name) or the
      // primary it aliases (pr.name).
      `SELECT st.id FROM transactions st WHERE st.recipient_id IN (
        SELECT sr.id FROM recipients sr WHERE sr.name ILIKE $${p}
        UNION
        SELECT sr.id FROM recipients sr WHERE sr.primary_recipient_id IN (
          SELECT srp.id FROM recipients srp WHERE srp.name ILIKE $${p}
        )
      )`,
      // Categories — the transaction's own (c), the recipient's default (rc),
      // and the primary recipient's default (pc).
      `SELECT st.id FROM transactions st WHERE st.category_id IN (${matchingCategories})`,
      `SELECT st.id FROM transactions st WHERE st.recipient_id IN (
        SELECT sr.id FROM recipients sr WHERE sr.default_category_id IN (${matchingCategories})
        UNION
        SELECT sr.id FROM recipients sr WHERE sr.primary_recipient_id IN (
          SELECT srp.id FROM recipients srp WHERE srp.default_category_id IN (${matchingCategories})
        )
      )`,
      // Active tag slugs via the junction table.
      `SELECT tt.transaction_id FROM transaction_tags tt
        JOIN tags tg ON tg.id = tt.tag_id
        WHERE tg.is_active = true AND tg.slug ILIKE $${p}`,
    );
    clauses.push(`t.id IN (\n      ${branches.join('\n      UNION\n      ')}\n    )`);
    p++;
    params.push(`%${searchText}%`);
  }
  if (Array.isArray(tagSlugs) && tagSlugs.length > 0) {
    const safe = tagSlugs.slice(0, MAX_LIST_SIZE).map((s) => String(s).trim()).filter(Boolean);
    if (safe.length > 0) {
      clauses.push(`EXISTS (
        SELECT 1 FROM transaction_tags tt
        JOIN tags tg ON tg.id = tt.tag_id
        WHERE tt.transaction_id = t.id
          AND tg.slug = ANY($${p++}::text[])
          AND tg.is_active = true
      )`);
      params.push(safe);
    }
  }

  return {
    sql: clauses.join(' AND '),
    params,
    nextParamIdx: p,
  };
}

/**
 * Build exclusion predicates used by dashboard/info aggregation queries.
 *
 * Honors primary-recipient aggregation: excluding a primary recipient also excludes
 * all of its sub-recipients, and excluding a category also excludes transactions
 * whose effective category (explicit → recipient default → primary default) matches.
 *
 * Required joins on caller (emitted verbatim in `joinSql`):
 *   LEFT JOIN recipients r ON t.recipient_id = r.id
 *   LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
 *
 * @param {object} opts
 * @param {number[]} [opts.excludedCategoryIds=[]]
 * @param {number[]} [opts.excludedRecipientIds=[]]
 * @param {number}   [opts.startParamIdx=1]
 * @returns {{ joinSql: string, whereSql: string, params: any[], nextParamIdx: number }}
 *          `whereSql` is '' when no valid exclusions were supplied.
 */
export function buildExclusionClauses(opts = {}) {
  const { excludedCategoryIds = [], excludedRecipientIds = [], startParamIdx = 1 } = opts;

  const safeCats = validateInt4Ids(excludedCategoryIds, 'excludedCategoryIds');
  const safeRecs = validateInt4Ids(excludedRecipientIds, 'excludedRecipientIds');

  const clauses = [];
  const params = [];
  let p = startParamIdx;

  const joinSql = [
    'LEFT JOIN recipients r ON t.recipient_id = r.id',
    'LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id',
  ].join('\n');

  // The trailing -1 keeps rows whose effective category/recipient is NULL: a bare
  // `NULL NOT IN (...)` evaluates to NULL (not true), which silently dropped every
  // uncategorized / recipient-less row whenever any exclusion was applied. -1 can
  // never be an excluded id (validateInt4Ids requires id > 0), so those rows pass.
  if (safeCats.length > 0) {
    const placeholders = safeCats.map(() => `$${p++}`).join(', ');
    clauses.push(
      `COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN (${placeholders})`,
    );
    params.push(...safeCats);
  }

  if (safeRecs.length > 0) {
    const placeholders = safeRecs.map(() => `$${p++}`).join(', ');
    clauses.push(`COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN (${placeholders})`);
    params.push(...safeRecs);
  }

  return {
    joinSql,
    whereSql: clauses.join(' AND '),
    params,
    nextParamIdx: p,
  };
}

/**
 * Combine a base transaction WHERE with exclusion clauses, sharing a param counter.
 * Convenience wrapper that most aggregation callers will use verbatim.
 *
 * @param {NonNullable<Parameters<typeof buildTransactionWhere>[0]> & NonNullable<Parameters<typeof buildExclusionClauses>[0]>} [opts]
 *   Union of buildTransactionWhere and buildExclusionClauses options.
 * @returns {{ joinSql: string, whereSql: string, params: any[], nextParamIdx: number }}
 */
export function buildAggregationFilter(opts = {}) {
  const base = buildTransactionWhere({ ...opts, startParamIdx: opts.startParamIdx ?? 1 });
  const excl = buildExclusionClauses({ ...opts, startParamIdx: base.nextParamIdx });

  const combinedWhere = excl.whereSql
    ? `${base.sql} AND ${excl.whereSql}`
    : base.sql;

  return {
    joinSql: excl.joinSql,
    whereSql: combinedWhere,
    params: [...base.params, ...excl.params],
    nextParamIdx: excl.nextParamIdx,
  };
}
