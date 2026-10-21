/**
 * portfolioImportBatchRepository — data access for portfolio_import_batches and
 * portfolio_import_staging_rows. Mirrors importBatchRepository (the transaction
 * side): all SQL for the portfolio import review/history flow lives here so the
 * service layer stays free of raw queries. All access goes through the shared
 * query helper — no raw pool references.
 */

import { sql } from "kysely";
import { asAccountId } from "@vision/types/brands";
import type { AccountId } from "@vision/types/brands";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  committedStagingRowSchema,
  intTotalRowSchema,
  investmentCreationRowSchema,
  investmentResolutionRowSchema,
  overrideInvestmentsSummaryRowSchema,
  portfolioImportBatchLockRowSchema,
  portfolioImportBatchSummaryRowSchema,
  portfolioImportPreviewRowSchema,
  stagingOldStatusRowSchema,
  stagingRowIndexRowSchema,
} from "../database/rows/portfolioImport.ts";
import type {
  CommittedStagingRow,
  InvestmentCreationRow,
  InvestmentResolutionRow,
  PortfolioImportBatchLockRow,
  PortfolioImportBatchSummaryRow,
  PortfolioImportPreviewRow,
} from "../database/rows/portfolioImport.ts";

export type {
  InvestmentResolutionRow,
  PortfolioImportBatchLockRow,
  PortfolioImportBatchSummaryRow,
  PortfolioImportPreviewRow,
};

type Id = number | string;

const BATCH_COLUMNS = [
  "id",
  "adapter_name",
  "source_filename",
  "source_size_bytes",
  "default_asset_class",
  "default_type",
  "status",
  "account_id",
  "rows_total",
  "rows_imported",
  "rows_duplicate",
  "rows_error",
  "error_summary",
  "started_at",
  "completed_at",
] as const;

/**
 * Keep reviewable and retryable import batches routed to the surviving account
 * when their selected broker account is merged away. This must run before the
 * source account rows are deleted; otherwise the FK's ON DELETE SET NULL action
 * irreversibly loses the reviewed destination.
 */
