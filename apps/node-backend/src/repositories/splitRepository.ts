/**
 * Split Repository - data access for transaction_splits and split_payments tables.
 *
 * Owed-summary reads from agg_split_outstanding (trigger-maintained by
 * migration 0026) instead of a live aggregate join. Audit events are
 * written via writeAudit; route/service layer owns when to emit them.
 */

import { query } from "../database/connection.ts";
import { buildLimitOffset } from "../lib/sqlClauses.ts";
import { toWireDate } from "../lib/dateFormat.ts";
import { toDecimal, toNumber } from "../lib/money.ts";
import type { SplitOutstandingRow } from "../lib/calculations/splits.ts";
import type {
  FormattedSplit,
  FormattedSplitPayment,
  OwedSplitDetailRow,
  QueryRunner,
  SplitPaymentRow,
  SplitTotals,
  TransactionSplitRow,
} from "../types/rows.ts";

export type {
  QueryRunner,
  FormattedSplit,
  FormattedSplitPayment,
  OwedSplitDetailRow,
  SplitTotals,
};

/**
 * A raw `getOwedByRecipientRows` row: the split columns plus its parent
 * transaction's, before the service formats it into an `OwedSplitDetailRow`.
 */
export type OwedSplitRawRow = TransactionSplitRow & {
  transaction_date: Date;
  transaction_memo: string | null;
  /** NUMERIC — pg string. */
  transaction_amount: string;
  transaction_currency: string | null;
  bank_account: string | null;
  transaction_recipient_name: string | null;
  /** NUMERIC — pg string. */
  amount_paid: string;
};

/** One `getOwedExportRowsByRecipient` row (transaction CSV shape). */
export interface OwedExportRow {
  date: Date;
  bank_account: string | null;
  recipient_name: string | null;
  memo: string | null;
  amount: number;
  currency: string | null;
  balance: string | null;
  category_name: string;
  comment: string | null;
}

/** Raw SPLIT_TOTALS_SQL row: both aggregates are pg NUMERIC strings. */
interface SplitTotalsRow {
  transaction_total: string;
  current_split_total: string;
}

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
interface PageOptions {
  limit?: number | null;
  offset?: number;
}

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
  transactionId: number,
): Promise<SplitTotals | null> {
  const lockResult = await client.query(
    `SELECT id FROM transactions WHERE id = $1 FOR UPDATE`,
    [transactionId],
  );
  if (lockResult.rows.length === 0) return null;
  const totalsResult = await client.query(SPLIT_TOTALS_SQL, [transactionId]);
  return mapSplitTotals(totalsResult.rows[0]);
}

/**
 * Existence check for the recipient a bulk split writes to, inside the
 * caller's transaction. The FK would reject an unknown id on INSERT, but as a
 * raw 23503 after some rows were already written; checking up front turns it
 * into a 404 before any write.
 */
export async function recipientExistsInTransaction(
  client: QueryRunner,
  recipientId: number,
): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM recipients WHERE id = $1",
    [recipientId],
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
    transaction_id: number;
    recipient_id: number;
    amount: number;
    note?: string | null;
  },
): Promise<FormattedSplit> {
  const result = await client.query(
    `WITH created AS (
       INSERT INTO transaction_splits (transaction_id, recipient_id, amount, note)
       VALUES ($1, $2, $3, $4) RETURNING *
     )
     SELECT created.*, r.name AS recipient_name, 0 AS amount_paid
     FROM created
     LEFT JOIN recipients r ON r.id = created.recipient_id`,
    [transaction_id, recipient_id, amount, note || null],
  );
  return formatSplit(result.rows[0]);
}

export async function insertSplitsBatchInTransaction(
  client: QueryRunner,
  transactionId: number,
  splits: Array<{ recipient_id: number; amount: number; note?: string | null }>,
): Promise<FormattedSplit[]> {
  const recipientIds = splits.map((split) => split.recipient_id);
  const amounts = splits.map((split) => split.amount);
  const notes = splits.map((split) => split.note || null);
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
    [transactionId, recipientIds, amounts, notes],
  );
  return result.rows.map(formatSplit);
}

export async function lockSplitForPayment(
  client: QueryRunner,
  splitId: number,
): Promise<{ id: number; amount: string; is_settled: boolean } | null> {
  const result = await client.query(
    "SELECT id, amount, is_settled FROM transaction_splits WHERE id = $1 FOR UPDATE",
    [splitId],
  );
  return result.rows[0] || null;
}

