/**
 * Planned Transaction Repository - data access for planned_transactions table.
 *
 */

import { query, withTransaction } from '../database/connection.js';
import { sanitizeUpdateFields } from '../middleware/validation.js';
import { todayAppDateString } from '../lib/timezone.js';
import { buildSetClauses } from '../lib/sqlClauses.js';
import { stampAccountIdForUpdate } from './transactionRepository.js';

/** @typedef {import('../types/rows.js').QueryRunner} QueryRunner */
/** @typedef {import('../types/rows.js').HydratedPlannedTransactionRow} HydratedPlannedTransactionRow */
/** @typedef {import('../types/rows.js').PlannedTransactionListRow} PlannedTransactionListRow */
/** @typedef {import('../types/rows.js').PlannedMatchCandidateRow} PlannedMatchCandidateRow */
/** @typedef {import('../types/rows.js').PlannedForecastRow} PlannedForecastRow */
/** @typedef {import('../types/rows.js').LoanScheduleRow} LoanScheduleRow */

/**
 * Filters shared by getAll and the count fallback.
 *
 * @typedef {object} PlannedTransactionFilters
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {string|null} [startDate] 'YYYY-MM-DD'
 * @property {string|null} [endDate] 'YYYY-MM-DD'
 * @property {string|null} [bankAccount]
 * @property {number|null} [categoryId]
 * @property {number|null} [recipientId]
 * @property {boolean|null} [isRecurring]
 * @property {boolean|null} [isExecuted]
 * @property {string|null} [search]
 * @property {boolean} [active]
 */

// Shared projection + joins for planned_transaction reads. getAll, getById,
// getDueSoon, getForForecast and the update() RETURNING wrapper all read the
// same recipient_name + resolved category_name shape over the same joins;
// keeping the block in one place avoids five-way drift.
// planned_transactions carries its own `recipient_id` + `category_id`, so the
// same 3-level resolution the transactions list uses applies verbatim here:
// own (c) → recipient default (rc) → PRIMARY recipient default (pc), mirroring
// COALESCE(pt.category_id, r.default_category_id, pr.default_category_id).
// This used to stop at `rc` (no `pc` branch, no `pr` join), so a planned row
// booked against an ALIAS recipient that inherits from its primary showed no
// category at all while the equivalent transaction showed one.
// NB: `category_id` in the projection is deliberately still pt's OWN stored
// column (that is the editable field the PATCH round-trips); `category_name` is
// the resolved DISPLAY name. They only coincide when pt.category_id is set.
const PLANNED_CATEGORY_NAME_SQL = `CASE
                WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
                WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
                WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
                ELSE NULL
              END`;

// `acct.name AS bank_account` is selected AFTER `pt.*` so the projected
// `bank_account` key resolves to the canonical accounts.name over the FK
// (node-postgres keeps the LAST duplicate field) — ADR-088 contract phase:
// reads must survive the out-of-band drop of the string column, and stay
// byte-identical pre-drop under the dual-write parity invariant.
const PLANNED_SELECT_FIELDS = `pt.*,
             acct.name AS bank_account,
             r.name AS recipient_name,
             ${PLANNED_CATEGORY_NAME_SQL} AS category_name`;

const PLANNED_JOINS = `LEFT JOIN recipients r ON pt.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN categories c ON pt.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      LEFT JOIN categories pc ON pr.default_category_id = pc.id
      LEFT JOIN accounts acct ON pt.account_id = acct.id`;

/**
 * Attach the executions, loan_schedule and tags sub-collections to a hydrated
 * planned-transaction row. Identical between getById() and update(); mutates and
 * returns the row.
 *
 * @param {any} row - a planned_transactions row (must carry id, is_loan)
 * @param {number} id
 * @returns {Promise<HydratedPlannedTransactionRow>} the same row, hydrated
 */
async function hydratePlannedRow(row, id) {
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
}

