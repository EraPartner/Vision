/**
 * Planned Transaction Repository - data access for planned_transactions table.
 *
 */

import { sql } from "kysely";
import type { Updateable } from "kysely";
import { checkedRow, checkedRows, compileQuery, db } from "../database/db.ts";
import type { BuiltQuery } from "../database/db.ts";
import type { PlannedTransactions } from "../database/schema.generated.ts";
import {
  countRowSchema,
  keyedLoanScheduleRowSchema,
  loanScheduleRowSchema,
  plannedCommitmentRowSchema,
  plannedExecutionRowSchema,
  plannedForecastRowSchema,
  plannedMatchCandidateRowSchema,
  plannedTagRowSchema,
  plannedTransactionListRowSchema,
  plannedTransactionKeyRowSchema,
  plannedTransactionPageRowSchema,
  pgRecipientId,
  tagKeyRowSchema,
  transactionTagRefSchema,
} from "../database/rowSchemas.ts";
import type {
  AccountId,
  CategoryId,
  PlannedTransactionId,
  RecipientId,
  TagId,
  TransactionId,
} from "@vision/types/brands";
import { todayAppDateString } from "../lib/timezone.ts";

import { z } from "zod";
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
import { nanToZero } from "../lib/math.ts";

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
export type PlannedCommitmentRow = z.output<typeof plannedCommitmentRowSchema>;