/** @returns NUMERIC sum — a pg string. */
export async function getPaidAmountInTransaction(
  client: QueryRunner,
  splitId: number,
): Promise<string> {
  const result = await client.query(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM split_payments WHERE split_id = $1",
    [splitId],
  );
  return result.rows[0].paid;
}

export async function insertPaymentInTransaction(
  client: QueryRunner,
  {
    split_id,
    amount,
    note,
    paid_at,
  }: {
    split_id: number;
    amount: number;
    note?: string | null;
    paid_at: string;
  },
): Promise<FormattedSplitPayment> {
  const result = await client.query(
    `INSERT INTO split_payments (split_id, amount, note, paid_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [split_id, amount, note || null, paid_at],
  );
  return formatPayment(result.rows[0]);
}

export async function markSettledIfCovered(
  client: QueryRunner,
  splitId: number,
): Promise<boolean> {
  const result = await client.query(
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
    [splitId],
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
    transactionId: number,
  ): Promise<SplitTotals | null> {
    const result = await query<SplitTotalsRow>(SPLIT_TOTALS_SQL, [
      transactionId,
    ]);
    if (result.rows.length === 0) return null;
    return mapSplitTotals(result.rows[0]);
  },

  /**
   * Get the splits for a specific transaction. `limit` is optional and defaults
   * to unbounded — the split editor shows every row of the transaction it is
   * editing, so only an explicit limit/offset narrows the result.
   */
  async getSplitsByTransaction(
    transactionId: number,
    { limit = null, offset = 0 }: PageOptions = {},
  ): Promise<FormattedSplit[]> {
    const params: unknown[] = [transactionId];
    const sql =
      `
      SELECT ts.*, r.name AS recipient_name,
             COALESCE(SUM(sp.amount), 0) AS amount_paid
      FROM transaction_splits ts
      LEFT JOIN recipients r ON ts.recipient_id = r.id
      LEFT JOIN split_payments sp ON sp.split_id = ts.id
      WHERE ts.transaction_id = $1
      GROUP BY ts.id, r.name
      ORDER BY ts.created_at
    ` + buildLimitOffset(params, { limit, offset });
    const result = await query<TransactionSplitRow>(sql, params);
    return result.rows.map(formatSplit);
  },

  /**
   * Split count for a transaction — the `total` for a paginated list.
   */
  async countSplitsByTransaction(transactionId: number): Promise<number> {
    const result = await query<{ count: string }>(
      "SELECT COUNT(*) FROM transaction_splits WHERE transaction_id = $1",
      [transactionId],
    );
    return parseInt(result.rows[0].count, 10);
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
   * with outstanding splits, not per split.
   */
  async getOwedSummaryRows(): Promise<SplitOutstandingRow[]> {
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
    const result = await query<SplitOutstandingRow>(sql, []);
    return result.rows;
  },

  /**
   * Get detailed unsettled splits for a specific recipient. `limit` is optional
   * and defaults to unbounded — the owed-detail drawer lists the recipient's
   * whole outstanding history, so only an explicit limit/offset narrows it.
   * The rows are raw; the split service shapes them into `OwedSplitDetailRow`s.
   */
  async getOwedByRecipientRows(
    recipientId: number,
    { limit = null, offset = 0 }: PageOptions = {},
  ): Promise<OwedSplitRawRow[]> {
    const params: unknown[] = [recipientId];
    const sql =
      `
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
    const result = await query<OwedSplitRawRow>(sql, params);
    return result.rows;
  },

  /**
   * Count a recipient's unsettled splits (same alias-group + settled filter as
   * getOwedByRecipient) — the `total` for a paginated list.
   */
  async countOwedByRecipient(recipientId: number): Promise<number> {
    const sql = `
      ${RECIPIENT_GROUP_CTE}
      SELECT COUNT(*)
      FROM transaction_splits ts
      WHERE ts.recipient_id IN (SELECT id FROM recipient_group) AND ts.is_settled = false
    `;
    const result = await query<{ count: string }>(sql, [recipientId]);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * Export unsettled split transactions for a specific recipient in transaction CSV shape.
   * Amount is replaced by the split remaining amount to settle.
   *
   * `date` and `balance` stay raw (a pg `Date` and a NUMERIC string) — only
   * `amount` is coerced, because only that one is recomputed here.
   */
  async getOwedExportRowsByRecipient(
    recipientId: number,
  ): Promise<OwedExportRow[]> {
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

    const result = await query<
      Omit<OwedExportRow, "amount"> & { amount: string }
    >(sql, [recipientId]);
    return result.rows.map((row) => ({
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
    splitId: number,
    { limit = null, offset = 0 }: PageOptions = {},
  ): Promise<FormattedSplitPayment[]> {
    const params: unknown[] = [splitId];
    const sql =
      `SELECT * FROM split_payments WHERE split_id = $1 ORDER BY paid_at DESC` +
      buildLimitOffset(params, { limit, offset });
    const result = await query<SplitPaymentRow>(sql, params);
    return result.rows.map(formatPayment);
  },

  /**
   * Payment count for a split — the `total` for a paginated list.
   */
  async countPayments(splitId: number): Promise<number> {
    const result = await query<{ count: string }>(
      "SELECT COUNT(*) FROM split_payments WHERE split_id = $1",
      [splitId],
    );
    return parseInt(result.rows[0].count, 10);
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
    splitId: number,
    client: QueryRunner | null = null,
  ): Promise<FormattedSplit | null> {
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
    const runner: QueryRunner = client || { query };
    const result = await runner.query(sql, [splitId]);
    return result.rows[0] ? formatSplit(result.rows[0]) : null;
  },

  async settleAllByRecipient(
    recipientId: number,
    client: QueryRunner | null = null,
  ): Promise<{ settled_count: number }> {
    const sql = `
      ${RECIPIENT_GROUP_CTE}
      UPDATE transaction_splits
      SET is_settled = true
      WHERE recipient_id IN (SELECT id FROM recipient_group) AND is_settled = false
    `;
    const runner: QueryRunner = client || { query };
    const result = await runner.query(sql, [recipientId]);
    return { settled_count: result.rowCount || 0 };
  },

  /**
   * Delete a split.
   */
  async deleteSplit(
    splitId: number,
    client: QueryRunner | null = null,
  ): Promise<boolean> {
    const runner: QueryRunner = client || { query };
    const result = await runner.query(
      "DELETE FROM transaction_splits WHERE id = $1",
      [splitId],
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
    splitId: number,
    client: QueryRunner | null = null,
  ): Promise<FormattedSplit | null> {
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
    const runner: QueryRunner = client || { query };
    const result = await runner.query(sql, [splitId]);
    return result.rows[0] ? formatSplit(result.rows[0]) : null;
  },

  /**
   * Sum existing payments against a split. The authoritative service guard
   * uses a row lock plus storage-precision validation. Migration 0088
   * removes the legacy-only DB trigger so upgraded and fresh databases share
   * the same canonical enforcement path.
   */
  async getAlreadyPaid(splitId: number): Promise<number> {
    const sql = `
      SELECT COALESCE(SUM(amount), 0) AS paid
      FROM split_payments
      WHERE split_id = $1
    `;
    const result = await query<{ paid: string }>(sql, [splitId]);
    return toNumber(toDecimal(result.rows[0].paid));
  },

  /**
   * Append a split_audit row. Accepts an optional pg client so the caller
   * can write the audit inside the same transaction as the mutation.
   *
   * @returns `split_audit.id` is BIGSERIAL — a string
   */
  async writeAudit({
    split_id,
    action,
    actor = null,
    payload = null,
    client = null,
  }: {
    split_id: number | null;
    action: string;
    actor?: string | null;
    payload?: object | null;
    client?: QueryRunner | null;
  }): Promise<{
    id: string;
    payload_text: string | null;
    occurred_at: string;
  }> {
    const sql = `
      INSERT INTO split_audit (split_id, action, actor, payload)
      VALUES ($1, $2, $3, $4)
      RETURNING id, payload::text AS payload_text,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
    `;
    const params = [
      split_id,
      action,
      actor,
      payload ? JSON.stringify(payload) : null,
    ];
    const runner: QueryRunner = client || { query };
    const result = await runner.query(sql, params);
    return result.rows[0];
  },

  /**
   * Repoint splits off merged alias recipients onto the primary (ADR-014).
   *
   * @returns rows repointed
   */
  async repointRecipient(
    primaryId: number,
    aliasIds: number[],
  ): Promise<number> {
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
