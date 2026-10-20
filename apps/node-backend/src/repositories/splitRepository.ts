/**
 * Split Repository - data access for transaction_splits and split_payments tables.
 *
 * Owed-summary reads from agg_split_outstanding (trigger-maintained by
 * migration 0026) instead of a live aggregate join.
 */

import { sql } from "kysely";
import { query } from "../database/connection.ts";
import { checkedRow, checkedRows, compileQuery, db } from "../database/db.ts";
import type { BuiltQuery } from "../database/db.ts";
import {
  countRowSchema,
  owedExportRawRowSchema,
  owedRemainingCurrencyRowSchema,
  owedSplitRawRowSchema,
  splitOutstandingCurrencyRowSchema,
  splitPaymentRowSchema,
  splitTotalsRowSchema,
  transactionSplitRowSchema,
} from "../database/rowSchemas.ts";
import {
  splitPaidRowSchema,
  splitPaymentLockRowSchema,
} from "../database/rows/ledger.ts";
import { toWireDate } from "../lib/dateFormat.ts";
import { toDecimal, toNumber } from "../lib/money.ts";
import type { SplitOutstandingRow } from "../lib/calculations/splits.ts";
import type { z } from "zod";
import type {
  CurrencyCode,
  RecipientId,
  SplitId,
  TransactionId,
} from "@vision/types/brands";
import type {
  FormattedSplit,
  FormattedSplitPayment,
  QueryRunner,
  SplitPaymentRow,
  SplitTotals,
  TransactionSplitRow,
} from "../types/rows.ts";

export type { QueryRunner, FormattedSplit, FormattedSplitPayment, SplitTotals };

/**
 * A raw `getOwedByRecipientRows` row: the split columns plus its parent
 * transaction's, before the service formats it into an `OwedSplitDetailRow`.
 */
export type OwedSplitRawRow = z.output<typeof owedSplitRawRowSchema>;

/** One `getOwedExportRowsByRecipient` row (transaction CSV shape). */
export interface OwedExportRow {
  date: Date;
  bank_account: string | null;
  recipient_name: string | null;
  memo: string | null;
  amount: number;
  currency: CurrencyCode | null;
  balance: string | null;
  category_name: string;
  comment: string | null;
}

/** Raw splitTotalsQuery row: both aggregates are pg NUMERIC strings. */
type SplitTotalsRow = z.output<typeof splitTotalsRowSchema>;

/**
 * CTE that resolves a recipient to every recipient id in the same merge/alias group:
 *   - the recipient itself
 *   - any aliases pointing at it (when $1 is the primary)
 *   - the recipient's own primary (when $1 is an alias)
 *   - sibling aliases sharing that primary
 *
 * Used by owed-detail / export / settle-all so that linked recipients
 * resolve as a single unit even when historical splits still reference
 * the alias's recipient_id (legacy data prior to atomic-merge backfill).
 */
interface PageOptions {
  limit?: number | null;
  offset?: number;
}

function recipientGroupCte(recipientId: RecipientId) {
  return sql`
    WITH recipient_group AS (
      SELECT id FROM recipients
      WHERE id = ${recipientId}
         OR primary_recipient_id = ${recipientId}
         OR id = (SELECT primary_recipient_id FROM recipients WHERE id = ${recipientId} AND primary_recipient_id IS NOT NULL)
         OR primary_recipient_id = (SELECT primary_recipient_id FROM recipients WHERE id = ${recipientId} AND primary_recipient_id IS NOT NULL)
    )
  `;
}

/**
 * Split-allocation totals for a transaction: the transaction's absolute amount
 * and the sum of its existing splits.
 */
function splitTotalsQuery(transactionId: TransactionId) {
  return db
    .selectFrom("transactions as t")
    .leftJoin("transaction_splits as ts", "ts.transaction_id", "t.id")
    .select([
      sql<string>`ABS(t.amount)`.as("transaction_total"),
      sql<string>`COALESCE(SUM(ts.amount), 0)`.as("current_split_total"),
    ])
    .where("t.id", "=", transactionId)
    .groupBy(["t.id", "t.amount"]);
}

