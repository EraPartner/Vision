/**
 * Planned Transaction Repository - data access for planned_transactions table.
 *
 */

import { query } from "../database/connection.ts";
import { todayAppDateString } from "../lib/timezone.ts";
import { buildSetClauses } from "../lib/sqlClauses.ts";

import type {
  HydratedPlannedTransactionRow,
  LoanScheduleRow,
  PlannedExecutionRow,
  PlannedForecastRow,
  PlannedMatchCandidateRow,
  PlannedTransactionListRow,
  QueryRunner,
  TransactionTagRef,
} from "../types/rows.ts";

export type {
  QueryRunner,
  HydratedPlannedTransactionRow,
  PlannedTransactionListRow,
  PlannedMatchCandidateRow,
  PlannedForecastRow,
  LoanScheduleRow,
};

/**
 * A planned row whose sub-collections (executions, loan_schedule, tags, ...)
 * are still being attached by hydratePlannedRow() / getAll().
 */
type PlannedRowInHydration = PlannedTransactionListRow &
  Partial<Omit<HydratedPlannedTransactionRow, keyof PlannedTransactionListRow>>;

/** Narrow projection of `getForCommitmentProjection`. */
export interface PlannedCommitmentRow {
  id: number;
  /** DATE */
  planned_date: Date;
  /** NUMERIC */
  amount: string;
  currency: string | null;
  is_recurring: boolean;
  recurrence_pattern: string | null;
  /** DATE */
  recurrence_end_date: Date | null;
  max_occurrences: number | null;
  execution_count: number;
}

/** Filters shared by getAll and the count fallback. */
export interface PlannedTransactionFilters {
  limit?: number;
  offset?: number;
  /** 'YYYY-MM-DD' */
  startDate?: string | null;
  /** 'YYYY-MM-DD' */
  endDate?: string | null;
  bankAccount?: string | null;
  accountId?: number | null;
  categoryId?: number | null;
  recipientId?: number | null;
  isRecurring?: boolean | null;
  isExecuted?: boolean | null;
  search?: string | null;
  active?: boolean;
}

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
                WHEN c.id IS NOT NULL THEN c.path_name
                WHEN rc.id IS NOT NULL THEN rc.path_name
                WHEN pc.id IS NOT NULL THEN pc.path_name
                ELSE NULL
              END`;

// Display the recipient cluster root, matching transactionRepository. Keep
// pt.recipient_id unchanged so edit/match behavior still targets the stored
// recipient row; this expression is presentation-only.
const PLANNED_RECIPIENT_NAME_SQL = "COALESCE(pr.name, r.name)";

// `acct.name AS bank_account` is selected AFTER `pt.*` so the projected
// `bank_account` key resolves to the canonical accounts.name over the FK
// (node-postgres keeps the LAST duplicate field) — ADR-088 contract phase:
// reads must survive the out-of-band drop of the string column, and stay
// byte-identical pre-drop under the dual-write parity invariant.
const PLANNED_SELECT_FIELDS = `pt.*,
             acct.name AS bank_account,
             ${PLANNED_RECIPIENT_NAME_SQL} AS recipient_name,
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
 * @param row - a planned_transactions row (must carry id, is_loan)
 * @returns the same row, hydrated
 */
async function hydratePlannedRow(
  row: PlannedRowInHydration,
  id: number,
): Promise<HydratedPlannedTransactionRow> {
  const execResult = await query<PlannedExecutionRow>(
    `SELECT * FROM planned_transaction_executions WHERE planned_transaction_id = $1 ORDER BY execution_date DESC`,
    [id],
  );
  row.executions = execResult.rows;
  row.execution_count = execResult.rows.length;
  row.executed_transaction_id =
    execResult.rows.length > 0
      ? execResult.rows[0].executed_transaction_id
      : null;

  if (row.is_loan) {
    const scheduleResult = await query<LoanScheduleRow>(
      `SELECT installment_number, due_date, payment_amount, principal_amount, interest_amount, remaining_principal
           FROM planned_transaction_loan_schedule
          WHERE planned_transaction_id = $1
          ORDER BY installment_number ASC`,
      [id],
    );
    row.loan_schedule = scheduleResult.rows;
  } else {
    row.loan_schedule = [];
  }

  const tagResult = await query<TransactionTagRef>(
    `SELECT tg.id, tg.slug, tg.color, tg.is_active
       FROM planned_transaction_tags ptt
       JOIN tags tg ON tg.id = ptt.tag_id
       WHERE ptt.planned_transaction_id = $1
       ORDER BY tg.slug ASC`,
    [id],
  );
  row.tags = tagResult.rows;

  // Every sub-collection above is now attached.
  return row as HydratedPlannedTransactionRow;
}