export async function repointAccount(
  targetId: number,
  sourceIds: number[],
): Promise<number> {
  const result = await db
    .updateTable("portfolio_import_batches")
    .set({ account_id: asAccountId(targetId) })
    .where("account_id", "=", sql<AccountId>`ANY(${sourceIds}::int[])`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** Lock routed batches before account rows so merge follows the same batch ->
 * account lock order as portfolio-import commit. This prevents the two
 * operations from deadlocking while preserving the reviewed destination.
 */
export async function lockForAccountMerge(sourceIds: number[]): Promise<void> {
  await db
    .selectFrom("portfolio_import_batches")
    .select("id")
    .where("account_id", "=", sql<AccountId>`ANY(${sourceIds}::int[])`)
    .orderBy("id")
    .forUpdate()
    .execute();
}

/**
 * Set the batch-level brokerage account (ADR-095). Lots committed from this batch
 * inherit it as their account_id (ADR-091). Pass null to clear. A present
 * account also repairs cash rows whose exact commit error says the batch
 * account was missing, so review can recommit them; unrelated errors remain.
 */
export async function setBatchAccount(
  batchId: Id,
  accountId: number | null | undefined,
): Promise<void> {
  const account = accountId ?? null;
  await sql`
    WITH repaired AS (
       UPDATE portfolio_import_staging_rows
          SET status = 'matched', error_message = NULL
        WHERE batch_id = ${batchId}
          AND ${account}::integer IS NOT NULL
          AND route = 'cash'
          AND status = 'error'
          AND error_message = 'brokerage cash row requires a batch account'
       RETURNING id
     )
     UPDATE portfolio_import_batches
        SET account_id = ${account},
            rows_error = GREATEST(
              COALESCE(rows_error, 0) - (SELECT COUNT(*) FROM repaired),
              0
            )
      WHERE id = ${batchId}`.execute(db);
}

export async function listBatches({
  limit = 50,
  offset = 0,
}: { limit?: number; offset?: number } = {}): Promise<{
  batches: PortfolioImportBatchSummaryRow[];
  total: number;
}> {
  const rows = await checkedRows(
    portfolioImportBatchSummaryRowSchema,
    db
      .selectFrom("portfolio_import_batches")
      .select(BATCH_COLUMNS)
      .orderBy("started_at", "desc")
      .limit(limit)
      .offset(offset),
  );
  const countRow = await checkedRow(
    intTotalRowSchema,
    db
      .selectFrom("portfolio_import_batches")
      .select(sql<number>`COUNT(*)::int`.as("total")),
  );
  return { batches: rows, total: countRow?.total ?? 0 };
}

export async function getBatch(
  id: Id,
): Promise<PortfolioImportBatchSummaryRow | undefined> {
  return checkedRow(
    portfolioImportBatchSummaryRowSchema,
    db
      .selectFrom("portfolio_import_batches")
      .select(BATCH_COLUMNS)
      .where("id", "=", String(id)),
  );
}

/**
 * Lock one batch for a lifecycle-sensitive transaction.
 */
export async function lockBatchForUpdate(
  batchId: Id,
): Promise<PortfolioImportBatchLockRow | undefined> {
  return checkedRow(
    portfolioImportBatchLockRowSchema,
    db
      .selectFrom("portfolio_import_batches")
      .select([
        "status",
        "is_brokerage",
        "adapter_name",
        "custom_config",
        "account_id",
      ])
      .where("id", "=", String(batchId))
      .forUpdate(),
  );
}

/**
 * Readiness is checked after review account repair, before any canonical write.
 * Returned ordinals deliberately omit source values and investment identities.
 */
export async function getImportReadinessProblems(
  batchId: Id,
  accountId: number | null | undefined,
): Promise<Array<{ row_index: number }>> {
  const account = accountId ?? null;
  return checkedRows(
    stagingRowIndexRowSchema,
    sql`SELECT row_index
       FROM portfolio_import_staging_rows
      WHERE batch_id = ${batchId}
        AND (
          status NOT IN ('matched', 'committed', 'duplicate')
          OR (status = 'matched' AND (
            tx_date IS NULL
            OR (route = 'cash' AND (${account}::integer IS NULL OR amount IS NULL))
            OR (route IS DISTINCT FROM 'cash' AND route IS DISTINCT FROM 'account_internal' AND (
              (type IS NULL AND route IS DISTINCT FROM 'asset_transfer' AND route IS DISTINCT FROM 'asset_adjustment')
              OR COALESCE(user_override_investment_id, resolved_investment_id) IS NULL
            ))
          ))
        )
      ORDER BY row_index`,
  );
}

/**
 * Manual writes do not share an investment advisory lock. Use the existing
 * broker-retag table-lock convention so the overlap read is stable until the
 * enclosing reviewed import transaction finishes. Account rows come first,
 * matching account lifecycle and broker-retag lock order.
 */
export async function lockImportReadinessHistory(
  accountId: number | null | undefined,
): Promise<void> {
  if (accountId != null) {
    await db
      .selectFrom("accounts")
      .select("id")
      .where("id", "=", asAccountId(accountId))
      .forUpdate()
      .execute();
  }
  await sql`LOCK TABLE portfolio_transactions IN SHARE ROW EXCLUSIVE MODE`.execute(
    db,
  );
}

/**
 * Find possible historical overlaps, including unassigned rows and manual rows
 * already on the chosen broker. Fees, principal, tax, and FX differences do not
 * prove that two records are distinct events. This blocks for reconciliation;
 * it never adopts, rewrites, or stamps the existing record.
 *
 * An exact canonical source fingerprint at the requested investment/account is
 * a known no-op and may pass even when nearby manual history also exists.
 */
export async function getManualPortfolioOverlaps(
  batchId: Id,
  accountId: number | null | undefined,
): Promise<Array<{ row_index: number }>> {
  const account = accountId ?? null;
  return checkedRows(
    stagingRowIndexRowSchema,
    sql`SELECT DISTINCT isr.row_index
       FROM portfolio_import_staging_rows isr
       JOIN portfolio_transactions pt
         ON pt.investment_id = COALESCE(
              isr.user_override_investment_id, isr.resolved_investment_id)
        AND pt.type = isr.type
        AND ABS(pt.date - isr.tx_date) <= 7
      WHERE isr.batch_id = ${batchId}
        AND isr.status = 'matched'
        AND isr.route IS DISTINCT FROM 'cash'
        AND pt.dedup_fingerprint IS NULL
        AND (
          (isr.type IN ('buy', 'sell', 'gift', 'split')
            AND isr.units IS NOT NULL AND pt.units IS NOT NULL
            AND ABS(pt.units - isr.units) <= GREATEST(
              0.00000001::numeric,
              ABS(isr.units) * 0.00000001::numeric))
          OR isr.type NOT IN ('buy', 'sell', 'gift', 'split')
        )
        AND NOT EXISTS (
          SELECT 1 FROM portfolio_transactions canonical
           WHERE NULLIF(isr.dedup_fingerprint, '') IS NOT NULL
             AND canonical.dedup_fingerprint = isr.dedup_fingerprint
             AND canonical.dedup_fingerprint_version = isr.dedup_fingerprint_version
             AND canonical.investment_id = COALESCE(
                  isr.user_override_investment_id, isr.resolved_investment_id)
             AND canonical.account_id IS NOT DISTINCT FROM ${account}::integer
             AND canonical.type = isr.type
        )
      ORDER BY isr.row_index`,
  );
}

/**
 * Staging rows for the review preview, joined to their effective investment.
 * Caller groups by effective investment.
 */
export async function getPreviewRows(
  batchId: Id,
): Promise<PortfolioImportPreviewRow[]> {
  const effectiveInvestmentId = sql<number | null>`COALESCE(isr.user_override_investment_id, isr.resolved_investment_id)`;
  return checkedRows(
    portfolioImportPreviewRowSchema,
    db
      .selectFrom("portfolio_import_staging_rows as isr")
      .leftJoin("investments as inv", (join) =>
        join.on(sql<boolean>`inv.id = ${effectiveInvestmentId}`),
      )
      .select([
        "isr.id",
        "isr.row_index",
        "isr.status",
        "isr.route",
        sql<string | null>`to_char(isr.tx_date, 'YYYY-MM-DD')`.as("tx_date"),
        "isr.type",
        "isr.type_raw",
        "isr.symbol_raw",
        "isr.name_raw",
        "isr.units",
        "isr.price_per_unit",
        "isr.amount",
        "isr.fees",
        "isr.taxes",
        "isr.currency",
        "isr.fx_rate_to_eur",
        "isr.note",
        "isr.match_source",
        "isr.error_message",
        "isr.resolved_investment_id",
        "isr.user_override_investment_id",
        effectiveInvestmentId.as("effective_investment_id"),
        "inv.name as investment_name",
        "inv.symbol as investment_symbol",
        "inv.asset_class as investment_asset_class",
      ])
      .where("isr.batch_id", "=", String(batchId))
      .orderBy("isr.row_index", "asc"),
  );
}

/**
 * Set (or clear) user_override_investment_id on a single reviewable staging row.
 *
 * Also the repair path for a commit-phase error: pointing an `error` row (e.g.
 * "unresolved instrument") at a real holding resets it to `matched` and clears
 * its error_message so a re-commit re-drains it, and decrements the batch's
 * rows_error so the counters stay honest (that row will be re-counted as
 * imported/duplicate/error on the next commit). Clearing the override (null)
 * leaves an error row in `error` — there's nothing to re-commit.
 *
 * @returns rowCount (0 if row not found / not in a reviewable status)
 */
export async function overrideInvestment({
  batchId,
  rowId,
  investmentId,
}: {
  batchId: Id;
  rowId: Id;
  investmentId: number | null;
}): Promise<number | null> {
  // The CTE captures the row's status BEFORE the update (locked FOR UPDATE) so
  // the caller can tell an error→matched reset from a plain re-point of an
  // already-matched row — RETURNING alone only sees the post-update state, which
  // is indistinguishable between the two.
  const updatedRows = await checkedRows(
    stagingOldStatusRowSchema,
    sql`WITH prev AS (
        SELECT id, status AS old_status
          FROM portfolio_import_staging_rows
         WHERE batch_id = ${batchId} AND id = ${rowId}
           AND (status = 'matched'
             OR (status = 'error'
               AND error_message = 'unresolved instrument — pick or create a holding'))
           AND route IS DISTINCT FROM 'cash'
         FOR UPDATE
     ),
     upd AS (
        UPDATE portfolio_import_staging_rows r
           SET user_override_investment_id = ${investmentId},
               status = CASE
                 WHEN prev.old_status = 'error' AND ${investmentId}::integer IS NOT NULL THEN 'matched'
                 ELSE r.status
               END,
               error_message = CASE
                 WHEN prev.old_status = 'error' AND ${investmentId}::integer IS NOT NULL THEN NULL
                 ELSE r.error_message
               END
          FROM prev
         WHERE r.id = prev.id
        RETURNING prev.old_status
     )
     SELECT old_status FROM upd`,
  );
  const [updated] = updatedRows;

  // If we flipped an error row back to matched, the batch's cumulative
  // rows_error over-counts it — decrement so total counts don't exceed rows_total.
  if (investmentId != null && updated?.old_status === "error") {
    await db
      .updateTable("portfolio_import_batches")
      .set({ rows_error: sql<number>`GREATEST(COALESCE(rows_error, 0) - 1, 0)` })
      .where("id", "=", String(batchId))
      .execute();
  }

  return updatedRows.length;
}

/**
 * Serialize a review resolution against its batch and lock the complete row set.
 * The batch lock comes first so concurrent "create new" requests for the same
 * batch cannot both create a holding before either request sees the other's
 * overrides.
 */
export async function lockInvestmentResolutionRows({
  batchId,
  rowIds,
}: {
  batchId: Id;
  rowIds: Id[];
}): Promise<{
  batchStatus: string | undefined;
  rows: InvestmentResolutionRow[];
}> {
  const batch = await lockBatchForUpdate(batchId);
  if (!batch) {
    return { batchStatus: undefined, rows: [] };
  }

  const rows = await checkedRows(
    investmentResolutionRowSchema,
    db
      .selectFrom("portfolio_import_staging_rows")
      .select([
        "id",
        "status",
        "route",
        "error_message",
        "user_override_investment_id",
      ])
      .where("batch_id", "=", String(batchId))
      .where("id", "=", sql<string>`ANY(${rowIds}::bigint[])`)
      .orderBy("id")
      .forUpdate(),
  );

  return { batchStatus: batch.status, rows };
}

/**
 * Point a complete requested set of review rows at one investment.
 *
 * The requested/eligible count guard is inside the same statement as the
 * update. If even one id is missing, belongs to another batch, or is no longer
 * reviewable, the UPDATE sees a false guard and changes zero rows. The service
 * wraps this statement (and optional holding creation) in one transaction.
 */
export async function overrideInvestments({
  batchId,
  rowIds,
  investmentId,
}: {
  batchId: Id;
  rowIds: Id[];
  investmentId: number;
}): Promise<{
  requestedCount: number;
  eligibleCount: number;
  updatedCount: number;
  resetErrorCount: number;
}> {
  const rows = await checkedRows(
    overrideInvestmentsSummaryRowSchema,
    sql`WITH requested AS (
        SELECT DISTINCT unnest(${rowIds}::bigint[]) AS id
     ),
     locked AS (
        SELECT r.id, r.status AS old_status, r.route, r.error_message
          FROM portfolio_import_staging_rows r
          JOIN requested req ON req.id = r.id
         WHERE r.batch_id = ${batchId}
         ORDER BY r.id
         FOR UPDATE OF r
     ),
     eligible AS (
        SELECT id, old_status
          FROM locked
         WHERE (old_status = 'matched'
             OR (old_status = 'error'
               AND error_message = 'unresolved instrument — pick or create a holding'))
           AND route IS DISTINCT FROM 'cash'
     ),
     counts AS (
        SELECT (SELECT COUNT(*)::int FROM requested) AS requested_count,
               (SELECT COUNT(*)::int FROM eligible) AS eligible_count
     ),
     upd AS (
        UPDATE portfolio_import_staging_rows r
           SET user_override_investment_id = ${investmentId},
               status = CASE WHEN eligible.old_status = 'error' THEN 'matched' ELSE r.status END,
               error_message = CASE WHEN eligible.old_status = 'error' THEN NULL ELSE r.error_message END
          FROM eligible, counts
         WHERE r.id = eligible.id
           AND counts.requested_count = counts.eligible_count
        RETURNING eligible.old_status
     )
     SELECT counts.requested_count,
            counts.eligible_count,
            COUNT(upd.old_status)::int AS updated_count,
            COUNT(upd.old_status) FILTER (WHERE upd.old_status = 'error')::int AS reset_error_count
       FROM counts
       LEFT JOIN upd ON TRUE
      GROUP BY counts.requested_count, counts.eligible_count`,
  );

  const summary = rows[0] ?? {
    requested_count: rowIds.length,
    eligible_count: 0,
    updated_count: 0,
    reset_error_count: 0,
  };

  if (summary.reset_error_count > 0) {
    await db
      .updateTable("portfolio_import_batches")
      .set({
        rows_error: sql<number>`GREATEST(COALESCE(rows_error, 0) - ${summary.reset_error_count}, 0)`,
      })
      .where("id", "=", String(batchId))
      .execute();
  }

  return {
    requestedCount: summary.requested_count,
    eligibleCount: summary.eligible_count,
    updatedCount: summary.updated_count,
    resetErrorCount: summary.reset_error_count,
  };
}

/**
 * Fetch a staging row plus its batch's default asset class — the source fields
 * for creating a new holding from the review "create new" action.
 */
export async function getRowForInvestmentCreation({
  batchId,
  rowId,
}: {
  batchId: Id;
  rowId: Id;
}): Promise<InvestmentCreationRow | undefined> {
  return checkedRow(
    investmentCreationRowSchema,
    db
      .selectFrom("portfolio_import_staging_rows as isr")
      .innerJoin("portfolio_import_batches as b", "b.id", "isr.batch_id")
      .select([
        "isr.symbol_raw",
        "isr.name_raw",
        "isr.currency",
        "b.default_asset_class",
        "b.custom_config",
      ])
      .where("isr.batch_id", "=", String(batchId))
      .where("isr.id", "=", String(rowId)),
  );
}

/**
 * Committed (id, route) pairs produced by a batch (for rollback).
 *
 * The route MUST travel with the id: a route='cash' row stores a
 * `transactions.id` in committed_txn_id while every other row stores a
 * portfolio-transaction id, and the two sequences are independent — feeding a
 * cash id to the portfolio hard-delete removed an UNRELATED trade that
 * happened to share the number.
 */
export async function getCommittedRows(
  batchId: Id,
): Promise<CommittedStagingRow[]> {
  return checkedRows(
    committedStagingRowSchema,
    db
      .selectFrom("portfolio_import_staging_rows as isr")
      .leftJoin("portfolio_transactions as pt", "pt.id", "isr.committed_txn_id")
      .select(["isr.committed_txn_id as id", "isr.route", "pt.investment_id"])
      .where("isr.batch_id", "=", String(batchId))
      .where("isr.committed_txn_id", "is not", null),
  );
}

/**
 * Reset a rolled-back batch's staging rows from 'committed' back to 'matched'
 * and clear their committed_txn_id (which, post-rollback, would dangle at
 * deleted ledger/portfolio rows). Called by rollbackBatch inside its
 * transaction, right before markBatchAborted.
 *
 * 'matched' is the exact pre-commit state (both routes drain from it), it is in
 * the status CHECK (0040: pending/validated/matched/committed/duplicate/error —
 * there is no 'rolled_back'), and no reader depends on 'committed' persisting
 * after an abort: the commit route refuses aborted batches, the preview totals
 * count by match_source/error, and the batch-level counters live on
 * portfolio_import_batches. It also makes any future "re-commit after rollback"
 * feature import-once instead of double-importing.
 */
export async function resetCommittedRowsToMatched(batchId: Id): Promise<void> {
  await db
    .updateTable("portfolio_import_staging_rows")
    .set({ status: "matched", committed_txn_id: null })
    .where("batch_id", "=", String(batchId))
    .where("status", "=", "committed")
    .execute();
}

export async function markBatchAborted(batchId: Id): Promise<void> {
  await db
    .updateTable("portfolio_import_batches")
    .set({ status: "aborted" })
    .where("id", "=", String(batchId))
    .execute();
}