/**
 * @param {PlannedTransactionFilters} [filters]
 * @returns {{ whereClause: string, params: any[] }}
 */
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
  // Bank filter via the FK (ADR-088) — matches the account's canonical name,
  // never the retired bank_account string.
  if (bankAccount) { whereClause += ` AND pt.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name ILIKE $${paramIdx++})`; params.push(`%${bankAccount}%`); }
  if (categoryId != null) { whereClause += ` AND pt.category_id = $${paramIdx++}`; params.push(categoryId); }
  if (recipientId != null) { whereClause += ` AND pt.recipient_id = $${paramIdx++}`; params.push(recipientId); }
  if (isRecurring != null) { whereClause += ` AND pt.is_recurring = $${paramIdx++}`; params.push(isRecurring); }
  if (isExecuted != null) { whereClause += ` AND pt.is_executed = $${paramIdx++}`; params.push(isExecuted); }
  if (search) {
    const sp = `%${search}%`;
    whereClause += ` AND (
      pt.memo ILIKE $${paramIdx} OR
      pt.comment ILIKE $${paramIdx} OR
      acct.name ILIKE $${paramIdx} OR
      r.name ILIKE $${paramIdx} OR
      -- Match the RESOLVED label the row displays, not each candidate level in
      -- turn. ORing c/rc separately both missed rows categorised through the
      -- primary recipient (no pc term at all) and matched rows whose own
      -- category_id overrode the recipient default the term hit.
      ${PLANNED_CATEGORY_NAME_SQL} ILIKE $${paramIdx}
    )`;
    params.push(sp);
  }

  return { whereClause, params };
}

/**
 * @param {QueryRunner} client
 * @param {number} plannedTransactionId
 * @param {LoanScheduleRow[]|Array<Record<string, any>>} [scheduleEntries]
 * @returns {Promise<void>}
 */
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

/**
 * @param {QueryRunner} client
 * @param {number} plannedTransactionId
 * @param {string[]|null|undefined} slugs
 * @returns {Promise<void>}
 */
async function setPlannedTransactionTags(client, plannedTransactionId, slugs) {
  await client.query('DELETE FROM planned_transaction_tags WHERE planned_transaction_id = $1', [plannedTransactionId]);
  if (!slugs || slugs.length === 0) return;
  const resolved = await client.query(
    'SELECT id FROM tags WHERE slug = ANY($1::text[]) AND is_active = true',
    [slugs],
  );
  if (resolved.rows.length === 0) return;
  const tagIds = resolved.rows.map((/** @type {any} */ r) => r.id);
  await client.query(
    `INSERT INTO planned_transaction_tags (planned_transaction_id, tag_id)
     SELECT $1, unnest($2::int[])
     ON CONFLICT DO NOTHING`,
    [plannedTransactionId, tagIds],
  );
}

/**
 * Apply the sanitized SET fields to a planned row inside the caller's
 * transaction — or, when no updatable fields remain, just verify the row
 * exists. Shared by update() and updateWithLoanSchedule() so the two
 * transaction bodies cannot drift.
 *
 * @param {QueryRunner} client
 * @param {number} id
 * @param {Record<string, any>} sanitized  output of sanitizeUpdateFields()
 * @returns {Promise<boolean>} false when the row is gone
 */
async function applyPlannedFieldUpdate(client, id, sanitized) {
  const { clauses: setClauses, params, nextIdx: paramIdx } = buildSetClauses(sanitized, { quote: true });
  if (setClauses.length === 0) {
    const r = await client.query('SELECT id FROM planned_transactions WHERE id = $1', [id]);
    return r.rowCount > 0;
  }
  setClauses.push('updated_at = NOW()');
  params.push(id);
  const r = await client.query(
    `UPDATE planned_transactions SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING id`,
    params,
  );
  return r.rowCount > 0;
}