function buildPlannedTransactionWhereClause({
  startDate = null,
  endDate = null,
  bankAccount = null,
  accountId = null,
  categoryId = null,
  recipientId = null,
  isRecurring = null,
  isExecuted = null,
  search = null,
  active = true,
}: PlannedTransactionFilters = {}): { whereClause: string; params: unknown[] } {
  let whereClause = "WHERE 1=1";
  const params: unknown[] = [];
  let paramIdx = 1;

  if (active) whereClause += ` AND pt.is_active = true`;
  if (startDate) {
    whereClause += ` AND pt.planned_date >= $${paramIdx++}`;
    params.push(startDate);
  }
  if (endDate) {
    whereClause += ` AND pt.planned_date <= $${paramIdx++}`;
    params.push(endDate);
  }
  // Bank filter via the FK (ADR-088) — matches the account's canonical name,
  // never the retired bank_account string.
  if (accountId != null) {
    whereClause += ` AND pt.account_id = $${paramIdx++}`;
    params.push(accountId);
  } else if (bankAccount) {
    whereClause += ` AND pt.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name ILIKE $${paramIdx++})`;
    params.push(`%${bankAccount}%`);
  }
  if (categoryId != null) {
    whereClause += ` AND pt.category_id IN (SELECT category_id FROM category_ancestors WHERE ancestor_id = $${paramIdx++})`;
    params.push(categoryId);
  }
  if (recipientId != null) {
    whereClause += ` AND pt.recipient_id = $${paramIdx++}`;
    params.push(recipientId);
  }
  if (isRecurring != null) {
    whereClause += ` AND pt.is_recurring = $${paramIdx++}`;
    params.push(isRecurring);
  }
  if (isExecuted != null) {
    whereClause += ` AND pt.is_executed = $${paramIdx++}`;
    params.push(isExecuted);
  }
  if (search) {
    const sp = `%${search}%`;
    whereClause += ` AND (
      pt.memo ILIKE $${paramIdx} OR
      pt.comment ILIKE $${paramIdx} OR
      acct.name ILIKE $${paramIdx} OR
      ${PLANNED_RECIPIENT_NAME_SQL} ILIKE $${paramIdx} OR
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

/** @param scheduleEntries `LoanScheduleRow`s or freshly computed installments. */
export async function insertLoanScheduleBatch(
  client: QueryRunner,
  plannedTransactionId: number,
  scheduleEntries: ReadonlyArray<Record<string, unknown>> = [],
): Promise<void> {
  if (!Array.isArray(scheduleEntries) || scheduleEntries.length === 0) return;

  const values: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  for (const installment of scheduleEntries) {
    values.push(
      `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`,
    );
    params.push(
      plannedTransactionId,
      installment.installment_number,
      installment.due_date,
      installment.payment_amount,
      installment.principal_amount,
      installment.interest_amount,
      installment.remaining_principal,
    );
  }

  await client.query(
    `INSERT INTO planned_transaction_loan_schedule (
       planned_transaction_id, installment_number, due_date,
       payment_amount, principal_amount, interest_amount, remaining_principal
     ) VALUES ${values.join(", ")}`,
    params,
  );
}

export async function setPlannedTransactionTags(
  client: QueryRunner,
  plannedTransactionId: number,
  slugs: string[] | null | undefined,
): Promise<void> {
  await client.query(
    "DELETE FROM planned_transaction_tags WHERE planned_transaction_id = $1",
    [plannedTransactionId],
  );
  if (!slugs || slugs.length === 0) return;
  const resolved = await client.query(
    "SELECT id FROM tags WHERE slug = ANY($1::text[]) AND is_active = true",
    [slugs],
  );
  if (resolved.rows.length === 0) return;
  const tagIds = resolved.rows.map((r: { id: number }) => r.id);
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
 * exists. The service uses this primitive when a parent update must be atomic
 * with related tag and loan-schedule writes.
 *
 * @param sanitized  output of sanitizeUpdateFields()
 * @returns false when the row is gone
 */
export async function applyPlannedFieldUpdate(
  client: QueryRunner,
  id: number,
  sanitized: Record<string, unknown>,
): Promise<boolean> {
  const {
    clauses: setClauses,
    params,
    nextIdx: paramIdx,
  } = buildSetClauses(sanitized, { quote: true });
  if (setClauses.length === 0) {
    const r = await client.query(
      "SELECT id FROM planned_transactions WHERE id = $1",
      [id],
    );
    return (r.rowCount ?? 0) > 0;
  }
  setClauses.push("updated_at = NOW()");
  params.push(id);
  const r = await client.query(
    `UPDATE planned_transactions SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING id`,
    params,
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Apply a parameterized field update and hydrate the resulting row.
 */
export async function updatePlannedFields(
  id: number,
  sanitized: Record<string, unknown>,
): Promise<HydratedPlannedTransactionRow | null> {
  const {
    clauses: setClauses,
    params,
    nextIdx: paramIdx,
  } = buildSetClauses(sanitized, { quote: true });
  if (setClauses.length === 0) return plannedTransactionRepository.getById(id);
  setClauses.push("updated_at = NOW()");
  params.push(id);
  const result = await query<PlannedTransactionListRow>(
    `WITH updated AS (
       UPDATE planned_transactions
       SET ${setClauses.join(", ")}
       WHERE id = $${paramIdx}
       RETURNING *
     )
     SELECT ${PLANNED_SELECT_FIELDS}
     FROM updated pt
     ${PLANNED_JOINS}`,
    params,
  );
  if (result.rows.length === 0) return null;
  return hydratePlannedRow(result.rows[0], id);
}

/**
 * Replace one planned transaction's amortization rows using the caller's
 * transaction client.
 */
export async function replaceLoanScheduleInTransaction(
  client: QueryRunner,
  plannedTransactionId: number,
  scheduleEntries: ReadonlyArray<Record<string, unknown>> = [],
): Promise<void> {
  await client.query(
    "DELETE FROM planned_transaction_loan_schedule WHERE planned_transaction_id = $1",
    [plannedTransactionId],
  );
  await insertLoanScheduleBatch(client, plannedTransactionId, scheduleEntries);
}

/** @returns the new planned transaction's id */
export async function insertPlannedTransactionInTransaction(
  client: QueryRunner,
  input: Record<string, unknown>,
): Promise<number> {
  const result = await client.query(
    `INSERT INTO planned_transactions (
       planned_date, account_id, recipient_id, amount, memo, currency, category_id, comment, url,
       is_recurring, recurrence_pattern, recurrence_end_date, max_occurrences,
       reminder_days_before, is_executed, is_active,
       is_loan, loan_type, loan_principal, loan_annual_interest_rate,
       loan_term_months, loan_start_date, loan_payment_day,
       loan_regular_payment_amount, loan_first_payment_date
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, false, true,
       $15, $16, $17, $18, $19, $20, $21, $22, $23
     ) RETURNING id`,
    [
      input.planned_date,
      input.account_id,
      input.recipient_id,
      input.amount,
      input.memo,
      input.currency,
      input.category_id,
      input.comment,
      input.url,
      input.is_recurring,
      input.recurrence_pattern,
      input.recurrence_end_date,
      input.max_occurrences,
      input.reminder_days_before,
      input.is_loan,
      input.loan_type,
      input.loan_principal,
      input.loan_annual_interest_rate,
      input.loan_term_months,
      input.loan_start_date,
      input.loan_payment_day,
      input.loan_regular_payment_amount,
      input.loan_first_payment_date,
    ],
  );
  return result.rows[0].id;
}

/** @returns false when the execution was already recorded */
export async function insertExecutionInTransaction(
  client: QueryRunner,
  plannedTransactionId: number,
  executedTransactionId: number,
  executionDate: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO planned_transaction_executions
       (planned_transaction_id, executed_transaction_id, execution_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (planned_transaction_id, executed_transaction_id) DO NOTHING
     RETURNING id`,
    [plannedTransactionId, executedTransactionId, executionDate],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function inheritTransactionTagsInTransaction(
  client: QueryRunner,
  transactionId: number,
  tagIds: number[],
): Promise<void> {
  await client.query(
    `INSERT INTO transaction_tags (transaction_id, tag_id)
     SELECT $1, unnest($2::int[])
     ON CONFLICT DO NOTHING`,
    [transactionId, tagIds],
  );
}

export const plannedTransactionRepository = {
  /** Lock the parent before reading recurrence state on the ambient transaction. */
  async lockForExecution(id: number): Promise<void> {
    await query(
      "SELECT id FROM planned_transactions WHERE id = $1 FOR UPDATE",
      [id],
    );
  },
  async getAll({
    limit = 50,
    offset = 0,
    startDate = null,
    endDate = null,
    bankAccount = null,
    accountId = null,
    categoryId = null,
    recipientId = null,
    isRecurring = null,
    isExecuted = null,
    search = null,
    active = true,
  }: PlannedTransactionFilters = {}): Promise<{
    items: HydratedPlannedTransactionRow[];
    total: number;
  }> {
    const { whereClause, params } = buildPlannedTransactionWhereClause({
      startDate,
      endDate,
      bankAccount,
      accountId,
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

    const result = await query<
      PlannedTransactionListRow & { total_count: string }
    >(sql, [...params, limit, offset]);
    let total =
      result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    if (result.rows.length === 0) {
      const countSql = `
        SELECT count(*)
        FROM planned_transactions pt
        ${PLANNED_JOINS}
        ${whereClause}
      `;
      const countResult = await query<{ count: string }>(countSql, params);
      total = parseInt(countResult.rows[0]?.count, 10) || 0;
    }
    const rows: PlannedRowInHydration[] = result.rows.map(
      ({ total_count: _total_count, ...row }) => row,
    );

    const plannedTransactionIds = rows.map((row) => row.id);
    const executionsByPlannedTransactionId = new Map<
      number,
      PlannedExecutionRow[]
    >();
    if (plannedTransactionIds.length > 0) {
      const executionResult = await query<PlannedExecutionRow>(
        `SELECT *
         FROM planned_transaction_executions
         WHERE planned_transaction_id = ANY($1::int[])
         ORDER BY planned_transaction_id ASC, execution_date DESC`,
        [plannedTransactionIds],
      );

      for (const execution of executionResult.rows) {
        if (
          !executionsByPlannedTransactionId.has(
            execution.planned_transaction_id,
          )
        ) {
          executionsByPlannedTransactionId.set(
            execution.planned_transaction_id,
            [],
          );
        }
        executionsByPlannedTransactionId
          .get(execution.planned_transaction_id)!
          .push(execution);
      }
    }

    const loanPlannedTransactionIds = rows
      .filter((row) => row.is_loan)
      .map((row) => row.id);

    const schedulesByPlannedTransactionId = new Map<
      number,
      LoanScheduleRow[]
    >();
    if (loanPlannedTransactionIds.length > 0) {
      const scheduleResult = await query<
        LoanScheduleRow & { planned_transaction_id: number }
      >(
        `SELECT planned_transaction_id, installment_number, due_date, payment_amount, principal_amount, interest_amount, remaining_principal
           FROM planned_transaction_loan_schedule
          WHERE planned_transaction_id = ANY($1::int[])
          ORDER BY planned_transaction_id ASC, installment_number ASC`,
        [loanPlannedTransactionIds],
      );

      for (const scheduleRow of scheduleResult.rows) {
        if (
          !schedulesByPlannedTransactionId.has(
            scheduleRow.planned_transaction_id,
          )
        ) {
          schedulesByPlannedTransactionId.set(
            scheduleRow.planned_transaction_id,
            [],
          );
        }
        const { planned_transaction_id, ...loanScheduleEntry } = scheduleRow;
        schedulesByPlannedTransactionId
          .get(planned_transaction_id)!
          .push(loanScheduleEntry);
      }
    }

    const tagsByPlannedTransactionId = new Map<number, TransactionTagRef[]>();
    if (plannedTransactionIds.length > 0) {
      const tagResult = await query<
        TransactionTagRef & { planned_transaction_id: number }
      >(
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
        tagsByPlannedTransactionId.get(planned_transaction_id)!.push(tag);
      }
    }

    for (const row of rows) {
      const executions = executionsByPlannedTransactionId.get(row.id) || [];
      row.executions = executions;
      row.execution_count = executions.length;
      row.executed_transaction_id =
        executions.length > 0 ? executions[0].executed_transaction_id : null;
      row.loan_schedule = row.is_loan
        ? schedulesByPlannedTransactionId.get(row.id) || []
        : [];
      row.tags = tagsByPlannedTransactionId.get(row.id) || [];
    }

    // The loop above attached every sub-collection to every row.
    return { items: rows as HydratedPlannedTransactionRow[], total };
  },

  // Lightweight candidate list for auto-link / match suggestions. Returns only
  // the fields the matcher needs (recipient cluster root, amount, planned_date)
  // for active, not-yet-executed rows. Loans are excluded: their installments
  // carry amortization semantics that a fuzzy recipient+amount match must not
  // silently advance. Recurring rows are always eligible (they never stay
  // is_executed=true), one-off rows only while is_executed=false.
  async listActiveUnexecuted(): Promise<PlannedMatchCandidateRow[]> {
    const result = await query<PlannedMatchCandidateRow>(
      `SELECT pt.id,
              pt.recipient_id,
              COALESCE(r.primary_recipient_id, pt.recipient_id) AS recipient_cluster_id,
              pt.amount,
              pt.planned_date,
              pt.currency,
              pt.is_recurring,
              pt.recurrence_pattern,
              pt.memo,
              ${PLANNED_RECIPIENT_NAME_SQL} AS recipient_name
         FROM planned_transactions pt
         LEFT JOIN recipients r ON pt.recipient_id = r.id
         LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
        WHERE pt.is_active = true
          AND pt.is_executed = false
          AND pt.recipient_id IS NOT NULL
          AND (pt.is_loan = false OR pt.is_loan IS NULL)`,
    );
    return result.rows;
  },

  async getById(id: number): Promise<HydratedPlannedTransactionRow | null> {
    const sql = `
      SELECT ${PLANNED_SELECT_FIELDS}
      FROM planned_transactions pt
      ${PLANNED_JOINS}
      WHERE pt.id = $1
    `;
    const result = await query<PlannedTransactionListRow>(sql, [id]);
    if (result.rows.length === 0) return null;

    return hydratePlannedRow(result.rows[0], id);
  },

  /**
   * Return active, unexecuted planned transactions whose planned_date falls within
   * the next `days` days. Used by the bill-reminder endpoint.
   *
   * The window is anchored on the APP_TIMEZONE calendar day (ADR-009), read
   * once and bound as $2 — not Postgres `CURRENT_DATE`, whose session-zone
   * (UTC) day lags the app day for the last hours of every UTC day, shifting
   * both window edges. Same one-clock rule as infoRepositoryForecast.js; the
   * lookahead binds via make_interval rather than string-concatenating a bound
   * value into an interval literal.
   *
   * @param days - Lookahead window (1–365)
   */
  async getDueSoon(days: number): Promise<PlannedTransactionListRow[]> {
    const sql = `
      SELECT ${PLANNED_SELECT_FIELDS}
      FROM planned_transactions pt
      ${PLANNED_JOINS}
      WHERE pt.is_active = true
        AND pt.is_executed = false
        AND pt.planned_date >= $2::date
        AND pt.planned_date <= $2::date + make_interval(days => $1::int)
      ORDER BY pt.planned_date ASC
    `;
    const result = await query<PlannedTransactionListRow>(sql, [
      days,
      todayAppDateString(),
    ]);
    return result.rows;
  },

  /**
   * Return all active, unexecuted planned transactions whose planned_date is on or
   * before the forecast horizon (today + `months` months). Includes recurring
   * transactions that have already started (planned_date may be before today if
   * the user hasn't executed them yet).
   *
   * "Today" is the APP_TIMEZONE calendar day bound as $2 (ADR-009, one clock —
   * see getDueSoon), matching the horizon math of the forecast surfaces that
   * consume these rows.
   *
   * @param months - Forecast horizon in months (1–24)
   */
  async getForForecast(months: number): Promise<PlannedForecastRow[]> {
    const sql = `
      SELECT pt.id, pt.planned_date, pt.amount, pt.currency,
             pt.memo, pt.is_recurring, pt.recurrence_pattern,
             ${PLANNED_RECIPIENT_NAME_SQL} AS recipient_name,
             ${PLANNED_CATEGORY_NAME_SQL} AS category_name
      FROM planned_transactions pt
      ${PLANNED_JOINS}
      WHERE pt.is_active = true
        AND pt.is_executed = false
        AND pt.planned_date <= $2::date + make_interval(months => $1::int)
      ORDER BY pt.planned_date ASC
    `;
    const result = await query<PlannedForecastRow>(sql, [
      months,
      todayAppDateString(),
    ]);
    return result.rows;
  },

  /**
   * Active, unexecuted commitments through an inclusive day boundary.
   * @param horizonEnd 'YYYY-MM-DD'
   */
  async getForCommitmentProjection(
    horizonEnd: string,
  ): Promise<PlannedCommitmentRow[]> {
    const result = await query<PlannedCommitmentRow>(
      `SELECT pt.id, pt.planned_date, pt.amount, pt.currency,
              pt.is_recurring, pt.recurrence_pattern,
              pt.recurrence_end_date, pt.max_occurrences,
              (SELECT COUNT(*)::int FROM planned_transaction_executions pte
                WHERE pte.planned_transaction_id = pt.id) AS execution_count
         FROM planned_transactions pt
        WHERE pt.is_active = true AND pt.is_executed = false
          AND pt.planned_date <= $1::date
        ORDER BY pt.planned_date, pt.id`,
      [horizonEnd],
    );
    return result.rows;
  },

  async hardDelete(id: number): Promise<boolean> {
    const result = await query(
      "DELETE FROM planned_transactions WHERE id = $1",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /** @param executionDate 'YYYY-MM-DD'; defaults to app-timezone today */
  async addExecution(
    plannedTransactionId: number,
    executedTransactionId: number,
    executionDate?: string | null,
  ): Promise<void> {
    await query(
      `INSERT INTO planned_transaction_executions (planned_transaction_id, executed_transaction_id, execution_date)
       VALUES ($1, $2, $3)`,
      // App-timezone today (ADR-009) — the UTC calendar day is yesterday
      // between local midnight and 01:00/02:00 Brussels.
      [
        plannedTransactionId,
        executedTransactionId,
        executionDate || todayAppDateString(),
      ],
    );
  },

  /**
   * Repoint planned transactions off merged-away source accounts onto the
   * survivor.
   *
   * @returns rows repointed
   */
  async repointAccount(targetId: number, sourceIds: number[]): Promise<number> {
    const result = await query(
      `UPDATE planned_transactions SET account_id = $1 WHERE account_id = ANY($2::int[])`,
      [targetId, sourceIds],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Does planned_transactions carry recipient_id? Very old schemas predate the
   * column, and the recipient merge must skip the repoint rather than fail.
   */
  async hasRecipientIdColumn(): Promise<boolean> {
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
   * @returns rows repointed
   */
  async repointRecipient(
    primaryId: number,
    aliasIds: number[],
  ): Promise<number> {
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
