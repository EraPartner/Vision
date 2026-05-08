/**
 * Planned Transaction Repository - data access for planned_transactions table.
 *
 * Mirrors: apps/backend/repositories/planned_transaction_repository.py
 */

import { query, withTransaction } from '../database/connection.js';
import { sanitizeUpdateFields } from '../middleware/validation.js';

function buildPlannedTransactionWhereClause({
  startDate = null,
  endDate = null,
  bankAccount = null,
  categoryId = null,
  recipientId = null,
  isRecurring = null,
  isExecuted = null,
  search = null,
  active = true,
} = {}) {
  let whereClause = 'WHERE 1=1';
  const params = [];
  let paramIdx = 1;

  if (active) whereClause += ` AND pt.is_active = true`;
  if (startDate) { whereClause += ` AND pt.planned_date >= $${paramIdx++}`; params.push(startDate); }
  if (endDate) { whereClause += ` AND pt.planned_date <= $${paramIdx++}`; params.push(endDate); }
  if (bankAccount) { whereClause += ` AND pt.bank_account ILIKE $${paramIdx++}`; params.push(`%${bankAccount}%`); }
  if (categoryId != null) { whereClause += ` AND pt.category_id = $${paramIdx++}`; params.push(categoryId); }
  if (recipientId != null) { whereClause += ` AND pt.recipient_id = $${paramIdx++}`; params.push(recipientId); }
  if (isRecurring != null) { whereClause += ` AND pt.is_recurring = $${paramIdx++}`; params.push(isRecurring); }
  if (isExecuted != null) { whereClause += ` AND pt.is_executed = $${paramIdx++}`; params.push(isExecuted); }
  if (search) {
    const sp = `%${search}%`;
    whereClause += ` AND (
      pt.memo ILIKE $${paramIdx} OR
      pt.comment ILIKE $${paramIdx} OR
      pt.bank_account ILIKE $${paramIdx} OR
      r.name ILIKE $${paramIdx} OR
      c.general ILIKE $${paramIdx} OR
      c.detail ILIKE $${paramIdx} OR
      rc.general ILIKE $${paramIdx} OR
      rc.detail ILIKE $${paramIdx}
    )`;
    params.push(sp);
  }

  return { whereClause, params };
}

async function insertLoanScheduleBatch(client, plannedTransactionId, scheduleEntries = []) {
  if (!Array.isArray(scheduleEntries) || scheduleEntries.length === 0) return;

  const values = [];
  const params = [];
  let paramIdx = 1;

  for (const installment of scheduleEntries) {
    values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
    params.push(
      plannedTransactionId,
      installment.installment_number,
      installment.due_date,
      installment.payment_amount,
      installment.principal_amount,
      installment.interest_amount,
      installment.remaining_principal
    );
  }

  await client.query(
    `INSERT INTO planned_transaction_loan_schedule (
       planned_transaction_id, installment_number, due_date,
       payment_amount, principal_amount, interest_amount, remaining_principal
     ) VALUES ${values.join(', ')}`,
    params
  );
}

async function setPlannedTransactionTags(client, plannedTransactionId, slugs) {
  await client.query('DELETE FROM planned_transaction_tags WHERE planned_transaction_id = $1', [plannedTransactionId]);
  if (!slugs || slugs.length === 0) return;
  const resolved = await client.query(
    'SELECT id FROM tags WHERE slug = ANY($1::text[]) AND is_active = true',
    [slugs],
  );
  if (resolved.rows.length === 0) return;
  const tagIds = resolved.rows.map((r) => r.id);
  await client.query(
    `INSERT INTO planned_transaction_tags (planned_transaction_id, tag_id)
     SELECT $1, unnest($2::int[])
     ON CONFLICT DO NOTHING`,
    [plannedTransactionId, tagIds],
  );
}

