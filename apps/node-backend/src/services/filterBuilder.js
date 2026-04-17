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
 * @param {string|null} [opts.bankAccount]  substring, ILIKE
 * @param {number|null} [opts.categoryId]   matches transaction, recipient-default or primary-default
 * @param {number|null} [opts.recipientId]  matches the txn recipient or any sub-recipient under it
 * @param {string|null} [opts.recipientName] substring, ILIKE on r.name
 * @param {string|null} [opts.search]       multi-column substring
 * @param {boolean}     [opts.active=true]  require t.is_active = true
 * @param {number}      [opts.startParamIdx=1] first $-index to allocate
 */
export function buildTransactionWhere(opts = {}) {
  const {
    transactionId = null,
    startDate = null,
    endDate = null,
    bankAccount = null,
    categoryId = null,
    recipientId = null,
    recipientName = null,
    search = null,
    active = true,
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
  }
  if (categoryId != null) {
    clauses.push(
      `COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = $${p++}`,
    );
    params.push(categoryId);
  }
  if (recipientId != null) {
    clauses.push(`(t.recipient_id = $${p} OR r.primary_recipient_id = $${p})`);
    p++;
    params.push(recipientId);
  }
  if (recipientName) {
    clauses.push(`r.name ILIKE $${p++}`);
    params.push(`%${recipientName}%`);
  }
  if (search) {
    clauses.push(`(
      t.memo ILIKE $${p} OR
      t.comment ILIKE $${p} OR
      t.bank_account ILIKE $${p} OR
      t.currency ILIKE $${p} OR
      CAST(t.amount AS TEXT) ILIKE $${p} OR
      r.name ILIKE $${p} OR
      pr.name ILIKE $${p} OR
      c.general ILIKE $${p} OR
      c.detail ILIKE $${p} OR
      rc.general ILIKE $${p} OR
      rc.detail ILIKE $${p} OR
      pc.general ILIKE $${p} OR
      pc.detail ILIKE $${p}
    )`);
    p++;
    params.push(`%${search}%`);
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