/** Run a built query on the caller's client, or on the ambient connection. */
async function runOn(client: QueryRunner | null, builder: BuiltQuery) {
  const compiled = compileQuery(builder);
  return (client ?? { query }).query(compiled.sql, [...compiled.parameters]);
}

/** A split's summed payments: one `paid` NUMERIC row. */
function paidQuery(splitId: SplitId) {
  return db
    .selectFrom("split_payments")
    .select(sql<string>`COALESCE(SUM(amount), 0)`.as("paid"))
    .where("split_id", "=", splitId);
}

/** The split's summed payments, as a LATERAL subquery aliased `sp_agg`. */
function paidLateral(splitIdRef: "ts.id" | "settled.id") {
  return sql`LATERAL (
    SELECT SUM(amount) AS paid FROM split_payments WHERE split_id = ${sql.ref(splitIdRef)}
  )`;
}

/**
 * Coerce a splitTotalsQuery row to the numeric totals shape (both aggregates
 * arrive as pg NUMERIC strings).
 */
function mapSplitTotals(row: SplitTotalsRow): SplitTotals {
  return {
    transaction_total: toNumber(toDecimal(row.transaction_total)),
    current_split_total: toNumber(toDecimal(row.current_split_total)),
  };
}

/**
 * Lock the transaction row (SELECT … FOR UPDATE) inside the caller's
 * transaction, then read its split-allocation totals. The lock serializes the
 * validate→insert window so concurrent split creation cannot over-allocate.
 */
export async function lockAndGetTotals(
  client: QueryRunner,
  transactionId: TransactionId,
): Promise<SplitTotals | null> {
  const lockResult = await runOn(
    client,
    db
      .selectFrom("transactions")
      .select("id")
      .where("id", "=", transactionId)
      .forUpdate(),
  );
  if (lockResult.rows.length === 0) return null;
  const [totals] = await checkedRows(
    splitTotalsRowSchema,
    splitTotalsQuery(transactionId),
    client,
  );
  // GROUP BY t.id over the row just locked: exactly one row.
  if (!totals) throw new Error("split totals returned no row");
  return mapSplitTotals(totals);
}

/**
 * Existence check for the recipient a bulk split writes to, inside the
 * caller's transaction. The FK would reject an unknown id on INSERT, but as a
 * raw 23503 after some rows were already written; checking up front turns it
 * into a 404 before any write.
 */
export async function recipientExistsInTransaction(
  client: QueryRunner,
  recipientId: RecipientId,
): Promise<boolean> {
  const result = await runOn(
    client,
    db
      .selectFrom("recipients")
      .select(sql<number>`1`.as("exists"))
      .where("id", "=", recipientId),
  );
  return result.rows.length > 0;
}

export async function insertSplitInTransaction(
  client: QueryRunner,
  {
    transaction_id,
    recipient_id,
    amount,
    note,
  }: {
    transaction_id: TransactionId;
    recipient_id: RecipientId;
    amount: number;
    note?: string | null | undefined;
  },
): Promise<FormattedSplit> {
  // `0::numeric`: a fresh split has no payments, and NUMERIC keeps
  // `amount_paid` the same pg string type as on every read path.
  const created = await checkedRow(
    transactionSplitRowSchema,
    db
      .with("created", (qb) =>
        qb
          .insertInto("transaction_splits")
          .values({ transaction_id, recipient_id, amount, note: note || null })
          .returningAll(),
      )
      .selectFrom("created")
      .leftJoin("recipients as r", "r.id", "created.recipient_id")
      .selectAll("created")
      .select(["r.name as recipient_name", sql<string>`0::numeric`.as("amount_paid")]),
    client,
  );
  // A plain INSERT ... RETURNING yields exactly one row or throws.
  if (!created) throw new Error("split INSERT returned no row");
  return formatSplit(created);
}

