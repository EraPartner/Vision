/**
 * Planned Transaction Repository - data access for planned_transactions table.
 *
 * Mirrors: apps/backend/repositories/planned_transaction_repository.py
 */

import { getClient, query } from '../database/connection.js';
import { sanitizeUpdateFields } from '../middleware/validation.js';

export const plannedTransactionRepository = {
  async getAll({
    limit = 50, offset = 0, startDate = null, endDate = null,
    bankAccount = null, categoryId = null, recipientId = null,
    isRecurring = null, isExecuted = null, search = null, active = true,
  } = {}) {
    let sql = `
      SELECT pt.*,
             r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name,
             (SELECT count(*) FROM planned_transaction_executions pte WHERE pte.planned_transaction_id = pt.id) AS execution_count
      FROM planned_transactions pt
      LEFT JOIN recipients r ON pt.recipient_id = r.id
      LEFT JOIN categories c ON pt.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (active) sql += ` AND pt.is_active = true`;
    if (startDate) { sql += ` AND pt.planned_date >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND pt.planned_date <= $${paramIdx++}`; params.push(endDate); }
    if (bankAccount) { sql += ` AND pt.bank_account ILIKE $${paramIdx++}`; params.push(`%${bankAccount}%`); }
    if (categoryId != null) { sql += ` AND pt.category_id = $${paramIdx++}`; params.push(categoryId); }
    if (recipientId != null) { sql += ` AND pt.recipient_id = $${paramIdx++}`; params.push(recipientId); }
    if (isRecurring != null) { sql += ` AND pt.is_recurring = $${paramIdx++}`; params.push(isRecurring); }
    if (isExecuted != null) { sql += ` AND pt.is_executed = $${paramIdx++}`; params.push(isExecuted); }
    if (search) {
      const sp = `%${search}%`;
      sql += ` AND (
        pt.memo ILIKE $${paramIdx} OR
        pt.comment ILIKE $${paramIdx} OR
        pt.bank_account ILIKE $${paramIdx} OR
        r.name ILIKE $${paramIdx} OR
        c.general ILIKE $${paramIdx} OR
        c.detail ILIKE $${paramIdx} OR
        rc.general ILIKE $${paramIdx} OR
        rc.detail ILIKE $${paramIdx}
      )`;
      paramIdx++;
      params.push(sp);
    }

    // Count query — wrap the filtered query and count its rows
    const countSql = `SELECT count(*) FROM (${sql}) AS _counted`;
    const countResult = await query(countSql, params);
    const total = parseInt(countResult.rows[0].count, 10);

    sql += ` ORDER BY pt.planned_date DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    // Fetch executions for each
    for (const row of result.rows) {
      const execResult = await query(
        `SELECT * FROM planned_transaction_executions WHERE planned_transaction_id = $1 ORDER BY execution_date DESC`,
        [row.id]
      );
      row.executions = execResult.rows;
      row.executed_transaction_id = execResult.rows.length > 0 ? execResult.rows[0].executed_transaction_id : null;
      if (row.is_loan) {
        const scheduleResult = await query(
          `SELECT installment_number, due_date, payment_amount, principal_amount, interest_amount, remaining_principal
             FROM planned_transaction_loan_schedule
            WHERE planned_transaction_id = $1
            ORDER BY installment_number ASC`,
          [row.id]
        );
        row.loan_schedule = scheduleResult.rows;
      } else {
        row.loan_schedule = [];
      }
    }

    return { items: result.rows, total };
  },

  async getById(id) {
    const sql = `
      SELECT pt.*,
             r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name
      FROM planned_transactions pt
      LEFT JOIN recipients r ON pt.recipient_id = r.id
      LEFT JOIN categories c ON pt.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      WHERE pt.id = $1
    `;
    const result = await query(sql, [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const execResult = await query(
      `SELECT * FROM planned_transaction_executions WHERE planned_transaction_id = $1 ORDER BY execution_date DESC`,
      [id]
    );
    row.executions = execResult.rows;
    row.execution_count = execResult.rows.length;
    row.executed_transaction_id = execResult.rows.length > 0 ? execResult.rows[0].executed_transaction_id : null;

    if (row.is_loan) {
      const scheduleResult = await query(
        `SELECT installment_number, due_date, payment_amount, principal_amount, interest_amount, remaining_principal
           FROM planned_transaction_loan_schedule
          WHERE planned_transaction_id = $1
          ORDER BY installment_number ASC`,
        [id]
      );
      row.loan_schedule = scheduleResult.rows;
    } else {
      row.loan_schedule = [];
    }

    return row;
  },

  async create({
    planned_date,
    bank_account,
    recipient_id,
    amount,
    memo,
    currency,
    category_id,
    comment,
    url,
    is_recurring,
    recurrence_pattern,
    is_loan,
    loan_type,
    loan_principal,
    loan_annual_interest_rate,
    loan_term_months,
    loan_start_date,
    loan_payment_day,
    loan_regular_payment_amount,
    loan_first_payment_date,
    loan_schedule,
  }) {
    const sql = `
      INSERT INTO planned_transactions (
        planned_date, bank_account, recipient_id, amount, memo, currency, category_id, comment, url,
        is_recurring, recurrence_pattern, is_executed, is_active,
        is_loan, loan_type, loan_principal, loan_annual_interest_rate,
        loan_term_months, loan_start_date, loan_payment_day,
        loan_regular_payment_amount, loan_first_payment_date
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, false, true,
        $12, $13, $14, $15,
        $16, $17, $18,
        $19, $20
      )
      RETURNING *
    `;
    // sanitize recurrence data: loans should not store recurrence_pattern or related fields
    if (is_loan) {
      recurrence_pattern = null;
    }

    const params = [
      planned_date,
      bank_account ? bank_account.toUpperCase() : null,
      recipient_id, amount,
      memo ? memo.toUpperCase() : null,
      currency ? currency.toUpperCase() : null,
      category_id, comment, url || null,
      is_recurring || false,
      recurrence_pattern || null,
      is_loan || false,
      loan_type || null,
      loan_principal != null ? Number(loan_principal) : null,
      loan_annual_interest_rate != null ? Number(loan_annual_interest_rate) : null,
      loan_term_months != null ? Number(loan_term_months) : null,
      loan_start_date || null,
      loan_payment_day != null ? Number(loan_payment_day) : null,
      loan_regular_payment_amount != null ? Number(loan_regular_payment_amount) : null,
      loan_first_payment_date || null,
    ];
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const result = await client.query(sql, params);
      const plannedId = result.rows[0].id;

      if (is_loan && Array.isArray(loan_schedule) && loan_schedule.length > 0) {
        for (const installment of loan_schedule) {
          await client.query(
            `INSERT INTO planned_transaction_loan_schedule (
               planned_transaction_id, installment_number, due_date,
               payment_amount, principal_amount, interest_amount, remaining_principal
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              plannedId,
              installment.installment_number,
              installment.due_date,
              installment.payment_amount,
              installment.principal_amount,
              installment.interest_amount,
              installment.remaining_principal,
            ]
          );
        }
      }

      await client.query('COMMIT');
      return this.getById(plannedId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async update(id, fields) {
    // Sanitize field names to prevent SQL injection via column names
    const sanitized = sanitizeUpdateFields('planned_transactions', fields);
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(sanitized)) {
      if (value === undefined) continue;
      setClauses.push(`"${key}" = $${paramIdx++}`);
      params.push(value);
    }

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE planned_transactions SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    await query(sql, params);
    return this.getById(id);
  },

  async hardDelete(id) {
    const result = await query('DELETE FROM planned_transactions WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  async addExecution(plannedTransactionId, executedTransactionId, executionDate) {
    await query(
      `INSERT INTO planned_transaction_executions (planned_transaction_id, executed_transaction_id, execution_date)
       VALUES ($1, $2, $3)`,
      [plannedTransactionId, executedTransactionId, executionDate || new Date().toISOString().split('T')[0]]
    );
  },

  async replaceLoanSchedule(plannedTransactionId, scheduleEntries = []) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM planned_transaction_loan_schedule WHERE planned_transaction_id = $1',
        [plannedTransactionId]
      );

      for (const installment of scheduleEntries) {
        await client.query(
          `INSERT INTO planned_transaction_loan_schedule (
             planned_transaction_id, installment_number, due_date,
             payment_amount, principal_amount, interest_amount, remaining_principal
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            plannedTransactionId,
            installment.installment_number,
            installment.due_date,
            installment.payment_amount,
            installment.principal_amount,
            installment.interest_amount,
            installment.remaining_principal,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

export default plannedTransactionRepository;
