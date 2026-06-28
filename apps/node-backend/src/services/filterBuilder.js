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
 * @param {string|null}   [opts.bankAccount]   substring, ILIKE
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
 *                                          text and tag slugs)
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
    clauses.push(
      `COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = $${p++}`,
    );
    params.push(categoryId);
  } else if (Array.isArray(categoryIds) && categoryIds.length > 0) {
    const safe = validateInt4Ids(categoryIds);
    if (safe.length > 0) {
      const placeholders = safe.map(() => `$${p++}`).join(', ');
      clauses.push(
        `COALESCE(t.category_id, r.default_category_id, pr.default_category_id) IN (${placeholders})`,
      );
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
    clauses.push(`(t.recipient_id = $${p} OR r.primary_recipient_id = $${p})`);
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
  if (search) {
    // Free-text search spans every user-visible facet of a transaction: notes,
    // bank/currency, amount, recipients, categories, the date (as ISO text so
    // "2026-06" matches), and any of the row's active tag slugs.
    clauses.push(`(
      t.memo ILIKE $${p} OR
      t.comment ILIKE $${p} OR
      t.bank_account ILIKE $${p} OR
      t.currency ILIKE $${p} OR
      CAST(t.amount AS TEXT) ILIKE $${p} OR
      CAST(t.date AS TEXT) ILIKE $${p} OR
      r.name ILIKE $${p} OR
      pr.name ILIKE $${p} OR
      c.general ILIKE $${p} OR
      c.detail ILIKE $${p} OR
      rc.general ILIKE $${p} OR
      rc.detail ILIKE $${p} OR
      pc.general ILIKE $${p} OR
      pc.detail ILIKE $${p} OR
      EXISTS (
        SELECT 1 FROM transaction_tags tt
        JOIN tags tg ON tg.id = tt.tag_id
        WHERE tt.transaction_id = t.id
          AND tg.is_active = true
          AND tg.slug ILIKE $${p}
      )
    )`);
    p++;
    params.push(`%${search}%`);
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

  if (safeCats.length > 0) {
    const placeholders = safeCats.map(() => `$${p++}`).join(', ');
    clauses.push(
      `COALESCE(t.category_id, r.default_category_id, pr.default_category_id) NOT IN (${placeholders})`,
    );
    params.push(...safeCats);
  }

  if (safeRecs.length > 0) {
    const placeholders = safeRecs.map(() => `$${p++}`).join(', ');
    clauses.push(`COALESCE(r.primary_recipient_id, t.recipient_id) NOT IN (${placeholders})`);
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