export async function insertSplitsBatchInTransaction(
  client: QueryRunner,
  transactionId: TransactionId,
  splits: Array<{
    recipient_id: RecipientId;
    amount: number;
    note?: string | null | undefined;
  }>,
): Promise<FormattedSplit[]> {
  const recipientIds = splits.map((split) => split.recipient_id);
  const amounts = splits.map((split) => split.amount);
  const notes = splits.map((split) => split.note || null);
  const rows = await checkedRows(
    transactionSplitRowSchema,
    db
      .with("created", (qb) =>
        qb
          .insertInto("transaction_splits")
          .columns(["transaction_id", "recipient_id", "amount", "note"])
          .expression(
            sql`SELECT ${transactionId}, s.recipient_id, s.amount, s.note
                FROM UNNEST(${recipientIds}::int[], ${amounts}::numeric[], ${notes}::text[])
                  AS s(recipient_id, amount, note)`,
          )
          .returningAll(),
      )
      .selectFrom("created")
      .leftJoin("recipients as r", "r.id", "created.recipient_id")
      .selectAll("created")
      .select(["r.name as recipient_name", sql<string>`0::numeric`.as("amount_paid")])
      .orderBy("created.id"),
    client,
  );
  return rows.map(formatSplit);
}

export async function lockSplitForPayment(
  client: QueryRunner,
  splitId: SplitId,
): Promise<{ id: SplitId; amount: string; is_settled: boolean } | null> {
  const row = await checkedRow(
    splitPaymentLockRowSchema,
    db
      .selectFrom("transaction_splits")
      .select(["id", "amount", "is_settled"])
      .where("id", "=", splitId)
      .forUpdate(),
    client,
  );
  return row ?? null;
}

/** @returns NUMERIC sum — a pg string. */
export async function getPaidAmountInTransaction(
  client: QueryRunner,
  splitId: SplitId,
): Promise<string> {
  const row = await checkedRow(splitPaidRowSchema, paidQuery(splitId), client);
  // An aggregate without GROUP BY always returns exactly one row.
  if (!row) throw new Error("split paid sum returned no row");
  return row.paid;
}

export async function insertPaymentInTransaction(
  client: QueryRunner,
  {
    split_id,
    amount,
    note,
    paid_at,
  }: {
    split_id: SplitId;
    amount: number;
    note?: string | null | undefined;
    paid_at: string;
  },
): Promise<FormattedSplitPayment> {
  const payment = await checkedRow(
    splitPaymentRowSchema,
    db
      .insertInto("split_payments")
      .values({ split_id, amount, note: note || null, paid_at })
      .returningAll(),
    client,
  );
  // A plain INSERT ... RETURNING yields exactly one row or throws.
  if (!payment) throw new Error("split payment INSERT returned no row");
  return formatPayment(payment);
}

export async function markSettledIfCovered(
  client: QueryRunner,
  splitId: SplitId,
): Promise<boolean> {
  const result = await runOn(
    client,
    db
      .updateTable("transaction_splits as ts")
      .set({ is_settled: true })
      .where("ts.id", "=", splitId)
      .where("ts.is_settled", "=", false)
      .where(
        sql<boolean>`(
          SELECT COALESCE(SUM(sp.amount), 0)
          FROM split_payments sp
          WHERE sp.split_id = ts.id
        ) >= ts.amount`,
      )
      .returning("id"),
  );
  return (result.rowCount ?? 0) > 0;
}

