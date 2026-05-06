/**
 * Split Repository - data access for transaction_splits and split_payments tables.
 *
 * Owed-summary reads from agg_split_outstanding (trigger-maintained by
 * migration 0026) instead of a live aggregate join. Audit events are
 * written via writeAudit; route/service layer owns when to emit them.
 */

import { query, withTransaction } from '../database/connection.js';
import {
  computeOwedSummary,
  validateSplitAllocation,
  validateBatchSplitAllocation,
  roundToCents as roundToCentsCalc,
} from '../services/calculations/splits.js';
import { toDecimal, subtract, toNumber, roundToCents } from '../lib/money.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

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

export const splitRepository = {
  /**
   * Get split allocation totals for a transaction.
   */
  async getTransactionSplitTotals(transactionId) {
    const sql = `
      SELECT ABS(t.amount) AS transaction_total,
             COALESCE(SUM(ts.amount), 0) AS current_split_total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      WHERE t.id = $1
      GROUP BY t.id, t.amount
    `;
    const result = await query(sql, [transactionId]);
    if (result.rows.length === 0) return null;
    return {
      transaction_total: toNumber(toDecimal(result.rows[0].transaction_total)),
      current_split_total: toNumber(toDecimal(result.rows[0].current_split_total)),
    };
  },

  /**
   * Create a new split for a transaction.
   */
  async createSplit({ transaction_id, recipient_id, amount, note }) {
    const sql = `
      INSERT INTO transaction_splits (transaction_id, recipient_id, amount, note)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const result = await query(sql, [transaction_id, recipient_id, amount, note || null]);
    return result.rows[0];
  },

  /**
   * Atomically validate and create a single split.
   * Locks the transaction row with SELECT FOR UPDATE to prevent
   * concurrent over-allocation between check and insert.
   */
  async createSplitAtomic({ transaction_id, recipient_id, amount, note }) {
    return withTransaction(async (client) => {
      const lockResult = await client.query(
        `SELECT ABS(t.amount) AS transaction_total,
                COALESCE(SUM(ts.amount), 0) AS current_split_total
           FROM transactions t
           LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
          WHERE t.id = $1
          GROUP BY t.id, t.amount
          FOR UPDATE OF t`,
        [transaction_id]
      );
      if (lockResult.rows.length === 0) throw new NotFoundError('Transaction not found');
      const totals = {
        transaction_total: toNumber(toDecimal(lockResult.rows[0].transaction_total)),
        current_split_total: toNumber(toDecimal(lockResult.rows[0].current_split_total)),
      };
      const check = validateSplitAllocation({
        newSplitAmount: Number(amount),
        transactionTotal: totals.transaction_total,
        currentSplitTotal: totals.current_split_total,
      });
      if (!check.ok) throw new ValidationError(check.error);
      const result = await client.query(
        `INSERT INTO transaction_splits (transaction_id, recipient_id, amount, note)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [transaction_id, recipient_id, amount, note || null]
      );
      return result.rows[0];
    });
  },

  /**
   * Atomically validate and create multiple splits.
   * Locks the transaction row with SELECT FOR UPDATE to prevent
   * concurrent over-allocation between check and batch insert.
   */
  async createSplitsBatchAtomic({ transaction_id, splits }) {
    if (!Array.isArray(splits) || splits.length === 0) return [];
    return withTransaction(async (client) => {
      const lockResult = await client.query(
        `SELECT ABS(t.amount) AS transaction_total,
                COALESCE(SUM(ts.amount), 0) AS current_split_total
           FROM transactions t
           LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
          WHERE t.id = $1
          GROUP BY t.id, t.amount
          FOR UPDATE OF t`,
        [transaction_id]
      );
      if (lockResult.rows.length === 0) throw new NotFoundError('Transaction not found');
      const totals = {
        transaction_total: toNumber(toDecimal(lockResult.rows[0].transaction_total)),
        current_split_total: toNumber(toDecimal(lockResult.rows[0].current_split_total)),
      };
      const preparedSplits = splits.map((s) => ({
        recipient_id: s.recipient_id,
        amount: roundToCentsCalc(Number(s.amount)),
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
      const result = await client.query(
        `INSERT INTO transaction_splits (transaction_id, recipient_id, amount, note)
         SELECT $1, s.recipient_id, s.amount, s.note
         FROM UNNEST($2::int[], $3::numeric[], $4::text[]) AS s(recipient_id, amount, note)
         RETURNING *`,
        [transaction_id, recipientIds, amounts, notes]
      );
      return result.rows;
    });
  },

  /**
   * Get all splits for a specific transaction.
   */
  async getSplitsByTransaction(transactionId) {
    const sql = `
      SELECT ts.*, r.name AS recipient_name,
             COALESCE(SUM(sp.amount), 0) AS amount_paid
      FROM transaction_splits ts
      LEFT JOIN recipients r ON ts.recipient_id = r.id
      LEFT JOIN split_payments sp ON sp.split_id = ts.id
      WHERE ts.transaction_id = $1
      GROUP BY ts.id, r.name
      ORDER BY ts.created_at
    `;
    const result = await query(sql, [transactionId]);
    return result.rows.map(formatSplit);
  },

  /**
   * Get all unsettled splits grouped by recipient (who owes what).
   *
   * Reads from agg_split_outstanding (trigger-maintained by migration
   * 0026) joined to recipients. Projection + filter + sort live in
   * services/calculations/splits.js::computeOwedSummary so the shape is
   * golden-fixture covered.
   *
   * Settled splits are excluded at the source: is_settled=true splits
   * are kept in agg_split_outstanding (for historical totals) but joined
   * back via transaction_splits.is_settled here so fully-settled rows
   * drop out of the owed view.
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
   * Get detailed unsettled splits for a specific recipient.
   */
  async getOwedByRecipient(recipientId) {
    const sql = `
      ${RECIPIENT_GROUP_CTE}
      SELECT ts.*,
             t.date AS transaction_date,
             t.memo AS transaction_memo,
             t.amount AS transaction_amount,
             t.currency AS transaction_currency,
             t.bank_account,
             COALESCE(pr.name, r.name) AS transaction_recipient_name,
             COALESCE(sp_agg.paid, 0) AS amount_paid
      FROM transaction_splits ts
      JOIN transactions t ON ts.transaction_id = t.id
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN (
        SELECT split_id, SUM(amount) AS paid FROM split_payments GROUP BY split_id
      ) sp_agg ON sp_agg.split_id = ts.id
      WHERE ts.recipient_id IN (SELECT id FROM recipient_group) AND ts.is_settled = false
      ORDER BY t.date DESC
    `;
    const result = await query(sql, [recipientId]);
    return result.rows.map(row => ({
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
   * Export unsettled split transactions for a specific recipient in transaction CSV shape.
   * Amount is replaced by the split remaining amount to settle.
   */
  async getOwedExportRowsByRecipient(recipientId) {
    const sql = `
      ${RECIPIENT_GROUP_CTE}
      SELECT
        t.date,
        t.bank_account,
        COALESCE(pr.name, tr.name) AS recipient_name,
        t.memo,
        (ts.amount - COALESCE(sp_agg.paid, 0)) AS amount,
        t.currency,
        t.balance,
        CASE
          WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
          WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
          WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
          ELSE ''
        END AS category_name,
        t.comment
      FROM transaction_splits ts
      JOIN transactions t ON ts.transaction_id = t.id
      LEFT JOIN recipients tr ON t.recipient_id = tr.id
      LEFT JOIN recipients pr ON tr.primary_recipient_id = pr.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories rc ON tr.default_category_id = rc.id
      LEFT JOIN categories pc ON pr.default_category_id = pc.id
      LEFT JOIN (
        SELECT split_id, SUM(amount) AS paid
        FROM split_payments
        GROUP BY split_id
      ) sp_agg ON sp_agg.split_id = ts.id
      WHERE ts.recipient_id IN (SELECT id FROM recipient_group)
        AND ts.is_settled = false
        AND (ts.amount - COALESCE(sp_agg.paid, 0)) > 0
      ORDER BY t.date ASC
    `;

    const result = await query(sql, [recipientId]);
    return result.rows.map((row) => ({
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
   * overpay). DB-level trigger fn_split_payment_overpayment_guard remains
   * as defense-in-depth.
   *
   * Throws NotFoundError if the split does not exist; ValidationError if
   * the payment would overpay.
   *
   * @param {{
   *   split_id: number,
   *   amount: number,
   *   note?: string | null,
   *   paid_at?: string | null,
   *   actor?: string | null,
   * }} input
   */
  async addPayment({ split_id, amount, note, paid_at, actor = null }) {
    return withTransaction(async (client) => {
      const lockResult = await client.query(
        `SELECT id, amount FROM transaction_splits WHERE id = $1 FOR UPDATE`,
        [split_id]
      );
      if (lockResult.rows.length === 0) {
        throw new NotFoundError('Split not found');
      }
      const splitAmount = lockResult.rows[0].amount;

      const paidResult = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS paid
         FROM split_payments WHERE split_id = $1`,
        [split_id]
      );
      const alreadyPaid = paidResult.rows[0].paid;

      const projected = roundToCents(toDecimal(alreadyPaid).plus(amount));
      const limit = roundToCents(splitAmount);
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
        amount,
        note || null,
        paid_at || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })(),
      ]);

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
            amount: Number(amount),
            paid_at: result.rows[0].paid_at,
            note: note || null,
            auto_settled: settledResult.rowCount > 0,
          }),
        ]
      );

      return result.rows[0];
    });
  },

  /**
   * Get payments for a split.
   */
  async getPayments(splitId) {
    const sql = `SELECT * FROM split_payments WHERE split_id = $1 ORDER BY paid_at DESC`;
    const result = await query(sql, [splitId]);
    return result.rows.map(row => ({
      ...row,
      amount: toNumber(toDecimal(row.amount)),
    }));
  },

  /**
   * Settle a split manually (mark as fully paid regardless of payments).
   */
  async settleSplit(splitId) {
    const sql = `UPDATE transaction_splits SET is_settled = true WHERE id = $1 RETURNING *`;
    const result = await query(sql, [splitId]);
    return result.rows[0] ? formatSplit(result.rows[0]) : null;
  },

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
   */
  async deleteSplit(splitId) {
    const result = await query('DELETE FROM transaction_splits WHERE id = $1', [splitId]);
    return result.rowCount > 0;
  },

  /**
   * Fetch a single split row (no join). Used by route-layer validation
   * before writes so we can pass split.amount into validatePaymentAmount.
   */
  async getSplitById(splitId) {
    const sql = `SELECT * FROM transaction_splits WHERE id = $1`;
    const result = await query(sql, [splitId]);
    return result.rows[0] ? formatSplit(result.rows[0]) : null;
  },

  /**
   * Sum of existing payments against a split. Used by route-layer
   * overpayment validation before INSERT. DB-level trigger
   * (fn_split_payment_overpayment_guard) is the second line of defense.
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
   *   client?: import('pg').PoolClient,
   * }} input
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
};

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
