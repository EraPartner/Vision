/**
 * portfolioImportBatchRepository — data access for portfolio_import_batches and
 * portfolio_import_staging_rows. Mirrors importBatchRepository (the transaction
 * side): all SQL for the portfolio import review/history flow lives here so the
 * service layer stays free of raw queries. All access goes through the shared
 * query helper — no raw pool references.
 */

import { sql } from "kysely";
import { asAccountId, asInvestmentId } from "@vision/types/brands";
import type { AccountId } from "@vision/types/brands";
import {
  __getAmbientTransactionClient,
  withTransaction,
} from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  committedStagingRowSchema,
  intTotalRowSchema,
  investmentCreationRowSchema,
  investmentResolutionRowSchema,
  overrideEligibilityRowSchema,
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

/** A JSON array parameter for `IN (SELECT value FROM json_each(?))`. */
const inIds = <T = number>(ids: readonly Id[]) =>
  sql<T>`(SELECT value FROM json_each(${JSON.stringify(ids.map(Number))}))`;

/**
 * PostgreSQL row and table locks became the single SQLite writer (ADR-263):
 * withTransaction() runs BEGIN IMMEDIATE, so everything a transaction reads
 * stays unchanged until it commits. The former lock helpers keep their call
 * sites and refuse to run outside a transaction, where nothing would hold.
 */
function requireWriterTransaction(operation: string): Promise<void> {
  if (!__getAmbientTransactionClient())
    return Promise.reject(
      new Error(`${operation} must run inside withTransaction()`),
    );
  return Promise.resolve();
}

/** A reviewable portfolio row: matched, or an unresolved-instrument error. */
const REVIEWABLE_PORTFOLIO_ROW = sql<boolean>`(status = 'matched'
             OR (status = 'error'
               AND error_message = 'unresolved instrument — pick or create a holding'))
           AND route IS NOT 'cash'`;

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
    .where("account_id", "in", inIds<AccountId>(sourceIds))
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** Hold routed batches for an account merge. The merge's writer transaction
 * excludes a concurrent portfolio-import commit (formerly a batch -> account
 * row-lock order), so the reviewed destination cannot change underneath it.
 */