export const splitRepository = {
  /**
   * Get split allocation totals for a transaction.
   *
   * @returns null when the transaction does not exist
   */
  async getTransactionSplitTotals(
    transactionId: TransactionId,
  ): Promise<SplitTotals | null> {
    const row = await checkedRow(
      splitTotalsRowSchema,
      splitTotalsQuery(transactionId),
    );
    if (!row) return null;
    return mapSplitTotals(row);
  },

  /**
   * Get the splits for a specific transaction. `limit` is optional and defaults
   * to unbounded — the split editor shows every row of the transaction it is
   * editing, so only an explicit limit/offset narrows the result.
   */
  async getSplitsByTransaction(
    transactionId: TransactionId,
    { limit = null, offset = 0 }: PageOptions = {},
  ): Promise<FormattedSplit[]> {
    let builder = db
      .selectFrom("transaction_splits as ts")
      .leftJoin("recipients as r", "ts.recipient_id", "r.id")
      .leftJoin("split_payments as sp", "sp.split_id", "ts.id")
      .selectAll("ts")
      .select([
        "r.name as recipient_name",
        sql<string>`COALESCE(SUM(sp.amount), 0)`.as("amount_paid"),
      ])
      .where("ts.transaction_id", "=", transactionId)
      .groupBy(["ts.id", "r.name"])
      .orderBy("ts.created_at");
    if (limit !== null) builder = builder.limit(limit).offset(offset);
    const rows = await checkedRows(transactionSplitRowSchema, builder);
    return rows.map(formatSplit);
  },

  /**
   * Split count for a transaction — the `total` for a paginated list.
   */
  async countSplitsByTransaction(transactionId: TransactionId): Promise<number> {
    const row = await checkedRow(
      countRowSchema,
      db
        .selectFrom("transaction_splits")
        .select(sql<string>`COUNT(*)`.as("count"))
        .where("transaction_id", "=", transactionId),
    );
    if (!row) throw new Error("split count returned no row");
    return parseInt(row.count, 10);
  },

  /**
   * Get all unsettled splits grouped by recipient (who owes what).
   *
   * Reads from agg_split_outstanding (trigger-maintained by migration
   * 0026) joined to recipients. Projection + filter + sort live in
   * lib/calculations/splits.ts::computeOwedSummary so the shape is
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
   * and transaction currency with outstanding splits, not per split: a split
   * is denominated in its transaction's currency, so the service converts each
   * currency before it adds them up.
   */
  async getOwedSummaryRows(): Promise<
    Array<SplitOutstandingRow & { currency: CurrencyCode | null }>
  > {
    // Collapse alias recipients into their primary so linked recipients show
    // as a single row. recipient_id returned is the primary's id (or self
    // when not aliased) — the detail endpoint expands this back to the full
    // group via getOwedByRecipient.
    const groupId = sql<number>`COALESCE(r.primary_recipient_id, r.id)`;
    const groupName = sql<string>`COALESCE(pr.name, r.name)`;
    return checkedRows(
      splitOutstandingCurrencyRowSchema,
      db
        .selectFrom("agg_split_outstanding as a")
        .innerJoin("recipients as r", "r.id", "a.recipient_id")
        .leftJoin("recipients as pr", "pr.id", "r.primary_recipient_id")
        .innerJoin("transaction_splits as ts", "ts.id", "a.split_id")
        .innerJoin("transactions as t", "t.id", "ts.transaction_id")
        .select([
          groupId.as("recipient_id"),
          groupName.as("recipient_name"),
          "t.currency",
          sql<string>`SUM(a.original_amount)`.as("total_owed"),
          sql<string>`SUM(a.paid_amount)`.as("total_paid"),
          sql<string>`COUNT(a.split_id)`.as("split_count"),
        ])
        .where("ts.is_settled", "=", false)
        .groupBy([groupId, groupName, "t.currency"]),
    );
  },

  /**
   * A recipient group's unsettled remainder per transaction currency (same
   * alias-group + settled filter as getOwedByRecipientRows, never paged), for
   * the server-converted detail total.
   */
  async getOwedRemainingByCurrency(recipientId: RecipientId) {
    return checkedRows(
      owedRemainingCurrencyRowSchema,
      sql`
        ${recipientGroupCte(recipientId)}
        SELECT t.currency,
               SUM(GREATEST(ts.amount - COALESCE(sp_agg.paid, 0), 0)) AS remaining,
               COUNT(ts.id) AS split_count
        FROM transaction_splits ts
        JOIN transactions t ON ts.transaction_id = t.id
        LEFT JOIN ${paidLateral("ts.id")} sp_agg ON true
        WHERE ts.recipient_id IN (SELECT id FROM recipient_group) AND ts.is_settled = false
        GROUP BY t.currency
      `,
    );
  },

  /**
   * Get detailed unsettled splits for a specific recipient. `limit` is optional
   * and defaults to unbounded — the owed-detail drawer lists the recipient's
   * whole outstanding history, so only an explicit limit/offset narrows it.
   * The rows are raw; the split service shapes them into `OwedSplitDetailRow`s.
   */
  async getOwedByRecipientRows(
    recipientId: RecipientId,
    { limit = null, offset = 0 }: PageOptions = {},
  ): Promise<OwedSplitRawRow[]> {
    return checkedRows(
      owedSplitRawRowSchema,
      sql`
      ${recipientGroupCte(recipientId)}
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
      LEFT JOIN ${paidLateral("ts.id")} sp_agg ON true
      WHERE ts.recipient_id IN (SELECT id FROM recipient_group) AND ts.is_settled = false
      ORDER BY t.date DESC
      ${limit === null ? sql`` : sql`LIMIT ${limit} OFFSET ${offset}`}
    `,
    );
  },

  /**
   * Count a recipient's unsettled splits (same alias-group + settled filter as
   * getOwedByRecipient) — the `total` for a paginated list.
   */
  async countOwedByRecipient(recipientId: RecipientId): Promise<number> {
    const row = await checkedRow(
      countRowSchema,
      sql`
        ${recipientGroupCte(recipientId)}
        SELECT COUNT(*)
        FROM transaction_splits ts
        WHERE ts.recipient_id IN (SELECT id FROM recipient_group) AND ts.is_settled = false
      `,
    );
    if (!row) throw new Error("owed split count returned no row");
    return parseInt(row.count, 10);
  },

  /**
   * Export unsettled split transactions for a specific recipient in transaction CSV shape.
   * Amount is replaced by the split remaining amount to settle.
   *
   * `date` and `balance` stay raw (a pg `Date` and a NUMERIC string) — only
   * `amount` is coerced, because only that one is recomputed here.
   */
  async getOwedExportRowsByRecipient(
    recipientId: RecipientId,
  ): Promise<OwedExportRow[]> {
    const rows = await checkedRows(
      owedExportRawRowSchema,
      sql`
      ${recipientGroupCte(recipientId)}
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
          WHEN c.id IS NOT NULL THEN c.path_name
          WHEN rc.id IS NOT NULL THEN rc.path_name
          WHEN pc.id IS NOT NULL THEN pc.path_name
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
      LEFT JOIN ${paidLateral("ts.id")} sp_agg ON true
      WHERE ts.recipient_id IN (SELECT id FROM recipient_group)
        AND ts.is_settled = false
        AND (ts.amount - COALESCE(sp_agg.paid, 0)) > 0
      ORDER BY t.date ASC
    `,
    );
    return rows.map((row) => ({
      ...row,
      amount: toNumber(toDecimal(row.amount)),
    }));
  },

  /**
   * Get payments for a split. `limit` is optional and defaults to unbounded —
   * the payment history panel lists them all, so only an explicit limit/offset
   * narrows the result.
   */
  async getPayments(
    splitId: SplitId,
    { limit = null, offset = 0 }: PageOptions = {},
  ): Promise<FormattedSplitPayment[]> {
    let builder = db
      .selectFrom("split_payments")
      .selectAll()
      .where("split_id", "=", splitId)
      .orderBy("paid_at", "desc");
    if (limit !== null) builder = builder.limit(limit).offset(offset);
    const rows = await checkedRows(splitPaymentRowSchema, builder);
    return rows.map(formatPayment);
  },

  /**
   * Payment count for a split — the `total` for a paginated list.
   */
  async countPayments(splitId: SplitId): Promise<number> {
    const row = await checkedRow(
      countRowSchema,
      db
        .selectFrom("split_payments")
        .select(sql<string>`COUNT(*)`.as("count"))
        .where("split_id", "=", splitId),
    );
    if (!row) throw new Error("split payment count returned no row");
    return parseInt(row.count, 10);
  },

  /**
   * Settle a split manually (mark as fully paid regardless of payments).
   *
   * Same re-select idiom as the service create path: a bare `RETURNING *` row has no
   * `recipient_name`/`amount_paid` columns, so the settle response used to
   * fabricate `recipient_name: null` and `amount_paid: 0` (`toDecimal(undefined)`
   * → 0) even on a fully-paid split. The CTE re-selects the updated row joined
   * to recipients plus the per-split payment aggregate so the emitted
   * `FormattedSplit` carries the real values.
   */
  async settleSplit(
    splitId: SplitId,
    client: QueryRunner | null = null,
  ): Promise<FormattedSplit | null> {
    const row = await checkedRow(
      transactionSplitRowSchema,
      sql`
        WITH settled AS (
          UPDATE transaction_splits SET is_settled = true WHERE id = ${splitId} RETURNING *
        )
        SELECT settled.*, r.name AS recipient_name,
               COALESCE(sp_agg.paid, 0) AS amount_paid
        FROM settled
        LEFT JOIN recipients r ON r.id = settled.recipient_id
        LEFT JOIN ${paidLateral("settled.id")} sp_agg ON true
      `,
      client ?? undefined,
    );
    return row ? formatSplit(row) : null;
  },

  async settleAllByRecipient(
    recipientId: RecipientId,
    client: QueryRunner | null = null,
  ): Promise<{ settled_count: number }> {
    const result = await runOn(
      client,
      sql`
        ${recipientGroupCte(recipientId)}
        UPDATE transaction_splits
        SET is_settled = true
        WHERE recipient_id IN (SELECT id FROM recipient_group) AND is_settled = false
      `,
    );
    return { settled_count: result.rowCount ?? 0 };
  },

  /**
   * Delete a split.
   */
  async deleteSplit(
    splitId: SplitId,
    client: QueryRunner | null = null,
  ): Promise<boolean> {
    const result = await runOn(
      client,
      db.deleteFrom("transaction_splits").where("id", "=", splitId),
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Fetch a single split row for reads and service orchestration.
   *
   * Joined to recipients and the per-split payment aggregate (same shape as
   * getSplitsByTransaction) so the row carries the real `recipient_name` /
   * `amount_paid` instead of the fabricated null/0 a bare `SELECT *` produced.
   */
  async getSplitById(
    splitId: SplitId,
    client: QueryRunner | null = null,
  ): Promise<FormattedSplit | null> {
    const row = await checkedRow(
      transactionSplitRowSchema,
      sql`
        SELECT ts.*, r.name AS recipient_name,
               COALESCE(sp_agg.paid, 0) AS amount_paid
        FROM transaction_splits ts
        LEFT JOIN recipients r ON ts.recipient_id = r.id
        LEFT JOIN ${paidLateral("ts.id")} sp_agg ON true
        WHERE ts.id = ${splitId}
      `,
      client ?? undefined,
    );
    return row ? formatSplit(row) : null;
  },

  /**
   * Sum existing payments against a split. The authoritative service guard
   * uses a row lock plus storage-precision validation. Migration 0088
   * removes the legacy-only DB trigger so upgraded and fresh databases share
   * the same canonical enforcement path.
   */
  async getAlreadyPaid(splitId: SplitId): Promise<number> {
    const row = await checkedRow(splitPaidRowSchema, paidQuery(splitId));
    // An aggregate without GROUP BY always returns exactly one row.
    if (!row) throw new Error("split paid sum returned no row");
    return toNumber(toDecimal(row.paid));
  },

  /**
   * Repoint splits off merged alias recipients onto the primary (ADR-014).
   *
   * @returns rows repointed
   */
  async repointRecipient(
    primaryId: RecipientId,
    aliasIds: RecipientId[],
  ): Promise<number> {
    const result = await db
      .updateTable("transaction_splits")
      .set({ recipient_id: primaryId })
      .where(sql<boolean>`recipient_id = ANY(${aliasIds}::int[])`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  },
};

/**
 * Wire shape for a split_payments row: NUMERIC `amount` coerced to a number,
 * DATE `paid_at` rendered as a calendar-day string. Shared by every endpoint
 * that emits a payment so POST /pay and GET /payments cannot drift apart.
 *
 * @param row raw `split_payments` row
 */
function formatPayment(row: SplitPaymentRow): FormattedSplitPayment {
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
 */
export function formatSplit(row: TransactionSplitRow): FormattedSplit {
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