export const plannedTransactionRepository = {
  /**
   * @param {PlannedTransactionFilters} [filters]
   * @returns {Promise<{ items: HydratedPlannedTransactionRow[], total: number }>}
   */
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
      SELECT ${PLANNED_SELECT_FIELDS},
             COUNT(*) OVER() AS total_count
      FROM planned_transactions pt
      ${PLANNED_JOINS}
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
        ${PLANNED_JOINS}
        ${whereClause}
      `;
      const countResult = await query(countSql, params);
      total = parseInt(countResult.rows[0]?.count, 10) || 0;
    }
    const rows = result.rows.map((/** @type {any} */ { total_count: _total_count, ...row }) => row);

    const plannedTransactionIds = rows.map((/** @type {any} */ row) => row.id);
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
      .filter((/** @type {any} */ row) => row.is_loan)
      .map((/** @type {any} */ row) => row.id);

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

  // Lightweight candidate list for auto-link / match suggestions. Returns only
  // the fields the matcher needs (recipient cluster root, amount, planned_date)
  // for active, not-yet-executed rows. Loans are excluded: their installments
  // carry amortization semantics that a fuzzy recipient+amount match must not
  // silently advance. Recurring rows are always eligible (they never stay
  // is_executed=true), one-off rows only while is_executed=false.
  /** @returns {Promise<PlannedMatchCandidateRow[]>} */
  async listActiveUnexecuted() {
    const result = await query(
      `SELECT pt.id,
              pt.recipient_id,
              COALESCE(r.primary_recipient_id, pt.recipient_id) AS recipient_cluster_id,
              pt.amount,
              pt.planned_date,
              pt.currency,
              pt.is_recurring,
              pt.recurrence_pattern,
              pt.memo,
              r.name AS recipient_name
         FROM planned_transactions pt
         LEFT JOIN recipients r ON pt.recipient_id = r.id
        WHERE pt.is_active = true
          AND pt.is_executed = false
          AND pt.recipient_id IS NOT NULL
          AND (pt.is_loan = false OR pt.is_loan IS NULL)`
    );
    return result.rows;
  },

  /**
   * @param {number} id
   * @returns {Promise<HydratedPlannedTransactionRow|null>}
   */
  async getById(id) {
    const sql = `
      SELECT ${PLANNED_SELECT_FIELDS}
      FROM planned_transactions pt
      ${PLANNED_JOINS}
      WHERE pt.id = $1
    `;
    const result = await query(sql, [id]);
    if (result.rows.length === 0) return null;

    return hydratePlannedRow(result.rows[0], id);
  },

  /**
   * @param {Record<string, any> & {
   *   planned_date: string,
   *   amount: number|string,
   *   is_loan?: boolean,
   *   loan_schedule?: Array<Record<string, any>>,
   *   tags?: string[]|null,
   * }} input
   * @returns {Promise<HydratedPlannedTransactionRow|null>}
   */
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
    recurrence_end_date,
    max_occurrences,
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
        is_recurring, recurrence_pattern, recurrence_end_date, max_occurrences,
        reminder_days_before, is_executed, is_active,
        is_loan, loan_type, loan_principal, loan_annual_interest_rate,
        loan_term_months, loan_start_date, loan_payment_day,
        loan_regular_payment_amount, loan_first_payment_date
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, false, true,
        $15, $16, $17, $18,
        $19, $20, $21,
        $22, $23
      )
      RETURNING *
    `;
    // Loans are monthly by construction (generateLoanSchedule walks months via
    // addMonthsAtDay), so they advance like a monthly recurrence on /execute.
    // Storing 'monthly' (not null) lets executeAndAdvance roll planned_date
    // forward — a null left the loan row perpetually due and re-executable.
    if (is_loan) {
      recurrence_pattern = 'monthly';
    }

    const params = [
      planned_date,
      bank_account ? bank_account.toUpperCase() : null,
      recipient_id, amount,
      memo ? memo.toUpperCase() : null,
      // Default to EUR rather than NULL (currency is NOT NULL at the DB level —
      // migration 0046 — and reads already coalesce missing → EUR).
      currency ? currency.toUpperCase() : 'EUR',
      category_id, comment, url || null,
      is_recurring || false,
      recurrence_pattern || null,
      recurrence_end_date || null,
      max_occurrences != null ? Number(max_occurrences) : null,
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

  /**
   * @param {number} id
   * @param {Record<string, any> & { tags?: string[] }} fields
   * @returns {Promise<HydratedPlannedTransactionRow|null>}
   */
  async update(id, fields) {
    const { tags, ...txFields } = fields;
    // Sanitize field names to prevent SQL injection via column names
    const sanitized = sanitizeUpdateFields('planned_transactions', txFields);
    // A bank_account edit also writes the resolved FK (ADR-088): the 0062
    // sync trigger is lookup-only on UPDATE, so without this a first-seen
    // label would leave a ghost string with a stale/NULL account_id. See
    // stampAccountIdForUpdate (transactionRepository) for the full contract.
    await stampAccountIdForUpdate(sanitized);

    if (tags !== undefined) {
      const found = await withTransaction(async (client) => {
        if (!(await applyPlannedFieldUpdate(client, id, sanitized))) return false;
        await setPlannedTransactionTags(client, id, tags);
        return true;
      });
      if (!found) return null;
      return this.getById(id);
    }

    const { clauses: setClauses, params, nextIdx: paramIdx } = buildSetClauses(sanitized, { quote: true });
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
      SELECT ${PLANNED_SELECT_FIELDS}
      FROM updated pt
      ${PLANNED_JOINS}
    `;

    const result = await query(sql, params);
    if (result.rows.length === 0) return null;

    return hydratePlannedRow(result.rows[0], id);
  },

  /**
   * Atomic counterpart to update(): applies the field update AND replaces the
   * loan amortization schedule inside ONE transaction. The PATCH route uses this
   * whenever a loan parameter changed (or a loan was turned off) so the planned
   * row (loan_regular_payment_amount / loan_first_payment_date / is_loan) and the
   * planned_transaction_loan_schedule rows can never disagree after a partial
   * failure. `scheduleEntries` of [] clears the schedule.
   *
   * @param {number} id
   * @param {Record<string, any> & { tags?: string[] }} fields  sanitized update fields (may include `tags`)
   * @param {Array<Record<string, any>>} [scheduleEntries]  installments to write ([] clears)
   * @returns {Promise<HydratedPlannedTransactionRow|null>} the hydrated row, or null if the row is gone
   */
  async updateWithLoanSchedule(id, fields, scheduleEntries = []) {
    const { tags, ...txFields } = fields;
    const sanitized = sanitizeUpdateFields('planned_transactions', txFields);
    // Same ADR-088 UPDATE-path resolution as update() — see stampAccountIdForUpdate.
    await stampAccountIdForUpdate(sanitized);

    const found = await withTransaction(async (client) => {
      if (!(await applyPlannedFieldUpdate(client, id, sanitized))) return false;

      if (tags !== undefined) {
        await setPlannedTransactionTags(client, id, tags);
      }

      // Replace the amortization schedule in the SAME transaction as the field
      // update so loan params and per-installment rows commit (or roll back) together.
      await client.query(
        'DELETE FROM planned_transaction_loan_schedule WHERE planned_transaction_id = $1',
        [id],
      );
      await insertLoanScheduleBatch(client, id, scheduleEntries);

      return true;
    });

    if (!found) return null;
    return this.getById(id);
  },

  /**
   * Return active, unexecuted planned transactions whose planned_date falls within
   * the next `days` days. Used by the bill-reminder endpoint.
   *
   * @param {number} days - Lookahead window (1–365)
   * @returns {Promise<PlannedTransactionListRow[]>}
   */
  async getDueSoon(days) {
    const sql = `
      SELECT ${PLANNED_SELECT_FIELDS}
      FROM planned_transactions pt
      ${PLANNED_JOINS}
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
   * @returns {Promise<PlannedForecastRow[]>}
   */
  async getForForecast(months) {
    const sql = `
      SELECT pt.id, pt.planned_date, pt.amount, pt.currency,
             pt.memo, pt.is_recurring, pt.recurrence_pattern,
             r.name AS recipient_name,
             ${PLANNED_CATEGORY_NAME_SQL} AS category_name
      FROM planned_transactions pt
      ${PLANNED_JOINS}
      WHERE pt.is_active = true
        AND pt.is_executed = false
        AND pt.planned_date <= CURRENT_DATE + ($1 * INTERVAL '1 month')
      ORDER BY pt.planned_date ASC
    `;
    const result = await query(sql, [months]);
    return result.rows;
  },

  /**
   * @param {number} id
   * @returns {Promise<boolean>}
   */
  async hardDelete(id) {
    const result = await query('DELETE FROM planned_transactions WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  /**
   * @param {number} plannedTransactionId
   * @param {number} executedTransactionId
   * @param {string|null} [executionDate] 'YYYY-MM-DD'; defaults to app-timezone today
   * @returns {Promise<void>}
   */
  async addExecution(plannedTransactionId, executedTransactionId, executionDate) {
    await query(
      `INSERT INTO planned_transaction_executions (planned_transaction_id, executed_transaction_id, execution_date)
       VALUES ($1, $2, $3)`,
      // App-timezone today (ADR-009) — the UTC calendar day is yesterday
      // between local midnight and 01:00/02:00 Brussels.
      [plannedTransactionId, executedTransactionId, executionDate || todayAppDateString()]
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
   * @param {Record<string, any>} [updateFields] - sanitized fields for planned_transactions update
   * @param {number[]|null} [tagIdsToInherit] - tag ids copied onto the executed transaction
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
      const { clauses: setClauses, params, nextIdx: paramIdx } = buildSetClauses(sanitized, { quote: true });

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

  /**
   * @param {number} plannedTransactionId
   * @param {Array<Record<string, any>>} [scheduleEntries]
   * @returns {Promise<void>}
   */
  async replaceLoanSchedule(plannedTransactionId, scheduleEntries = []) {
    return withTransaction(async (client) => {
      await client.query(
        'DELETE FROM planned_transaction_loan_schedule WHERE planned_transaction_id = $1',
        [plannedTransactionId]
      );
      await insertLoanScheduleBatch(client, plannedTransactionId, scheduleEntries);
    });
  },

  /**
   * Repoint planned transactions off merged-away source accounts onto the
   * survivor, stamping `bank_account` so the dual-write trigger (migration
   * 0051) keeps account_id at the target (ADR-088).
   *
   * @param {number} targetId
   * @param {string} targetName
   * @param {number[]} sourceIds
   * @returns {Promise<number>} rows repointed
   */
  async repointAccount(targetId, targetName, sourceIds) {
    const result = await query(
      `UPDATE planned_transactions SET account_id = $1, bank_account = $2 WHERE account_id = ANY($3::int[])`,
      [targetId, targetName, sourceIds],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Does planned_transactions carry recipient_id? Very old schemas predate the
   * column, and the recipient merge must skip the repoint rather than fail.
   *
   * @returns {Promise<boolean>}
   */
  async hasRecipientIdColumn() {
    const result = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'planned_transactions' AND column_name = 'recipient_id'
       LIMIT 1`,
    );
    return result.rows.length > 0;
  },

  /**
   * Repoint planned transactions off merged alias recipients onto the primary.
   *
   * @param {number} primaryId
   * @param {number[]} aliasIds
   * @returns {Promise<number>} rows repointed
   */
  async repointRecipient(primaryId, aliasIds) {
    const result = await query(
      `UPDATE planned_transactions
            SET recipient_id = $1
          WHERE recipient_id = ANY($2::int[])`,
      [primaryId, aliasIds],
    );
    return result.rowCount ?? 0;
  },
};

export default plannedTransactionRepository;