/** Filters shared by getAll and the count fallback. */
export interface PlannedTransactionFilters {
  limit?: number | undefined;
  offset?: number | undefined;
  /** 'YYYY-MM-DD' */
  startDate?: string | null | undefined;
  /** 'YYYY-MM-DD' */
  endDate?: string | null | undefined;
  bankAccount?: string | null | undefined;
  accountId?: AccountId | null | undefined;
  categoryId?: CategoryId | null | undefined;
  recipientId?: RecipientId | null | undefined;
  isRecurring?: boolean | null | undefined;
  isExecuted?: boolean | null | undefined;
  search?: string | null | undefined;
  active?: boolean | undefined;
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
const plannedCategoryName = sql<string | null>`CASE
                WHEN c.id IS NOT NULL THEN c.path_name
                WHEN rc.id IS NOT NULL THEN rc.path_name
                WHEN pc.id IS NOT NULL THEN pc.path_name
                ELSE NULL
              END`;

// Display the recipient cluster root, matching transactionRepository. Keep
// pt.recipient_id unchanged so edit/match behavior still targets the stored
// recipient row; this expression is presentation-only.
const plannedRecipientName = sql<string | null>`COALESCE(pr.name, r.name)`;

function plannedJoins() {
  return db
    .selectFrom("planned_transactions as pt")
    .leftJoin("recipients as r", "pt.recipient_id", "r.id")
    .leftJoin("recipients as pr", "r.primary_recipient_id", "pr.id")
    .leftJoin("categories as c", "pt.category_id", "c.id")
    .leftJoin("categories as rc", "r.default_category_id", "rc.id")
    .leftJoin("categories as pc", "pr.default_category_id", "pc.id")
    .leftJoin("accounts as acct", "pt.account_id", "acct.id");
}

type PlannedJoinQuery = ReturnType<typeof plannedJoins>;

// `acct.name AS bank_account` is selected AFTER `pt.*` so the projected
// `bank_account` key resolves to the canonical accounts.name over the FK
// (node-postgres keeps the LAST duplicate field) — ADR-088 contract phase:
// reads must survive the out-of-band drop of the string column, and stay
// byte-identical pre-drop under the dual-write parity invariant.
function selectPlannedFields(builder: PlannedJoinQuery) {
  return builder
    .selectAll("pt")
    .select([
      "acct.name as bank_account",
      plannedRecipientName.as("recipient_name"),
      plannedCategoryName.as("category_name"),
    ]);
}

/** Run a built query on the caller's transaction client. */
async function runOn(client: QueryRunner, builder: BuiltQuery) {
  const compiled = compileQuery(builder);
  return client.query(compiled.sql, [...compiled.parameters]);
}

/**
 * Attach the executions, loan_schedule and tags sub-collections to a hydrated
 * planned-transaction row. Identical between getById() and update(); mutates and
 * returns the row.
 *
 * @param row - a planned_transactions row (must carry id, is_loan)
 * @returns the same row, hydrated
 */
const LOAN_SCHEDULE_COLUMNS = [
  "installment_number",
  "due_date",
  "payment_amount",
  "principal_amount",
  "interest_amount",
  "remaining_principal",
] as const;

async function hydratePlannedRow(
  row: PlannedRowInHydration,
  id: PlannedTransactionId,
): Promise<HydratedPlannedTransactionRow> {
  const executions = await checkedRows(
    plannedExecutionRowSchema,
    db
      .selectFrom("planned_transaction_executions")
      .selectAll()
      .where("planned_transaction_id", "=", id)
      .orderBy("execution_date", "desc"),
  );
  row.executions = executions;
  row.execution_count = executions.length;
  row.executed_transaction_id = executions[0]?.executed_transaction_id ?? null;

  if (row.is_loan) {
    row.loan_schedule = await checkedRows(
      loanScheduleRowSchema,
      db
        .selectFrom("planned_transaction_loan_schedule")
        .select(LOAN_SCHEDULE_COLUMNS)
        .where("planned_transaction_id", "=", id)
        .orderBy("installment_number", "asc"),
    );
  } else {
    row.loan_schedule = [];
  }

  row.tags = await checkedRows(
    transactionTagRefSchema,
    db
      .selectFrom("planned_transaction_tags as ptt")
      .innerJoin("tags as tg", "tg.id", "ptt.tag_id")
      .select(["tg.id", "tg.slug", "tg.color", "tg.is_active"])
      .where("ptt.planned_transaction_id", "=", id)
      .orderBy("tg.slug", "asc"),
  );

  // Every sub-collection above is now attached.
  return row as HydratedPlannedTransactionRow;
}

function filterPlannedTransactions({
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
}: PlannedTransactionFilters = {}): PlannedJoinQuery {
  let builder = plannedJoins();

  if (active) builder = builder.where("pt.is_active", "=", true);
  if (startDate)
    builder = builder.where("pt.planned_date", ">=", sql<Date>`${startDate}`);
  if (endDate)
    builder = builder.where("pt.planned_date", "<=", sql<Date>`${endDate}`);
  // Bank filter via the FK (ADR-088) — matches the account's canonical name,
  // never the retired bank_account string.
  if (accountId != null) {
    builder = builder.where("pt.account_id", "=", accountId);
  } else if (bankAccount) {
    builder = builder.where("pt.account_id", "in", (eb) =>
      eb
        .selectFrom("accounts as fa")
        .select("fa.id")
        .where("fa.name", "ilike", `%${bankAccount}%`),
    );
  }
  if (categoryId != null) {
    builder = builder.where(
      sql<boolean>`pt.category_id IN (SELECT category_id FROM category_ancestors WHERE ancestor_id = ${categoryId})`,
    );
  }
  if (recipientId != null)
    builder = builder.where("pt.recipient_id", "=", recipientId);
  if (isRecurring != null)
    builder = builder.where("pt.is_recurring", "=", isRecurring);
  if (isExecuted != null)
    builder = builder.where("pt.is_executed", "=", isExecuted);
  if (search) {
    const sp = `%${search}%`;
    builder = builder.where((eb) =>
      eb.or([
        eb("pt.memo", "ilike", sp),
        eb("pt.comment", "ilike", sp),
        eb("acct.name", "ilike", sp),
        eb(plannedRecipientName, "ilike", sp),
        eb("r.name", "ilike", sp),
        // Match the RESOLVED label the row displays, not each candidate level
        // in turn. ORing c/rc separately both missed rows categorised through
        // the primary recipient (no pc term at all) and matched rows whose own
        // category_id overrode the recipient default the term hit.
        eb(plannedCategoryName, "ilike", sp),
      ]),
    );
  }

  return builder;
}

/** Append to the list under `key`, creating it on first use. */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** One installment to write: a `LoanScheduleRow` or a computed `LoanInstallment`. */
export type LoanScheduleEntryInput = {
  installment_number: unknown;
  due_date: unknown;
  payment_amount: unknown;
  principal_amount: unknown;
  interest_amount: unknown;
  remaining_principal: unknown;
};

/** @param scheduleEntries `LoanScheduleRow`s or freshly computed installments. */
export async function insertLoanScheduleBatch(
  client: QueryRunner,
  plannedTransactionId: PlannedTransactionId,
  scheduleEntries: ReadonlyArray<LoanScheduleEntryInput> = [],
): Promise<void> {
  if (!Array.isArray(scheduleEntries) || scheduleEntries.length === 0) return;

  const values = scheduleEntries.map(
    (installment: LoanScheduleEntryInput) =>
      sql`(${plannedTransactionId}, ${installment.installment_number}, ${installment.due_date},
           ${installment.payment_amount}, ${installment.principal_amount},
           ${installment.interest_amount}, ${installment.remaining_principal})`,
  );

  await runOn(
    client,
    sql`INSERT INTO planned_transaction_loan_schedule (
       planned_transaction_id, installment_number, due_date,
       payment_amount, principal_amount, interest_amount, remaining_principal
     ) VALUES ${sql.join(values)}`,
  );
}

export async function setPlannedTransactionTags(
  client: QueryRunner,
  plannedTransactionId: PlannedTransactionId,
  slugs: string[] | null | undefined,
): Promise<void> {
  await runOn(
    client,
    db
      .deleteFrom("planned_transaction_tags")
      .where("planned_transaction_id", "=", plannedTransactionId),
  );
  if (!slugs || slugs.length === 0) return;
  const resolved = await checkedRows(
    tagKeyRowSchema,
    db
      .selectFrom("tags")
      .select("id")
      .where("slug", "=", sql<string>`ANY(${slugs}::text[])`)
      .where("is_active", "=", true),
    client,
  );
  if (resolved.length === 0) return;
  const tagIds = resolved.map((r) => r.id);
  await runOn(
    client,
    sql`INSERT INTO planned_transaction_tags (planned_transaction_id, tag_id)
     SELECT ${plannedTransactionId}, unnest(${tagIds}::int[])
     ON CONFLICT DO NOTHING`,
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
  id: PlannedTransactionId,
  sanitized: Record<string, unknown>,
): Promise<boolean> {
  // sanitizeUpdateFields() already whitelisted the planned_transactions columns.
  const changes = Object.fromEntries(
    Object.entries(sanitized).filter(([, value]) => value !== undefined),
  ) as Updateable<PlannedTransactions>;
  if (Object.keys(changes).length === 0) {
    const r = await runOn(
      client,
      db.selectFrom("planned_transactions").select("id").where("id", "=", id),
    );
    return (r.rowCount ?? 0) > 0;
  }
  const r = await runOn(
    client,
    db
      .updateTable("planned_transactions")
      .set({ ...changes, updated_at: sql<Date>`NOW()` })
      .where("id", "=", id)
      .returning("id"),
  );
  return (r.rowCount ?? 0) > 0;
}
/**
 * Replace one planned transaction's amortization rows using the caller's
 * transaction client.
 */
export async function replaceLoanScheduleInTransaction(
  client: QueryRunner,
  plannedTransactionId: PlannedTransactionId,
  scheduleEntries: ReadonlyArray<LoanScheduleEntryInput> = [],
): Promise<void> {
  await runOn(
    client,
    db
      .deleteFrom("planned_transaction_loan_schedule")
      .where("planned_transaction_id", "=", plannedTransactionId),
  );
  await insertLoanScheduleBatch(client, plannedTransactionId, scheduleEntries);
}

/** @returns the new planned transaction's id */
export async function insertPlannedTransactionInTransaction(
  client: QueryRunner,
  input: Record<string, unknown>,
): Promise<PlannedTransactionId> {
  const inserted = await checkedRow(
    plannedTransactionKeyRowSchema,
    sql`INSERT INTO planned_transactions (
       planned_date, account_id, recipient_id, amount, memo, currency, category_id, comment, url,
       is_recurring, recurrence_pattern, recurrence_end_date, max_occurrences,
       reminder_days_before, is_executed, is_active,
       is_loan, loan_type, loan_principal, loan_annual_interest_rate,
       loan_term_months, loan_start_date, loan_payment_day,
       loan_regular_payment_amount, loan_first_payment_date
     ) VALUES (
       ${input.planned_date}, ${input.account_id}, ${input.recipient_id},
       ${input.amount}, ${input.memo}, ${input.currency}, ${input.category_id},
       ${input.comment}, ${input.url},
       ${input.is_recurring}, ${input.recurrence_pattern},
       ${input.recurrence_end_date}, ${input.max_occurrences},
       ${input.reminder_days_before}, false, true,
       ${input.is_loan}, ${input.loan_type}, ${input.loan_principal},
       ${input.loan_annual_interest_rate}, ${input.loan_term_months},
       ${input.loan_start_date}, ${input.loan_payment_day},
       ${input.loan_regular_payment_amount}, ${input.loan_first_payment_date}
     ) RETURNING id`,
    client,
  );
  // A plain INSERT ... RETURNING yields exactly one row or throws.
  if (!inserted) throw new Error("planned transaction INSERT returned no row");
  return inserted.id;
}

/** @returns false when the execution was already recorded */
export async function insertExecutionInTransaction(
  client: QueryRunner,
  plannedTransactionId: PlannedTransactionId,
  executedTransactionId: TransactionId,
  executionDate: string,
): Promise<boolean> {
  const result = await runOn(
    client,
    db
      .insertInto("planned_transaction_executions")
      .values({
        planned_transaction_id: plannedTransactionId,
        executed_transaction_id: executedTransactionId,
        execution_date: executionDate,
      })
      .onConflict((oc) =>
        oc
          .columns(["planned_transaction_id", "executed_transaction_id"])
          .doNothing(),
      )
      .returning("id"),
  );
  return (result.rowCount ?? 0) > 0;
}

export async function inheritTransactionTagsInTransaction(
  client: QueryRunner,
  transactionId: TransactionId,
  tagIds: TagId[],
): Promise<void> {
  await runOn(
    client,
    sql`INSERT INTO transaction_tags (transaction_id, tag_id)
     SELECT ${transactionId}, unnest(${tagIds}::int[])
     ON CONFLICT DO NOTHING`,
  );
}

export const plannedTransactionRepository = {
  /** Lock the parent before reading recurrence state on the ambient transaction. */
  async lockForExecution(id: PlannedTransactionId): Promise<void> {
    await db
      .selectFrom("planned_transactions")
      .select("id")
      .where("id", "=", id)
      .forUpdate()
      .execute();
  },
  /** Execution needs scalar state and tag IDs, not full history or loan schedules. */
  async getExecutionState(
    id: PlannedTransactionId,
    transactionId: TransactionId,
  ) {
    const row = await checkedRow(
      plannedTransactionListRowSchema.extend({
        execution_count: z.number(),
        duplicate: z.boolean(),
        recipient_cluster_id: pgRecipientId.nullable(),
      }),
      selectPlannedFields(plannedJoins().where("pt.id", "=", id)).select(
        (eb) => [
          eb.fn
            .coalesce("r.primary_recipient_id", "pt.recipient_id")
            .as("recipient_cluster_id"),
          eb
            .selectFrom("planned_transaction_executions as e")
            .select(sql<number>`count(*)::int`.as("n"))
            .whereRef("e.planned_transaction_id", "=", "pt.id")
            .as("execution_count"),
          eb
            .exists(
              eb
                .selectFrom("planned_transaction_executions as e")
                .select(sql<number>`1`.as("one"))
                .whereRef("e.planned_transaction_id", "=", "pt.id")
                .where("e.executed_transaction_id", "=", transactionId),
            )
            .as("duplicate"),
        ],
      ),
    );
    if (!row) return null;
    const tags = await checkedRows(
      tagKeyRowSchema,
      db
        .selectFrom("planned_transaction_tags")
        .select("tag_id as id")
        .where("planned_transaction_id", "=", id),
    );
    return { ...row, tags };
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
    const filtered = filterPlannedTransactions({
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

    const pageRows = await checkedRows(
      plannedTransactionPageRowSchema,
      selectPlannedFields(filtered)
        .select(sql<string>`COUNT(*) OVER()`.as("total_count"))
        .orderBy("pt.planned_date", "desc")
        .limit(limit)
        .offset(offset),
    );
    const [firstPageRow] = pageRows;
    let total = firstPageRow ? parseInt(firstPageRow.total_count, 10) : 0;
    if (!firstPageRow) {
      const countRow = await checkedRow(
        countRowSchema,
        filtered.select(sql<string>`count(*)`.as("count")),
      );
      // String(): parseInt coerced a missing row's `undefined` the same way.
      total = nanToZero(parseInt(String(countRow?.count), 10));
    }
    const rows: PlannedRowInHydration[] = pageRows.map(
      ({ total_count: _total_count, ...row }) => row,
    );

    const plannedTransactionIds = rows.map((row) => row.id);
    const executionsByPlannedTransactionId = new Map<
      PlannedTransactionId,
      PlannedExecutionRow[]
    >();
    if (plannedTransactionIds.length > 0) {
      const executionRows = await checkedRows(
        plannedExecutionRowSchema,
        db
          .selectFrom("planned_transaction_executions")
          .selectAll()
          .where(
            "planned_transaction_id",
            "=",
            sql<PlannedTransactionId>`ANY(${plannedTransactionIds}::int[])`,
          )
          .orderBy("planned_transaction_id", "asc")
          .orderBy("execution_date", "desc"),
      );

      for (const execution of executionRows) {
        pushTo(
          executionsByPlannedTransactionId,
          execution.planned_transaction_id,
          execution,
        );
      }
    }

    const loanPlannedTransactionIds = rows
      .filter((row) => row.is_loan)
      .map((row) => row.id);

    const schedulesByPlannedTransactionId = new Map<
      PlannedTransactionId,
      LoanScheduleRow[]
    >();
    if (loanPlannedTransactionIds.length > 0) {
      const scheduleRows = await checkedRows(
        keyedLoanScheduleRowSchema,
        db
          .selectFrom("planned_transaction_loan_schedule")
          .select(["planned_transaction_id", ...LOAN_SCHEDULE_COLUMNS])
          .where(
            "planned_transaction_id",
            "=",
            sql<PlannedTransactionId>`ANY(${loanPlannedTransactionIds}::int[])`,
          )
          .orderBy("planned_transaction_id", "asc")
          .orderBy("installment_number", "asc"),
      );

      for (const scheduleRow of scheduleRows) {
        const { planned_transaction_id, ...loanScheduleEntry } = scheduleRow;
        pushTo(
          schedulesByPlannedTransactionId,
          planned_transaction_id,
          loanScheduleEntry,
        );
      }
    }

    const tagsByPlannedTransactionId = new Map<PlannedTransactionId, TransactionTagRef[]>();
    if (plannedTransactionIds.length > 0) {
      const tagRows = await checkedRows(
        plannedTagRowSchema,
        db
          .selectFrom("planned_transaction_tags as ptt")
          .innerJoin("tags as tg", "tg.id", "ptt.tag_id")
          .select([
            "ptt.planned_transaction_id",
            "tg.id",
            "tg.slug",
            "tg.color",
            "tg.is_active",
          ])
          .where(
            "ptt.planned_transaction_id",
            "=",
            sql<PlannedTransactionId>`ANY(${plannedTransactionIds}::int[])`,
          )
          .orderBy("ptt.planned_transaction_id", "asc")
          .orderBy("tg.slug", "asc"),
      );
      for (const tagRow of tagRows) {
        const { planned_transaction_id, ...tag } = tagRow;
        pushTo(tagsByPlannedTransactionId, planned_transaction_id, tag);
      }
    }

    for (const row of rows) {
      const executions = executionsByPlannedTransactionId.get(row.id) ?? [];
      row.executions = executions;
      row.execution_count = executions.length;
      row.executed_transaction_id =
        executions[0]?.executed_transaction_id ?? null;
      row.loan_schedule = row.is_loan
        ? schedulesByPlannedTransactionId.get(row.id) ?? []
        : [];
      row.tags = tagsByPlannedTransactionId.get(row.id) ?? [];
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
    return checkedRows(
      plannedMatchCandidateRowSchema,
      db
        .selectFrom("planned_transactions as pt")
        .leftJoin("recipients as r", "pt.recipient_id", "r.id")
        .leftJoin("recipients as pr", "r.primary_recipient_id", "pr.id")
        .select((eb) => [
          "pt.id",
          "pt.recipient_id",
          eb.fn
            .coalesce("r.primary_recipient_id", "pt.recipient_id")
            .as("recipient_cluster_id"),
          "pt.amount",
          "pt.planned_date",
          "pt.currency",
          "pt.is_recurring",
          "pt.recurrence_pattern",
          "pt.memo",
          plannedRecipientName.as("recipient_name"),
        ])
        .where("pt.is_active", "=", true)
        .where("pt.is_executed", "=", false)
        .where("pt.recipient_id", "is not", null)
        .where((eb) =>
          eb.or([eb("pt.is_loan", "=", false), eb("pt.is_loan", "is", null)]),
        ),
    );
  },

  async getById(id: PlannedTransactionId): Promise<HydratedPlannedTransactionRow | null> {
    const row = await checkedRow(
      plannedTransactionListRowSchema,
      selectPlannedFields(plannedJoins().where("pt.id", "=", id)),
    );
    if (!row) return null;

    return hydratePlannedRow(row, id);
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
    const today = todayAppDateString();
    return checkedRows(
      plannedTransactionListRowSchema,
      selectPlannedFields(
        plannedJoins()
          .where("pt.is_active", "=", true)
          .where("pt.is_executed", "=", false)
          .where("pt.planned_date", ">=", sql<Date>`${today}::date`)
          .where(
            "pt.planned_date",
            "<=",
            sql<Date>`${today}::date + make_interval(days => ${days}::int)`,
          ),
      ).orderBy("pt.planned_date", "asc"),
    );
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
    return checkedRows(
      plannedForecastRowSchema,
      plannedJoins()
        .select([
          "pt.id",
          "pt.planned_date",
          "pt.amount",
          "pt.currency",
          "pt.memo",
          "pt.is_recurring",
          "pt.recurrence_pattern",
          plannedRecipientName.as("recipient_name"),
          plannedCategoryName.as("category_name"),
        ])
        .where("pt.is_active", "=", true)
        .where("pt.is_executed", "=", false)
        .where(
          "pt.planned_date",
          "<=",
          sql<Date>`${todayAppDateString()}::date + make_interval(months => ${months}::int)`,
        )
        .orderBy("pt.planned_date", "asc"),
    );
  },

  /**
   * Active, unexecuted commitments through an inclusive day boundary.
   * @param horizonEnd 'YYYY-MM-DD'
   */
  async getForCommitmentProjection(
    horizonEnd: string,
  ): Promise<PlannedCommitmentRow[]> {
    return checkedRows(
      plannedCommitmentRowSchema,
      db
        .selectFrom("planned_transactions as pt")
        .select((eb) => [
          "pt.id",
          "pt.planned_date",
          "pt.amount",
          "pt.currency",
          "pt.is_recurring",
          "pt.recurrence_pattern",
          "pt.recurrence_end_date",
          "pt.max_occurrences",
          eb
            .selectFrom("planned_transaction_executions as pte")
            .select(sql<number>`COUNT(*)::int`.as("n"))
            .whereRef("pte.planned_transaction_id", "=", "pt.id")
            .as("execution_count"),
        ])
        .where("pt.is_active", "=", true)
        .where("pt.is_executed", "=", false)
        .where("pt.planned_date", "<=", sql<Date>`${horizonEnd}::date`)
        .orderBy("pt.planned_date")
        .orderBy("pt.id"),
    );
  },

  async hardDelete(id: PlannedTransactionId): Promise<boolean> {
    const result = await db
      .deleteFrom("planned_transactions")
      .where("id", "=", id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  },

  /** @param executionDate 'YYYY-MM-DD'; defaults to app-timezone today */
  async addExecution(
    plannedTransactionId: PlannedTransactionId,
    executedTransactionId: TransactionId,
    executionDate?: string | null,
  ): Promise<void> {
    await db
      .insertInto("planned_transaction_executions")
      .values({
        planned_transaction_id: plannedTransactionId,
        executed_transaction_id: executedTransactionId,
        // App-timezone today (ADR-009) — the UTC calendar day is yesterday
        // between local midnight and 01:00/02:00 Brussels.
        execution_date: executionDate || todayAppDateString(),
      })
      .execute();
  },

  /**
   * Repoint planned transactions off merged-away source accounts onto the
   * survivor.
   *
   * @returns rows repointed
   */
  async repointAccount(
    targetId: AccountId,
    sourceIds: AccountId[],
  ): Promise<number> {
    const result = await db
      .updateTable("planned_transactions")
      .set({ account_id: targetId })
      .where("account_id", "=", sql<AccountId>`ANY(${sourceIds}::int[])`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  },

  /**
   * Does planned_transactions carry recipient_id? Very old schemas predate the
   * column, and the recipient merge must skip the repoint rather than fail.
   */
  async hasRecipientIdColumn(): Promise<boolean> {
    const { rows } = await sql`SELECT 1 FROM information_schema.columns
       WHERE table_name = 'planned_transactions' AND column_name = 'recipient_id'
       LIMIT 1`.execute(db);
    return rows.length > 0;
  },

  /**
   * Repoint planned transactions off merged alias recipients onto the primary.
   *
   * @returns rows repointed
   */
  async repointRecipient(
    primaryId: RecipientId,
    aliasIds: RecipientId[],
  ): Promise<number> {
    const result = await db
      .updateTable("planned_transactions")
      .set({ recipient_id: primaryId })
      .where("recipient_id", "=", sql<RecipientId>`ANY(${aliasIds}::int[])`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  },
};

export default plannedTransactionRepository;