export async function lockForAccountMerge(_sourceIds: number[]): Promise<void> {
  await requireWriterTransaction("lockForAccountMerge");
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
  // One unit, as PostgreSQL's single data-modifying statement was.
  await withTransaction(async () => {
    let repaired = 0;
    if (account !== null) {
      const result = await db
        .updateTable("portfolio_import_staging_rows")
        .set({ status: "matched", error_message: null })
        .where("batch_id", "=", String(batchId))
        .where("route", "=", "cash")
        .where("status", "=", "error")
        .where(
          "error_message",
          "=",
          "brokerage cash row requires a batch account",
        )
        .executeTakeFirst();
      repaired = Number(result.numUpdatedRows);
    }
    await db
      .updateTable("portfolio_import_batches")
      .set({
        account_id: account === null ? null : asAccountId(account),
        rows_error: sql<number>`max(COALESCE(rows_error, 0) - ${repaired}, 0)`,
      })
      .where("id", "=", String(batchId))
      .execute();
  });
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
      .select(sql<number>`COUNT(*)`.as("total")),
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
 * Read one batch for a lifecycle-sensitive transaction. Inside the caller's
 * withTransaction() the row cannot change before it commits (ADR-263).
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
      .where("id", "=", String(batchId)),
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
            OR (route = 'cash' AND (${account} IS NULL OR amount IS NULL))
            OR (route IS NOT 'cash' AND route IS NOT 'account_internal' AND (
              (type IS NULL AND route IS NOT 'asset_transfer' AND route IS NOT 'asset_adjustment')
              OR COALESCE(user_override_investment_id, resolved_investment_id) IS NULL
            ))
          ))
        )
      ORDER BY row_index`,
  );
}

/**
 * Keep the overlap read stable until the enclosing reviewed import
 * transaction finishes. PostgreSQL locked the account row and the portfolio
 * table; the enclosing writer transaction now excludes manual writes and
 * account lifecycle changes (ADR-263).
 */
export async function lockImportReadinessHistory(
  _accountId: number | null | undefined,
): Promise<void> {
  await requireWriterTransaction("lockImportReadinessHistory");
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
        AND abs(date_diff_days(pt.date, isr.tx_date)) <= 7
      WHERE isr.batch_id = ${batchId}
        AND isr.status = 'matched'
        AND isr.route IS NOT 'cash'
        AND pt.dedup_fingerprint IS NULL
        AND (
          (isr.type IN ('buy', 'sell', 'gift', 'split')
            AND isr.units IS NOT NULL AND pt.units IS NOT NULL
            AND dec_le(
              dec_abs(dec_sub(pt.units, isr.units)),
              dec_greatest(
                '0.00000001',
                dec_mul(dec_abs(isr.units), '0.00000001'))))
          OR isr.type NOT IN ('buy', 'sell', 'gift', 'split')
        )
        AND NOT EXISTS (
          SELECT 1 FROM portfolio_transactions canonical
           WHERE NULLIF(isr.dedup_fingerprint, '') IS NOT NULL
             AND canonical.dedup_fingerprint = isr.dedup_fingerprint
             AND canonical.dedup_fingerprint_version = isr.dedup_fingerprint_version
             AND canonical.investment_id = COALESCE(
                  isr.user_override_investment_id, isr.resolved_investment_id)
             AND canonical.account_id IS ${account}
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
  // The row's status BEFORE the update tells the caller an error→matched
  // reset from a plain re-point of an already-matched row. The read and the
  // writes share one writer transaction, so the row cannot change in between.
  return withTransaction(async () => {
    const updated = await checkedRow(
      stagingOldStatusRowSchema,
      sql`SELECT status AS old_status
            FROM portfolio_import_staging_rows
           WHERE batch_id = ${batchId} AND id = ${rowId}
             AND ${REVIEWABLE_PORTFOLIO_ROW}`,
    );
    if (!updated) return 0;
    const reset = updated.old_status === "error" && investmentId != null;
    await db
      .updateTable("portfolio_import_staging_rows")
      .set({
        user_override_investment_id:
          investmentId == null ? null : asInvestmentId(investmentId),
        ...(reset ? { status: "matched", error_message: null } : {}),
      })
      .where("batch_id", "=", String(batchId))
      .where("id", "=", String(rowId))
      .execute();

    // If we flipped an error row back to matched, the batch's cumulative
    // rows_error over-counts it — decrement so total counts don't exceed rows_total.
    if (reset) {
      await db
        .updateTable("portfolio_import_batches")
        .set({ rows_error: sql<number>`max(COALESCE(rows_error, 0) - 1, 0)` })
        .where("id", "=", String(batchId))
        .execute();
    }

    return 1;
  });
}

/**
 * Read a review resolution's batch and complete row set. The caller's writer
 * transaction serializes concurrent "create new" requests for the same batch,
 * so neither can create a holding before seeing the other's overrides.
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
      .where("id", "in", inIds<string>(rowIds))
      .orderBy("id"),
  );

  return { batchStatus: batch.status, rows };
}

/**
 * Point a complete requested set of review rows at one investment.
 *
 * The requested/eligible count guard runs in the same writer transaction as
 * the update. If even one id is missing, belongs to another batch, or is no
 * longer reviewable, the guard is false and zero rows change. The service
 * wraps this (and optional holding creation) in one transaction.
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
  // One writer transaction: the eligibility count and the guarded update see
  // the same rows, as PostgreSQL's single statement did.
  const summary = await withTransaction(async () => {
    const requested = [...new Set(rowIds.map(Number))];
    const rows = sql<boolean>`batch_id = ${batchId} AND id IN ${inIds(requested)}
           AND ${REVIEWABLE_PORTFOLIO_ROW}`;
    const eligibility = await checkedRow(
      overrideEligibilityRowSchema,
      sql`SELECT COUNT(*) AS eligible_count,
                 COUNT(*) FILTER (WHERE status = 'error') AS error_count
            FROM portfolio_import_staging_rows
           WHERE ${rows}`,
    );
    const eligibleCount = eligibility?.eligible_count ?? 0;
    let updatedCount = 0;
    let resetErrorCount = 0;
    if (requested.length === eligibleCount) {
      const result = await db
        .updateTable("portfolio_import_staging_rows")
        .set({
          user_override_investment_id: asInvestmentId(investmentId),
          status: sql<string>`CASE WHEN status = 'error' THEN 'matched' ELSE status END`,
          error_message: sql<string | null>`CASE WHEN status = 'error' THEN NULL ELSE error_message END`,
        })
        .where(rows)
        .executeTakeFirst();
      updatedCount = Number(result.numUpdatedRows);
      resetErrorCount = eligibility?.error_count ?? 0;
    }
    const counts = {
      requested_count: requested.length,
      eligible_count: eligibleCount,
      updated_count: updatedCount,
      reset_error_count: resetErrorCount,
    };

    if (counts.reset_error_count > 0) {
      await db
        .updateTable("portfolio_import_batches")
        .set({
          rows_error: sql<number>`max(COALESCE(rows_error, 0) - ${counts.reset_error_count}, 0)`,
        })
        .where("id", "=", String(batchId))
        .execute();
    }
    return counts;
  });

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
