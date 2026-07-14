/**
 * filterBuilder — centralized SQL WHERE/JOIN builders for transaction-like queries.
 *
 * Consolidates filter shapes previously duplicated across:
 *   - repositories/transactionRepository.js  (buildWhereClause)
 *   - repositories/infoRepository.js         (excludedCategoryIds / excludedRecipientIds
 *                                             + bankAccount/date predicates)
 *   - repositories/splitRepository.js        (primary-recipient COALESCE pattern)
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

const MAX_INT4 = 2147483647;
const MAX_LIST_SIZE = 50;
// Free-text search terms shorter than this (after trimming) are ignored: a
// 1-character term matches nearly every row while still paying the full cost
// of the multi-branch scan below.
export const MIN_SEARCH_LENGTH = 2;

/**
 * Keep only safe PostgreSQL INT4 ids. Drops null, undefined, non-integer, non-positive,
 * and out-of-range values. Returns an array (possibly empty) — callers decide how to
 * treat empty lists (typically: skip the clause).
 */
export function validateInt4Ids(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id) => Number.isInteger(id) && id > 0 && id < MAX_INT4);
}

/**
 * Coerce one amount-filter value to a comparable number. Compares on magnitude
 * (|amount|) by default — income/expense sign belongs to transaction_type — or
 * on the signed amount when `signed` is true, so +50 and -50 are distinct.
 * Returns null for missing or unparseable input (the clause is skipped).
 *
 * Single source of truth for the list endpoint (routes/transactions.js) and
 * bulk selection (services/bulkSelection.js), which must stay in lockstep.
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
 *   LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
 *   LEFT JOIN categories c ON t.category_id = c.id
 *   LEFT JOIN categories rc ON r.default_category_id = rc.id
 *   LEFT JOIN categories pc ON pr.default_category_id = pc.id
 *
 * @param {object} opts
 * @param {number|null} [opts.transactionId]
 * @param {string|null} [opts.startDate]    inclusive
 * @param {string|null} [opts.endDate]      inclusive
 * @param {number|null}   [opts.accountId]     exact match on t.account_id — the preferred account
 *                                             filter (ADR-088; the bank_account string is being retired)
 * @param {number[]|null} [opts.accountIds]    multiple account ids (IN clause); ignored when accountId is set
 * @param {string|null}   [opts.bankAccount]   substring, ILIKE — legacy escape hatch; prefer accountId
 * @param {string[]|null} [opts.bankAccounts]  exact match IN clause; ignored when bankAccount is set; capped at MAX_LIST_SIZE
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
    const safe = validateInt4Ids(accountIds);
    if (safe.length > 0) {
      const placeholders = safe.map(() => `$${p++}`).join(', ');
      clauses.push(`t.account_id IN (${placeholders})`);
      params.push(...safe);
    }
  }
  if (bankAccount) {
    clauses.push(`t.bank_account ILIKE $${p++}`);
    params.push(`%${bankAccount}%`);
  } else if (Array.isArray(bankAccounts) && bankAccounts.length > 0) {
    const safe = bankAccounts.slice(0, MAX_LIST_SIZE).map((s) => String(s).trim()).filter(Boolean);
    if (safe.length > 0) {
      const placeholders = safe.map(() => `$${p++}`).join(', ');
      clauses.push(`t.bank_account IN (${placeholders})`);
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
    const safe = validateInt4Ids(categoryIds);
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
    clauses.push(`(
      t.recipient_id = $${p}
      OR r.primary_recipient_id = $${p}
      OR t.recipient_id = (SELECT primary_recipient_id FROM recipients WHERE id = $${p} AND primary_recipient_id IS NOT NULL)
      OR r.primary_recipient_id = (SELECT primary_recipient_id FROM recipients WHERE id = $${p} AND primary_recipient_id IS NOT NULL)
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
      `SELECT st.id FROM transactions st WHERE st.bank_account ILIKE $${p} OR st.currency ILIKE $${p}`,
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

  const safeCats = validateInt4Ids(excludedCategoryIds);
  const safeRecs = validateInt4Ids(excludedRecipientIds);

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
 * @param {object} opts Union of buildTransactionWhere and buildExclusionClauses options.
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