export const plannedTransactionRepository = {
  async getAll({
    limit = 50, offset = 0, startDate = null, endDate = null,
    bankAccount = null, categoryId = null, recipientId = null,
    isRecurring = null, isExecuted = null, search = null, active = true,
  } = {}) {
    const { whereClause, params } = buildPlannedTransactionWhereClause({
      startDate,
      endDate,
      bankAccount,
      categoryId,
      recipientId,
      isRecurring,
      isExecuted,
      search,
      active,
    });

    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;
    const sql = `
      SELECT pt.*,
             r.name AS recipient_name,
             CASE
                WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
                WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
                ELSE NULL
              END AS category_name,
             COUNT(*) OVER() AS total_count
      FROM planned_transactions pt
      LEFT JOIN recipients r ON pt.recipient_id = r.id
      LEFT JOIN categories c ON pt.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      ${whereClause}
      ORDER BY pt.planned_date DESC
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `;

    const result = await query(sql, [...params, limit, offset]);
    let total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    if (result.rows.length === 0) {
      const countSql = `
        SELECT count(*)
        FROM planned_transactions pt
        LEFT JOIN recipients r ON pt.recipient_id = r.id
        LEFT JOIN categories c ON pt.category_id = c.id
        LEFT JOIN categories rc ON r.default_category_id = rc.id
        ${whereClause}
      `;
      const countResult = await query(countSql, params);
      total = parseInt(countResult.rows[0]?.count, 10) || 0;
    }
    const rows = result.rows.map(({ total_count: _total_count, ...row }) => row);

    const plannedTransactionIds = rows.map((row) => row.id);
    const executionsByPlannedTransactionId = new Map();
    if (plannedTransactionIds.length > 0) {
      const executionResult = await query(
        `SELECT *
         FROM planned_transaction_executions
         WHERE planned_transaction_id = ANY($1::int[])
         ORDER BY planned_transaction_id ASC, execution_date DESC`,
        [plannedTransactionIds]
      );

      for (const execution of executionResult.rows) {
        if (!executionsByPlannedTransactionId.has(execution.planned_transaction_id)) {
          executionsByPlannedTransactionId.set(execution.planned_transaction_id, []);
        }
        executionsByPlannedTransactionId.get(execution.planned_transaction_id).push(execution);
      }
    }

    const loanPlannedTransactionIds = rows
      .filter((row) => row.is_loan)
      .map((row) => row.id);

    const schedulesByPlannedTransactionId = new Map();
    if (loanPlannedTransactionIds.length > 0) {
      const scheduleResult = await query(
        `SELECT planned_transaction_id, installment_number, due_date, payment_amount, principal_amount, interest_amount, remaining_principal
           FROM planned_transaction_loan_schedule
          WHERE planned_transaction_id = ANY($1::int[])
          ORDER BY planned_transaction_id ASC, installment_number ASC`,
        [loanPlannedTransactionIds]
      );

      for (const scheduleRow of scheduleResult.rows) {
        if (!schedulesByPlannedTransactionId.has(scheduleRow.planned_transaction_id)) {
          schedulesByPlannedTransactionId.set(scheduleRow.planned_transaction_id, []);
        }
        const { planned_transaction_id, ...loanScheduleEntry } = scheduleRow;
        schedulesByPlannedTransactionId.get(planned_transaction_id).push(loanScheduleEntry);
      }
    }

    const tagsByPlannedTransactionId = new Map();
    if (plannedTransactionIds.length > 0) {
      const tagResult = await query(
        `SELECT ptt.planned_transaction_id, tg.id, tg.slug, tg.color, tg.is_active
         FROM planned_transaction_tags ptt
         JOIN tags tg ON tg.id = ptt.tag_id
         WHERE ptt.planned_transaction_id = ANY($1::int[])
         ORDER BY ptt.planned_transaction_id ASC, tg.slug ASC`,
        [plannedTransactionIds],
      );
      for (const tagRow of tagResult.rows) {
        if (!tagsByPlannedTransactionId.has(tagRow.planned_transaction_id)) {
          tagsByPlannedTransactionId.set(tagRow.planned_transaction_id, []);
        }
        const { planned_transaction_id, ...tag } = tagRow;
        tagsByPlannedTransactionId.get(planned_transaction_id).push(tag);
      }
    }

    for (const row of rows) {
      const executions = executionsByPlannedTransactionId.get(row.id) || [];
      row.executions = executions;
      row.execution_count = executions.length;
      row.executed_transaction_id = executions.length > 0 ? executions[0].executed_transaction_id : null;
      row.loan_schedule = row.is_loan
        ? (schedulesByPlannedTransactionId.get(row.id) || [])
        : [];
      row.tags = tagsByPlannedTransactionId.get(row.id) || [];
    }

    return { items: rows, total };
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

    const tagResult = await query(
      `SELECT tg.id, tg.slug, tg.color, tg.is_active
       FROM planned_transaction_tags ptt
       JOIN tags tg ON tg.id = ptt.tag_id
       WHERE ptt.planned_transaction_id = $1
       ORDER BY tg.slug ASC`,
      [id],
    );
    row.tags = tagResult.rows;

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
    reminder_days_before,
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
    tags = null,
  }) {
    const sql = `
      INSERT INTO planned_transactions (
        planned_date, bank_account, recipient_id, amount, memo, currency, category_id, comment, url,
        is_recurring, recurrence_pattern, reminder_days_before, is_executed, is_active,
        is_loan, loan_type, loan_principal, loan_annual_interest_rate,
        loan_term_months, loan_start_date, loan_payment_day,
        loan_regular_payment_amount, loan_first_payment_date
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, false, true,
        $13, $14, $15, $16,
        $17, $18, $19,
        $20, $21
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
      reminder_days_before != null ? Number(reminder_days_before) : null,
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
    const plannedId = await withTransaction(async (client) => {
      const result = await client.query(sql, params);
      const newId = result.rows[0].id;

      if (is_loan && Array.isArray(loan_schedule) && loan_schedule.length > 0) {
        await insertLoanScheduleBatch(client, newId, loan_schedule);
      }

      if (Array.isArray(tags) && tags.length > 0) {
        await setPlannedTransactionTags(client, newId, tags);
      }

      return newId;
    });
    return this.getById(plannedId);
  },

  async update(id, fields) {
    const { tags, ...txFields } = fields;
    // Sanitize field names to prevent SQL injection via column names
    const sanitized = sanitizeUpdateFields('planned_transactions', txFields);
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(sanitized)) {
      if (value === undefined) continue;
      setClauses.push(`"${key}" = $${paramIdx++}`);
      params.push(value);
    }

    if (tags !== undefined) {
      const found = await withTransaction(async (client) => {
        if (setClauses.length > 0) {
          setClauses.push('updated_at = NOW()');
          params.push(id);
          const r = await client.query(
            `UPDATE planned_transactions SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING id`,
            params,
          );
          if (r.rowCount === 0) return false;
        } else {
          const r = await client.query('SELECT id FROM planned_transactions WHERE id = $1', [id]);
          if (r.rowCount === 0) return false;
        }
        await setPlannedTransactionTags(client, id, tags);
        return true;
      });
      if (!found) return null;
      return this.getById(id);
    }

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `
      WITH updated AS (
        UPDATE planned_transactions
        SET ${setClauses.join(', ')}
        WHERE id = $${paramIdx}
        RETURNING *
      )
      SELECT pt.*,
             r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name
      FROM updated pt
      LEFT JOIN recipients r ON pt.recipient_id = r.id
      LEFT JOIN categories c ON pt.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
    `;

    const result = await query(sql, params);
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

    const tagResult = await query(
      `SELECT tg.id, tg.slug, tg.color, tg.is_active
       FROM planned_transaction_tags ptt
       JOIN tags tg ON tg.id = ptt.tag_id
       WHERE ptt.planned_transaction_id = $1
       ORDER BY tg.slug ASC`,
      [id],
    );
    row.tags = tagResult.rows;

    return row;
  },

  /**
   * Return active, unexecuted planned transactions whose planned_date falls within
   * the next `days` days. Used by the bill-reminder endpoint.
   *
   * @param {number} days - Lookahead window (1–365)
   * @returns {Promise<Array>}
   */
  async getDueSoon(days) {
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
      WHERE pt.is_active = true
        AND pt.is_executed = false
        AND pt.planned_date >= CURRENT_DATE
        AND pt.planned_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL
      ORDER BY pt.planned_date ASC
    `;
    const result = await query(sql, [days]);
    return result.rows;
  },

  /**
   * Return all active, unexecuted planned transactions whose planned_date is on or
   * before the forecast horizon (today + `months` months). Includes recurring
   * transactions that have already started (planned_date may be before today if
   * the user hasn't executed them yet).
   *
   * @param {number} months - Forecast horizon in months (1–24)
   * @returns {Promise<Array>}
   */
  async getForForecast(months) {
    const sql = `
      SELECT pt.id, pt.planned_date, pt.amount, pt.currency,
             pt.memo, pt.is_recurring, pt.recurrence_pattern,
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
      WHERE pt.is_active = true
        AND pt.is_executed = false
        AND pt.planned_date <= CURRENT_DATE + ($1 * INTERVAL '1 month')
      ORDER BY pt.planned_date ASC
    `;
    const result = await query(sql, [months]);
    return result.rows;
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

  /**
   * Atomically record an execution and advance the parent planned_transactions row.
   *
   * Phase 3 replacement for sequential `addExecution` + `update` calls. Runs
   * both writes inside a single BEGIN/COMMIT so a mid-flight failure cannot
   * leave an execution row without its matching state advance.
   *
   * Idempotent via the UNIQUE(planned_transaction_id, executed_transaction_id)
   * index (alembic 0001 baseline). A retried request raises Postgres error
   * 23505, which this method treats as success and returns `{ duplicate: true }`
   * so the caller can respond without creating a new execution.
   *
   * @param {number} plannedTransactionId
   * @param {number} executedTransactionId
   * @param {string} executionDate - YYYY-MM-DD
   * @param {object} updateFields - sanitized fields for planned_transactions update
   * @returns {Promise<{ duplicate: boolean }>}
   */
  async executeAndAdvance(plannedTransactionId, executedTransactionId, executionDate, updateFields = {}, tagIdsToInherit = null) {
    return withTransaction(async (client) => {
      // ON CONFLICT DO NOTHING → idempotent retry of the same execute call
      // (unique_violation on (planned_transaction_id, executed_transaction_id)).
      const insertResult = await client.query(
        `INSERT INTO planned_transaction_executions
           (planned_transaction_id, executed_transaction_id, execution_date)
         VALUES ($1, $2, $3)
         ON CONFLICT (planned_transaction_id, executed_transaction_id) DO NOTHING
         RETURNING id`,
        [plannedTransactionId, executedTransactionId, executionDate]
      );

      if (insertResult.rowCount === 0) {
        return { duplicate: true };
      }

      const sanitized = sanitizeUpdateFields('planned_transactions', updateFields);
      const setClauses = [];
      const params = [];
      let paramIdx = 1;
      for (const [key, value] of Object.entries(sanitized)) {
        if (value === undefined) continue;
        setClauses.push(`"${key}" = $${paramIdx++}`);
        params.push(value);
      }

      if (setClauses.length > 0) {
        setClauses.push('updated_at = NOW()');
        params.push(plannedTransactionId);
        await client.query(
          `UPDATE planned_transactions SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
          params
        );
      }

      if (Array.isArray(tagIdsToInherit) && tagIdsToInherit.length > 0) {
        await client.query(
          `INSERT INTO transaction_tags (transaction_id, tag_id)
           SELECT $1, unnest($2::int[])
           ON CONFLICT DO NOTHING`,
          [executedTransactionId, tagIdsToInherit],
        );
      }

      return { duplicate: false };
    });
  },

  async replaceLoanSchedule(plannedTransactionId, scheduleEntries = []) {
    return withTransaction(async (client) => {
      await client.query(
        'DELETE FROM planned_transaction_loan_schedule WHERE planned_transaction_id = $1',
        [plannedTransactionId]
      );
      await insertLoanScheduleBatch(client, plannedTransactionId, scheduleEntries);
    });
  },
};

export default plannedTransactionRepository;
