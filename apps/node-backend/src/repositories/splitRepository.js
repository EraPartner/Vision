/**
 * Split Repository - data access for transaction_splits and split_payments tables.
 *
 * Owed-summary reads from agg_split_outstanding (trigger-maintained by
 * migration 0026) instead of a live aggregate join. Audit events are
 * written via writeAudit; route/service layer owns when to emit them.
 */

import { query, withTransaction } from '../database/connection.js';
import { buildLimitOffset } from '../lib/sqlClauses.js';
import { toWireDate } from '../lib/dateFormat.js';
import {
  computeOwedSummary,
  validateSplitAllocation,
  validateBatchSplitAllocation,
  normalizeMoneyAmount,
  roundToMoneyPrecision,
} from '../lib/calculations/splits.js';
import { toDecimal, subtract, toNumber } from '../lib/money.js';
import { toAppDateString } from '../lib/timezone.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

/** @typedef {import('../types/rows.js').QueryRunner} QueryRunner */
/** @typedef {import('../types/rows.js').FormattedSplit} FormattedSplit */
/** @typedef {import('../types/rows.js').FormattedSplitPayment} FormattedSplitPayment */
/** @typedef {import('../types/rows.js').OwedSplitDetailRow} OwedSplitDetailRow */
/** @typedef {import('../types/rows.js').SplitTotals} SplitTotals */

/**
 * CTE that resolves $1 to every recipient id in the same merge/alias group:
 *   - the recipient itself
 *   - any aliases pointing at it (when $1 is the primary)
 *   - the recipient's own primary (when $1 is an alias)
 *   - sibling aliases sharing that primary
 *
 * Used by owed-detail / export / settle-all so that linked recipients
 * resolve as a single unit even when historical splits still reference
 * the alias's recipient_id (legacy data prior to atomic-merge backfill).
 */
const RECIPIENT_GROUP_CTE = `
  WITH recipient_group AS (
    SELECT id FROM recipients
    WHERE id = $1
       OR primary_recipient_id = $1
       OR id = (SELECT primary_recipient_id FROM recipients WHERE id = $1 AND primary_recipient_id IS NOT NULL)
       OR primary_recipient_id = (SELECT primary_recipient_id FROM recipients WHERE id = $1 AND primary_recipient_id IS NOT NULL)
  )
`;

/**
 * Split-allocation totals for a transaction: the transaction's absolute amount
 * and the sum of its existing splits.
 */
const SPLIT_TOTALS_SQL = `
  SELECT ABS(t.amount) AS transaction_total,
         COALESCE(SUM(ts.amount), 0) AS current_split_total
    FROM transactions t
    LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
   WHERE t.id = $1
   GROUP BY t.id, t.amount
`;

/**
 * Coerce a SPLIT_TOTALS_SQL row to the numeric totals shape (both aggregates
 * arrive as pg NUMERIC strings).
 *
 * @param {any} row
 * @returns {SplitTotals}
 */
function mapSplitTotals(row) {
  return {
    transaction_total: toNumber(toDecimal(row.transaction_total)),
    current_split_total: toNumber(toDecimal(row.current_split_total)),
  };
}

/**
 * Lock the transaction row (SELECT … FOR UPDATE) inside the caller's
 * transaction, then read its split-allocation totals. The lock serializes the
 * validate→insert window so concurrent split creation cannot over-allocate.
 * Throws NotFoundError if the transaction does not exist.
 *
 * @param {QueryRunner} client
 * @param {number} transactionId
 * @returns {Promise<SplitTotals>}
 */
async function lockAndGetTotals(client, transactionId) {
  const lockResult = await client.query(
    `SELECT id FROM transactions WHERE id = $1 FOR UPDATE`,
    [transactionId]
  );
  if (lockResult.rows.length === 0) throw new NotFoundError('Transaction not found');
  const totalsResult = await client.query(SPLIT_TOTALS_SQL, [transactionId]);
  return mapSplitTotals(totalsResult.rows[0]);
}

