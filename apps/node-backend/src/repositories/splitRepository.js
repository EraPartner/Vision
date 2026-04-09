/**
 * Split Repository - data access for transaction_splits and split_payments tables.
 */

import { getClient, query } from '../database/connection.js';

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
      transaction_total: parseFloat(result.rows[0].transaction_total),
      current_split_total: parseFloat(result.rows[0].current_split_total),
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
   * Create multiple splits in a single query.
   */
  async createSplitsBatch({ transaction_id, splits }) {
    if (!Array.isArray(splits) || splits.length === 0) return [];

    const recipientIds = splits.map((split) => split.recipient_id);
    const amounts = splits.map((split) => split.amount);
    const notes = splits.map((split) => split.note || null);

    const sql = `
      INSERT INTO transaction_splits (transaction_id, recipient_id, amount, note)
      SELECT $1, s.recipient_id, s.amount, s.note
      FROM UNNEST($2::int[], $3::numeric[], $4::text[]) AS s(recipient_id, amount, note)
      RETURNING *
    `;
    const result = await query(sql, [transaction_id, recipientIds, amounts, notes]);
    return result.rows;
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
   */
  async getOwedSummary() {
    const sql = `
      SELECT ts.recipient_id,
             r.name AS recipient_name,
             SUM(ts.amount) AS total_owed,
             COALESCE(SUM(sp_agg.paid), 0) AS total_paid,
             COUNT(DISTINCT ts.id) AS split_count
      FROM transaction_splits ts
      JOIN recipients r ON ts.recipient_id = r.id
      LEFT JOIN (
        SELECT split_id, SUM(amount) AS paid FROM split_payments GROUP BY split_id
      ) sp_agg ON sp_agg.split_id = ts.id
      WHERE ts.is_settled = false
       GROUP BY ts.recipient_id, r.name
       HAVING SUM(ts.amount) - COALESCE(SUM(sp_agg.paid), 0) > 0
       ORDER BY SUM(ts.amount) - COALESCE(SUM(sp_agg.paid), 0) DESC
    `;
    const result = await query(sql, []);
    return result.rows.map(row => ({
      recipient_id: row.recipient_id,
      recipient_name: row.recipient_name,
      total_owed: parseFloat(row.total_owed),
      total_paid: parseFloat(row.total_paid),
      remaining: parseFloat(row.total_owed) - parseFloat(row.total_paid),
      split_count: parseInt(row.split_count, 10),
    }));
  },

  /**
   * Get detailed unsettled splits for a specific recipient.
   */
  async getOwedByRecipient(recipientId) {
    const sql = `
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
      WHERE ts.recipient_id = $1 AND ts.is_settled = false
      ORDER BY t.date DESC
    `;
    const result = await query(sql, [recipientId]);
    return result.rows.map(row => ({
      ...formatSplit(row),
      transaction_date: row.transaction_date,
      transaction_memo: row.transaction_memo,
      transaction_amount: parseFloat(row.transaction_amount),
      transaction_currency: row.transaction_currency,
      bank_account: row.bank_account,
      transaction_recipient_name: row.transaction_recipient_name,
      amount_paid: parseFloat(row.amount_paid),
      remaining: parseFloat(row.amount) - parseFloat(row.amount_paid),
    }));
  },

  /**
   * Export unsettled split transactions for a specific recipient in transaction CSV shape.
   * Amount is replaced by the split remaining amount to settle.
   */
  async getOwedExportRowsByRecipient(recipientId) {
    const sql = `
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
      WHERE ts.recipient_id = $1
        AND ts.is_settled = false
        AND (ts.amount - COALESCE(sp_agg.paid, 0)) > 0
      ORDER BY t.date ASC
    `;

    const result = await query(sql, [recipientId]);
    return result.rows.map((row) => ({
      ...row,
      amount: parseFloat(row.amount),
    }));
  },

  /**
   * Record a payment against a split.
   */
  async addPayment({ split_id, amount, note, paid_at }) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const insertSql = `
        INSERT INTO split_payments (split_id, amount, note, paid_at)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;
      const result = await client.query(insertSql, [
        split_id,
        amount,
        note || null,
        paid_at || new Date().toISOString().split('T')[0],
      ]);

      await client.query(
        `UPDATE transaction_splits ts
         SET is_settled = true
         WHERE ts.id = $1
           AND ts.is_settled = false
           AND (
             SELECT COALESCE(SUM(sp.amount), 0)
             FROM split_payments sp
             WHERE sp.split_id = ts.id
           ) >= ts.amount`,
        [split_id]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Get payments for a split.
   */
  async getPayments(splitId) {
    const sql = `SELECT * FROM split_payments WHERE split_id = $1 ORDER BY paid_at DESC`;
    const result = await query(sql, [splitId]);
    return result.rows.map(row => ({
      ...row,
      amount: parseFloat(row.amount),
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
      UPDATE transaction_splits
      SET is_settled = true
      WHERE recipient_id = $1 AND is_settled = false
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
};

function formatSplit(row) {
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    recipient_id: row.recipient_id,
    recipient_name: row.recipient_name || null,
    amount: parseFloat(row.amount),
    amount_paid: row.amount_paid != null ? parseFloat(row.amount_paid) : 0,
    note: row.note,
    is_settled: row.is_settled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export default splitRepository;