export const splitRepository = {
  /**
   * Get split allocation totals for a transaction.
   *
   * @param {number} transactionId
   * @returns {Promise<SplitTotals|null>} null when the transaction does not exist
   */
  async getTransactionSplitTotals(transactionId) {
    const result = await query(SPLIT_TOTALS_SQL, [transactionId]);
    if (result.rows.length === 0) return null;
    return mapSplitTotals(result.rows[0]);
  },

  // NOTE: single-split creation goes through createSplitAtomic below — a
  // plain unguarded INSERT here (the old createSplit) bypassed the row lock
  // and over-allocation validation the atomic variants exist to enforce.

  /**
   * Atomically validate and create a single split.
   * Locks the transaction row with SELECT FOR UPDATE to prevent
   * concurrent over-allocation between check and insert.
   *
   * @param {{ transaction_id: number, recipient_id: number, amount: number|string, note?: string|null }} input
   * @returns {Promise<FormattedSplit>}
   */
  async createSplitAtomic({ transaction_id, recipient_id, amount, note }) {
    return withTransaction(async (client) => {
      const totals = await lockAndGetTotals(client, transaction_id);
      // Normalize to the NUMERIC(18,4) storage precision BEFORE validating, so
      // the value checked against the cap is byte-for-byte the value stored —
      // an un-normalized float here let the batch path and this path disagree.
      const normalizedAmount = normalizeMoneyAmount(Number(amount));
      const check = validateSplitAllocation({
        newSplitAmount: normalizedAmount,
        transactionTotal: totals.transaction_total,
        currentSplitTotal: totals.current_split_total,
      });
      if (!check.ok) throw new ValidationError(check.error);
      // The bare `RETURNING *` row is not the shape every other split-reading
      // endpoint emits: `amount` comes back as a pg NUMERIC string and neither
      // `recipient_name` nor `amount_paid` exists. Re-select the inserted row
      // joined to recipients (a fresh split has no payments, hence the literal
      // 0) so this returns the same formatSplit shape as
      // getSplitsByTransaction / settleSplit / getOwedByRecipient.
      const result = await client.query(
        `WITH created AS (
           INSERT INTO transaction_splits (transaction_id, recipient_id, amount, note)
           VALUES ($1, $2, $3, $4) RETURNING *
         )
         SELECT created.*, r.name AS recipient_name, 0 AS amount_paid
         FROM created
         LEFT JOIN recipients r ON r.id = created.recipient_id`,
        [transaction_id, recipient_id, normalizedAmount, note || null]
      );
      return formatSplit(result.rows[0]);
    });
  },

  /**
   * Atomically validate and create multiple splits.
   * Locks the transaction row with SELECT FOR UPDATE to prevent
   * concurrent over-allocation between check and batch insert.
   *
   * @param {{ transaction_id: number, splits: Array<{ recipient_id: number, amount: number|string, note?: string|null }> }} input
   * @returns {Promise<FormattedSplit[]>}
   */
  async createSplitsBatchAtomic({ transaction_id, splits }) {
    if (!Array.isArray(splits) || splits.length === 0) return [];
    return withTransaction(async (client) => {
      const totals = await lockAndGetTotals(client, transaction_id);
      const preparedSplits = splits.map((s) => ({
        recipient_id: s.recipient_id,
        // Domain precision (NUMERIC 18,4 — migration 0088), NOT cents: rounding
        // stored splits to cents is what made a 4-dp parent unsplittable.
        amount: normalizeMoneyAmount(Number(s.amount)),
        note: s.note || null,
      }));
      const check = validateBatchSplitAllocation({
        splits: preparedSplits,
        transactionTotal: totals.transaction_total,
        currentSplitTotal: totals.current_split_total,
      });
      if (!check.ok) throw new ValidationError(check.error);
      const recipientIds = preparedSplits.map((s) => s.recipient_id);
      const amounts = preparedSplits.map((s) => s.amount);
      const notes = preparedSplits.map((s) => s.note);
      // Same re-select as createSplitAtomic: `RETURNING *` alone would emit
      // string amounts and no recipient_name/amount_paid, which is not the
      // split shape the rest of the API returns.
      const result = await client.query(
        `WITH created AS (
           INSERT INTO transaction_splits (transaction_id, recipient_id, amount, note)
           SELECT $1, s.recipient_id, s.amount, s.note
           FROM UNNEST($2::int[], $3::numeric[], $4::text[]) AS s(recipient_id, amount, note)
           RETURNING *
         )
         SELECT created.*, r.name AS recipient_name, 0 AS amount_paid
         FROM created
         LEFT JOIN recipients r ON r.id = created.recipient_id
         ORDER BY created.id`,
        [transaction_id, recipientIds, amounts, notes]
      );
      return result.rows.map(formatSplit);
    });
  },

  /**
   * Get the splits for a specific transaction. `limit` is optional and defaults
   * to unbounded — the split editor shows every row of the transaction it is
   * editing, so only an explicit limit/offset narrows the result.
   *
   * @param {number} transactionId
   * @param {{ limit?: number|null, offset?: number }} [page]
   * @returns {Promise<FormattedSplit[]>}
   */
  async getSplitsByTransaction(transactionId, { limit = null, offset = 0 } = {}) {
    const params = [transactionId];
    const sql = `
      SELECT ts.*, r.name AS recipient_name,
             COALESCE(SUM(sp.amount), 0) AS amount_paid
      FROM transaction_splits ts
      LEFT JOIN recipients r ON ts.recipient_id = r.id
      LEFT JOIN split_payments sp ON sp.split_id = ts.id
      WHERE ts.transaction_id = $1
      GROUP BY ts.id, r.name
      ORDER BY ts.created_at
    ` + buildLimitOffset(params, { limit, offset });
    const result = await query(sql, params);
    return result.rows.map(formatSplit);
  },

  /**
   * Split count for a transaction — the `total` for a paginated list.
   *
   * @param {number} transactionId
   * @returns {Promise<number>}
   */
  async countSplitsByTransaction(transactionId) {
    const result = await query(
      'SELECT COUNT(*) FROM transaction_splits WHERE transaction_id = $1',
      [transactionId],
    );
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * Get all unsettled splits grouped by recipient (who owes what).
   *
   * Reads from agg_split_outstanding (trigger-maintained by migration
   * 0026) joined to recipients. Projection + filter + sort live in
   * lib/calculations/splits.js::computeOwedSummary so the shape is
   * golden-fixture covered.
   *
   * Settled splits are excluded at the source: is_settled=true splits
   * are kept in agg_split_outstanding (for historical totals) but joined
   * back via transaction_splits.is_settled here so fully-settled rows
   * drop out of the owed view.
   */
  /**
   * Returns the FULL summary — no SQL LIMIT here on purpose. The rows are
   * projected, filtered (zero-remaining groups drop out) and re-sorted by
   * computeOwedSummary after the aggregate, so a LIMIT pushed into the query
   * would page pre-projection rows and hand back the wrong slice; the route
   * slices the computed array instead. Cardinality is one row per recipient
   * with outstanding splits, not per split.
   *
   * @returns {Promise<ReturnType<typeof computeOwedSummary>>}
   */
  async getOwedSummary() {
    // Collapse alias recipients into their primary so linked recipients show
    // as a single row. recipient_id returned is the primary's id (or self
    // when not aliased) — the detail endpoint expands this back to the full
    // group via getOwedByRecipient.
    const sql = `
      SELECT COALESCE(r.primary_recipient_id, r.id) AS recipient_id,
             COALESCE(pr.name, r.name) AS recipient_name,
             SUM(a.original_amount) AS total_owed,
             SUM(a.paid_amount) AS total_paid,
             COUNT(a.split_id) AS split_count
      FROM agg_split_outstanding a
      JOIN recipients r ON r.id = a.recipient_id
      LEFT JOIN recipients pr ON pr.id = r.primary_recipient_id
      JOIN transaction_splits ts ON ts.id = a.split_id
      WHERE ts.is_settled = false
      GROUP BY COALESCE(r.primary_recipient_id, r.id), COALESCE(pr.name, r.name)
    `;
    const result = await query(sql, []);
    return computeOwedSummary(result.rows);
  },

  /**
   * Get detailed unsettled splits for a specific recipient. `limit` is optional
   * and defaults to unbounded — the owed-detail drawer lists the recipient's
   * whole outstanding history, so only an explicit limit/offset narrows it.
   *
   * @param {number} recipientId
   * @param {{ limit?: number|null, offset?: number }} [page]
   * @returns {Promise<OwedSplitDetailRow[]>}
   */
  async getOwedByRecipient(recipientId, { limit = null, offset = 0 } = {}) {
    const params = [recipientId];
    const sql = `
      ${RECIPIENT_GROUP_CTE}
      SELECT ts.*,
             t.date AS transaction_date,
             t.memo AS transaction_memo,
             t.amount AS transaction_amount,
             t.currency AS transaction_currency,
             acct.name AS bank_account,
             COALESCE(pr.name, r.name) AS transaction_recipient_name,
             COALESCE(sp_agg.paid, 0) AS amount_paid
      FROM transaction_splits ts
      JOIN transactions t ON ts.transaction_id = t.id
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN accounts acct ON t.account_id = acct.id
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS paid FROM split_payments WHERE split_id = ts.id
      ) sp_agg ON true
      WHERE ts.recipient_id IN (SELECT id FROM recipient_group) AND ts.is_settled = false
      ORDER BY t.date DESC
    ` + buildLimitOffset(params, { limit, offset });
    const result = await query(sql, params);
    return result.rows.map((/** @type {any} */ row) => ({
      ...formatSplit(row),
      transaction_date: row.transaction_date,
      transaction_memo: row.transaction_memo,
      transaction_amount: toNumber(toDecimal(row.transaction_amount)),
      transaction_currency: row.transaction_currency,
      bank_account: row.bank_account,
      transaction_recipient_name: row.transaction_recipient_name,
      amount_paid: toNumber(toDecimal(row.amount_paid)),
      remaining: toNumber(subtract(row.amount, row.amount_paid)),
    }));
  },

  /**
   * Count a recipient's unsettled splits (same alias-group + settled filter as
   * getOwedByRecipient) — the `total` for a paginated list.
   *
   * @param {number} recipientId
   * @returns {Promise<number>}
   */
  async countOwedByRecipient(recipientId) {
    const sql = `
      ${RECIPIENT_GROUP_CTE}
      SELECT COUNT(*)
      FROM transaction_splits ts
      WHERE ts.recipient_id IN (SELECT id FROM recipient_group) AND ts.is_settled = false
    `;
    const result = await query(sql, [recipientId]);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * Export unsettled split transactions for a specific recipient in transaction CSV shape.
   * Amount is replaced by the split remaining amount to settle.
   *
   * `date` and `balance` stay raw (a pg `Date` and a NUMERIC string) — only
   * `amount` is coerced, because only that one is recomputed here.
   *
   * @param {number} recipientId
   * @returns {Promise<Array<{
   *   date: Date,
   *   bank_account: string|null,
   *   recipient_name: string|null,
   *   memo: string|null,
   *   amount: number,
   *   currency: string|null,
   *   balance: string|null,
   *   category_name: string,
   *   comment: string|null,
   * }>>}
   */
  async getOwedExportRowsByRecipient(recipientId) {
    const sql = `
      ${RECIPIENT_GROUP_CTE}
      SELECT
        t.date,
        acct.name AS bank_account,
        COALESCE(pr.name, tr.name) AS recipient_name,
        t.memo,
        (ts.amount - COALESCE(sp_agg.paid, 0)) AS amount,
        t.currency,
        t.balance,
        -- Same branch order as transactionRepository's CATEGORY_NAME_SQL:
        -- own (c) → transaction recipient default (rc) → primary-recipient
        -- default (pc), mirroring COALESCE(t.category_id,
        -- tr.default_category_id, pr.default_category_id). It used to test pc
        -- before rc, so an ALIAS recipient with its own default under a
        -- differently-defaulted PRIMARY exported the primary's category name
        -- while the transactions list showed the alias's.
        CASE
          WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
          WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
          WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
          ELSE ''
        END AS category_name,
        t.comment
      FROM transaction_splits ts
      JOIN transactions t ON ts.transaction_id = t.id
      LEFT JOIN accounts acct ON t.account_id = acct.id
      LEFT JOIN recipients tr ON t.recipient_id = tr.id
      LEFT JOIN recipients pr ON tr.primary_recipient_id = pr.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories rc ON tr.default_category_id = rc.id
      LEFT JOIN categories pc ON pr.default_category_id = pc.id
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS paid
        FROM split_payments
        WHERE split_id = ts.id
      ) sp_agg ON true
      WHERE ts.recipient_id IN (SELECT id FROM recipient_group)
        AND ts.is_settled = false
        AND (ts.amount - COALESCE(sp_agg.paid, 0)) > 0
      ORDER BY t.date ASC
    `;

    const result = await query(sql, [recipientId]);
    return result.rows.map((/** @type {any} */ row) => ({
      ...row,
      amount: toNumber(toDecimal(row.amount)),
    }));
  },

  /**
   * Record a payment against a split.
   *
   * Atomicity: locks the split row with SELECT … FOR UPDATE, sums existing
   * payments, validates against overpayment, then INSERTs / auto-settles /
   * audits — all in one transaction. The lock serializes concurrent /pay
   * requests so the validate→insert window cannot interleave (without it,
   * five parallel payments could each pass the precheck and collectively
   * overpay). There is NO DB-level overpayment trigger (an earlier comment
   * cited an aspirational fn_split_payment_overpayment_guard that was never
   * shipped) — this lock + validation IS the guard.
   *
   * Amount handling: the payment is normalized to the NUMERIC(18,4) storage
   * precision and the cap is compared at that same scale (migration 0088);
   * a cent-level cap with 4-dp storage admitted sub-cent over-payments.
   *
   * Throws NotFoundError if the split does not exist; ValidationError if
   * the split is already settled or the payment would overpay.
   *
   * @param {{
   *   split_id: number,
   *   amount: number,
   *   note?: string | null,
   *   paid_at?: string | null,
   *   actor?: string | null,
   * }} input
   * @returns {Promise<FormattedSplitPayment>}
   */
  async addPayment({ split_id, amount, note, paid_at, actor = null }) {
    return withTransaction(async (client) => {
      const lockResult = await client.query(
        `SELECT id, amount, is_settled FROM transaction_splits WHERE id = $1 FOR UPDATE`,
        [split_id]
      );
      if (lockResult.rows.length === 0) {
        throw new NotFoundError('Split not found');
      }
      if (lockResult.rows[0].is_settled) {
        // A settled split is closed — further payments would push it past its
        // amount (or resurrect settled dust) with nothing left to settle.
        throw new ValidationError('Split is already settled');
      }
      const splitAmount = lockResult.rows[0].amount;

      const paidResult = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS paid
         FROM split_payments WHERE split_id = $1`,
        [split_id]
      );
      const alreadyPaid = paidResult.rows[0].paid;

      // Validate at the NUMERIC(18,4) storage precision with the normalized
      // amount that will actually be inserted (see the method docstring).
      const normalizedAmount = normalizeMoneyAmount(amount);
      const projected = roundToMoneyPrecision(toDecimal(alreadyPaid).plus(normalizedAmount));
      const limit = roundToMoneyPrecision(splitAmount);
      if (projected.gt(limit)) {
        throw new ValidationError('Payment would exceed split outstanding balance');
      }

      const insertSql = `
        INSERT INTO split_payments (split_id, amount, note, paid_at)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;
      const result = await client.query(insertSql, [
        split_id,
        normalizedAmount,
        note || null,
        // Default to today's calendar date in APP_TIMEZONE — server-local
        // getFullYear/getMonth/getDate logged the wrong day near midnight on
        // a non-UTC server.
        paid_at || toAppDateString(new Date()),
      ]);

      // Auto-settle only when the payments cover the split EXACTLY at storage
      // precision (both sides NUMERIC(18,4) — migration 0088). The old
      // ROUND(…, 2) comparison settled a 4-dp split at a cent-rounded match,
      // freezing sub-cent residue as "settled". `>=` (not `=`) so pre-0088
      // rows that were historically over-paid can still close out.
      const settledResult = await client.query(
        `UPDATE transaction_splits ts
         SET is_settled = true
         WHERE ts.id = $1
           AND ts.is_settled = false
           AND (
             SELECT COALESCE(SUM(sp.amount), 0)
             FROM split_payments sp
             WHERE sp.split_id = ts.id
           ) >= ts.amount
         RETURNING id`,
        [split_id]
      );

      await client.query(
        `INSERT INTO split_audit (split_id, action, actor, payload)
         VALUES ($1, $2, $3, $4)`,
        [
          split_id,
          'payment',
          actor,
          JSON.stringify({
            payment_id: result.rows[0].id,
            amount: normalizedAmount,
            paid_at: toWireDate(result.rows[0].paid_at),
            note: note || null,
            auto_settled: settledResult.rowCount > 0,
          }),
        ]
      );

      // formatPayment, not the raw row: `amount` is NUMERIC (pg hands it back
      // as a string) and `paid_at` is a DATE. The POST /pay path used to
      // return the row untouched while its sibling getPayments coerced, so the
      // same payment had two different wire shapes.
      return formatPayment(result.rows[0]);
    });
  },

  /**
   * Get payments for a split. `limit` is optional and defaults to unbounded —
   * the payment history panel lists them all, so only an explicit limit/offset
   * narrows the result.
   *
   * @param {number} splitId
   * @param {{ limit?: number|null, offset?: number }} [page]
   * @returns {Promise<FormattedSplitPayment[]>}
   */
  async getPayments(splitId, { limit = null, offset = 0 } = {}) {
    const params = [splitId];
    const sql = `SELECT * FROM split_payments WHERE split_id = $1 ORDER BY paid_at DESC`
      + buildLimitOffset(params, { limit, offset });
    const result = await query(sql, params);
    return result.rows.map(formatPayment);
  },

  /**
   * Payment count for a split — the `total` for a paginated list.
   *
   * @param {number} splitId
   * @returns {Promise<number>}
   */
  async countPayments(splitId) {
    const result = await query(
      'SELECT COUNT(*) FROM split_payments WHERE split_id = $1',
      [splitId],
    );
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * Settle a split manually (mark as fully paid regardless of payments).
   *
   * Same re-select idiom as createSplitAtomic: a bare `RETURNING *` row has no
   * `recipient_name`/`amount_paid` columns, so the settle response used to
   * fabricate `recipient_name: null` and `amount_paid: 0` (`toDecimal(undefined)`
   * → 0) even on a fully-paid split. The CTE re-selects the updated row joined
   * to recipients plus the per-split payment aggregate so the emitted
   * `FormattedSplit` carries the real values.
   *
   * @param {number} splitId
   * @returns {Promise<FormattedSplit|null>}
   */
  async settleSplit(splitId) {
    const sql = `
      WITH settled AS (
        UPDATE transaction_splits SET is_settled = true WHERE id = $1 RETURNING *
      )
      SELECT settled.*, r.name AS recipient_name,
             COALESCE(sp_agg.paid, 0) AS amount_paid
      FROM settled
      LEFT JOIN recipients r ON r.id = settled.recipient_id
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS paid FROM split_payments WHERE split_id = settled.id
      ) sp_agg ON true
    `;
    const result = await query(sql, [splitId]);
    return result.rows[0] ? formatSplit(result.rows[0]) : null;
  },

  /**
   * @param {number} recipientId
   * @returns {Promise<{ settled_count: number }>}
   */
  async settleAllByRecipient(recipientId) {
    const sql = `
      ${RECIPIENT_GROUP_CTE}
      UPDATE transaction_splits
      SET is_settled = true
      WHERE recipient_id IN (SELECT id FROM recipient_group) AND is_settled = false
    `;
    const result = await query(sql, [recipientId]);
    return { settled_count: result.rowCount || 0 };
  },

  /**
   * Delete a split.
   *
   * @param {number} splitId
   * @returns {Promise<boolean>}
   */
  async deleteSplit(splitId) {
    const result = await query('DELETE FROM transaction_splits WHERE id = $1', [splitId]);
    return result.rowCount > 0;
  },

  /**
   * Fetch a single split row. Used by route-layer validation before writes so
   * we can pass split.amount into validatePaymentAmount.
   *
   * Joined to recipients and the per-split payment aggregate (same shape as
   * getSplitsByTransaction) so the row carries the real `recipient_name` /
   * `amount_paid` instead of the fabricated null/0 a bare `SELECT *` produced.
   *
   * @param {number} splitId
   * @returns {Promise<FormattedSplit|null>}
   */
  async getSplitById(splitId) {
    const sql = `
      SELECT ts.*, r.name AS recipient_name,
             COALESCE(sp_agg.paid, 0) AS amount_paid
      FROM transaction_splits ts
      LEFT JOIN recipients r ON ts.recipient_id = r.id
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS paid FROM split_payments WHERE split_id = ts.id
      ) sp_agg ON true
      WHERE ts.id = $1
    `;
    const result = await query(sql, [splitId]);
    return result.rows[0] ? formatSplit(result.rows[0]) : null;
  },

  /**
   * Sum of existing payments against a split. Used by route-layer
   * overpayment validation before INSERT. The authoritative guard is
   * addPayment's row lock + storage-precision validation (there is no
   * DB-level overpayment trigger — an earlier comment cited an aspirational
   * fn_split_payment_overpayment_guard that was never shipped).
   *
   * @param {number} splitId
   * @returns {Promise<number>}
   */
  async getAlreadyPaid(splitId) {
    const sql = `
      SELECT COALESCE(SUM(amount), 0) AS paid
      FROM split_payments
      WHERE split_id = $1
    `;
    const result = await query(sql, [splitId]);
    return toNumber(toDecimal(result.rows[0].paid));
  },

  /**
   * Append a split_audit row. Accepts an optional pg client so the caller
   * can write the audit inside the same transaction as the mutation.
   *
   * @param {{
   *   split_id: number | null,
   *   action: string,
   *   actor?: string | null,
   *   payload?: object | null,
   *   client?: QueryRunner | null,
   * }} input
   * @returns {Promise<{ id: string }>} `split_audit.id` is BIGSERIAL — a string
   */
  async writeAudit({ split_id, action, actor = null, payload = null, client = null }) {
    const sql = `
      INSERT INTO split_audit (split_id, action, actor, payload)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    const params = [split_id, action, actor, payload ? JSON.stringify(payload) : null];
    const runner = client || { query };
    const result = await runner.query(sql, params);
    return result.rows[0];
  },

  /**
   * Repoint splits off merged alias recipients onto the primary (ADR-014).
   *
   * @param {number} primaryId
   * @param {number[]} aliasIds
   * @returns {Promise<number>} rows repointed
   */
  async repointRecipient(primaryId, aliasIds) {
    const result = await query(
      `UPDATE transaction_splits
          SET recipient_id = $1
        WHERE recipient_id = ANY($2::int[])`,
      [primaryId, aliasIds],
    );
    return result.rowCount ?? 0;
  },
};

/**
 * Wire shape for a split_payments row: NUMERIC `amount` coerced to a number,
 * DATE `paid_at` rendered as a calendar-day string. Shared by every endpoint
 * that emits a payment so POST /pay and GET /payments cannot drift apart.
 *
 * @param {any} row raw `split_payments` row
 * @returns {FormattedSplitPayment}
 */
function formatPayment(row) {
  return {
    ...row,
    amount: toNumber(toDecimal(row.amount)),
    // DATE column: calendar-day string, not a raw pg Date.
    paid_at: toWireDate(row.paid_at),
  };
}

/**
 * Wire shape for a `transaction_splits` row: NUMERIC `amount` / `amount_paid`
 * coerced to numbers, timestamps left as pg `Date`s.
 *
 * @param {any} row
 * @returns {FormattedSplit}
 */
function formatSplit(row) {
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    recipient_id: row.recipient_id,
    recipient_name: row.recipient_name || null,
    amount: toNumber(toDecimal(row.amount)),
    amount_paid: toNumber(toDecimal(row.amount_paid)),
    note: row.note,
    is_settled: row.is_settled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export default splitRepository;
