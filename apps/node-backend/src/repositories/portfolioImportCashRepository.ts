/**
 * Cash records written by the reconciliation workflows that ADR-236 removed:
 * IBKR native funding corrections (reconciliation journal, `ledgerKind='cash'`)
 * and Kinesis cash-only components (a `portfolioCashReceipt` envelope in the
 * staging row's `raw_data`). No new rows of either kind are written. These
 * reads and the restoration keep already applied records reversible.
 */
import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRows, db } from "../database/db.ts";
import {
  ibkrCashReceiptRowSchema,
  ibkrCashSnapshotRowSchema,
  intIdRowSchema,
} from "../database/rows/portfolioImport.ts";
import type {
  CashTransactionSnapshot,
  IbkrCashReceipt,
  IbkrCashSnapshot,
} from "../database/rows/portfolioImport.ts";
import { ConflictError } from "../middleware/errorHandler.ts";
import type { TransactionId } from "@vision/types/brands";

export type { CashTransactionSnapshot, IbkrCashReceipt, IbkrCashSnapshot };

/**
 * The cash image of `transactions` row `alias` as canonical jsonb text
 * (PostgreSQL's jsonb_build_object output): NUMERIC as exact text, `date` as
 * 'YYYY-MM-DD', BIGINT `import_batch_id` as a JSON number, booleans as JSON
 * booleans. Categories and ordinary bank pairing (category_id, is_transfer,
 * transfer_source, transfer_peer_id) can change after a correction; they do
 * not weaken the financial/provenance image compared for restoration, so the
 * IBKR image leaves them out. Read it with a `::json` alias hint.
 */
function ibkrCashSnapshotSql(alias: "t" | "transactions") {
  return sql.raw<IbkrCashSnapshot>(`vision_jsonb(json_object(
  'id', ${alias}.id, 'date', to_char(${alias}.date, 'YYYY-MM-DD'),
  'amount', ${alias}.amount, 'currency', ${alias}.currency, 'memo', ${alias}.memo,
  'comment', ${alias}.comment, 'balance', ${alias}.balance,
  'account_id', ${alias}.account_id, 'recipient_id', ${alias}.recipient_id,
  'recipient_bank_account_id', ${alias}.recipient_bank_account_id,
  'is_active', json(iif(${alias}.is_active, 'true', 'false')),
  'import_batch_id', ${alias}.import_batch_id,
  'source_record_hash', ${alias}.source_record_hash,
  'dedup_fingerprint', ${alias}.dedup_fingerprint,
  'dedup_fingerprint_version', ${alias}.dedup_fingerprint_version))`);
}
/** A JSON array parameter for `IN (SELECT value FROM json_each(?))`. */
const inIds = (ids: readonly number[]) =>
  sql<TransactionId>`(SELECT value FROM json_each(${JSON.stringify(ids.map(Number))}))`;
/** The journal entry has not been superseded by a later restore. */
const activeJournalEntry = sql<boolean>`NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)`;
const stale = () =>
  new ConflictError("Owned cash source or ledger image changed", {
    details: { reason: "cash_receipt_changed" },
  });

/** The compared financial/provenance subset of an IBKR cash image. */
export type IbkrCashFinancialImage = {
  [K in
    | "id"
    | "date"
    | "amount"
    | "currency"
    | "memo"
    | "comment"
    | "balance"
    | "account_id"
    | "recipient_id"
    | "recipient_bank_account_id"
    | "is_active"
    | "import_batch_id"
    | "source_record_hash"
    | "dedup_fingerprint"
    | "dedup_fingerprint_version"]: CashTransactionSnapshot[K] | null;
};
/** A staged row and its batch config, pinned literally at correction time. */
export interface IbkrCashSourceBinding {
  id: number;
  batch_id: number;
  account_id: number;
  /** The batch's stored config JSON, compared verbatim with the batch row. */
  custom_config: unknown;
  staging: Record<string, unknown>;
}
/**
 * The stored proof of an applied cash adoption: an IBKR funding workbook row
 * that corrected a base-currency Transaction History deposit to its own
 * currency (`ibkr_native_funding`, also written before ADR-236), or an
 * imported cash row that adopted a manual transaction (`cash_adoption`).
 */
export interface IbkrCashProof {
  kind: "ibkr_native_funding" | "cash_adoption";
  version: 1;
  /** the batch whose committed transaction was corrected, if any */
  original?: { batchId: number; [key: string]: unknown };
  primaryReference?: { batchId: number; [key: string]: unknown };
  sourceBindings: IbkrCashSourceBinding[];
  [key: string]: unknown;
}
/** Journal before/after data of an IBKR cash correction. */
export interface IbkrCashEnvelope {
  ledgerKind: "cash";
  version: 1;
  snapshot: IbkrCashFinancialImage;
  proof: IbkrCashProof;
}

/** Inside the caller's writer transaction the images cannot change (ADR-263). */
export async function readIbkrCashImagesForUpdate(
  ids: readonly number[],
): Promise<IbkrCashSnapshot[]> {
  return (
    await checkedRows(
      ibkrCashSnapshotRowSchema,
      sql`SELECT ${ibkrCashSnapshotSql("t")} AS "snapshot::json"
            FROM transactions t
           WHERE t.id IN ${inIds(ids)}
           ORDER BY t.id`,
    )
  ).map((item) => item.snapshot);
}

/** Restore only amount, currency and identity; keep categorization and pairs. */
async function compareAndSetIbkrCashImage(
  before: IbkrCashFinancialImage,
  after: IbkrCashFinancialImage,
): Promise<IbkrCashSnapshot> {
  const image = JSON.stringify(after);
  // A savepoint keeps the write and its read-back one unit.
  return withTransaction(async () => {
    // SQLite 3.39 has no UPDATE target alias: the image names the table.
    const result = await sql`UPDATE transactions SET
      amount = vision_numeric(${image} ->> 'amount', 18, 4),
      currency = ${image} ->> 'currency',
      dedup_fingerprint = ${image} ->> 'dedup_fingerprint',
      dedup_fingerprint_version = CAST(${image} ->> 'dedup_fingerprint_version' AS INTEGER)
    WHERE transactions.id = ${before.id}
      AND ${ibkrCashSnapshotSql("transactions")} = vision_jsonb(${JSON.stringify(before)})`.execute(
      db,
    );
    if (Number(result.numAffectedRows ?? 0) !== 1) throw stale();
    const [row, ...extra] = await checkedRows(
      ibkrCashSnapshotRowSchema,
      sql`SELECT ${ibkrCashSnapshotSql("t")} AS "snapshot::json"
            FROM transactions t WHERE t.id = ${before.id}`,
    );
    if (!row || extra.length > 0) throw stale();
    return row.snapshot;
  });
}

/**
 * Apply one planned cash adoption: change the transaction's amount, currency
 * and identity from `before` to `after` only if it still equals `before`, and
 * journal both images so batch rollback can restore it. The caller holds the
 * batch, account and transactions locks.
 */
export async function writeCashAdoption({
  batchId,
  stagingRowId,
  policy,
  before,
  after,
  proof,
}: {
  batchId: number;
  stagingRowId: number;
  policy: "exact" | "preserve_existing" | "prefer_source";
  before: IbkrCashSnapshot;
  after: IbkrCashSnapshot;
  proof: IbkrCashProof;
}): Promise<IbkrCashSnapshot> {
  const persisted = await compareAndSetIbkrCashImage(before, after);
  const envelope = (snapshot: IbkrCashSnapshot): IbkrCashEnvelope => ({
    ledgerKind: "cash",
    version: 1,
    snapshot,
    proof,
  });
  await db
    .insertInto("portfolio_import_reconciliation_journal")
    .values({
      batch_id: batchId,
      staging_row_id: stagingRowId,
      transaction_id: before.id,
      action: "adopt",
      policy,
      before_data: JSON.stringify(envelope(before)),
      after_data: JSON.stringify(envelope(persisted)),
    })
    .execute();
  return persisted;
}

/** Undo one applied IBKR funding correction and append its inverse receipt. */
export async function writeIbkrCashRestoration(
  receipt: IbkrCashReceipt,
): Promise<IbkrCashSnapshot> {
  // The receipt check, the restoration and its inverse receipt share one
  // writer transaction (formerly a transactions table lock).
  return withTransaction(async () => {
    const active = await sql`SELECT 1 FROM portfolio_import_reconciliation_journal a
      WHERE a.id=${receipt.id} AND a.action='adopt' AND ${activeJournalEntry}`.execute(
      db,
    );
    if (active.rows.length !== 1) throw stale();
    const after = await compareAndSetIbkrCashImage(
      receipt.after_data.snapshot,
      receipt.before_data.snapshot,
    );
    await db
      .insertInto("portfolio_import_reconciliation_journal")
      .values({
        batch_id: receipt.batch_id,
        staging_row_id: receipt.staging_row_id,
        transaction_id: receipt.transaction_id,
        action: "restore",
        policy: receipt.policy,
        before_data: JSON.stringify(receipt.after_data),
        after_data: JSON.stringify(receipt.before_data),
        previous_entry_id: receipt.id,
      })
      .execute();
    return after;
  });
}

/** Active IBKR cash corrections, for the repeat-import alias check. */
export async function readActiveIbkrCashReceipts(): Promise<IbkrCashReceipt[]> {
  return checkedRows(
    ibkrCashReceiptRowSchema,
    db
      .selectFrom("portfolio_import_reconciliation_journal as a")
      .selectAll("a")
      .where("a.action", "=", "adopt")
      .where(sql<boolean>`a.after_data->>'ledgerKind'='cash'`)
      .where(sql<boolean>`NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)`)
      .orderBy("a.id"),
  );
}

/** An original import cannot delete a cash record corrected by another batch. */
export async function guardOriginalIbkrCashRollback(
  batchId: number,
): Promise<void> {
  const active = await sql`SELECT 1 FROM portfolio_import_reconciliation_journal a
    WHERE a.action='adopt' AND a.after_data->>'ledgerKind'='cash'
      AND (CAST(a.after_data ->> '$.proof.original.batchId' AS INTEGER)=${batchId}
        OR CAST(a.after_data ->> '$.proof.primaryReference.batchId' AS INTEGER)=${batchId})
      AND ${activeJournalEntry}
    LIMIT 1`.execute(db);
  if (active.rows.length > 0)
    throw new ConflictError(
      "A later IBKR funding correction still owns this cash. Undo that correction first.",
      { details: { reason: "stale_reconciliation_plan" } },
    );
}

/**
 * Separate fee components that a Kinesis cash-only commit recorded for this
 * batch. The main component is the staging row's `committed_txn_id` and is
 * removed with the ordinary cash rows. A fee is owned only while it still
 * carries the fingerprint and source hash its receipt recorded.
 */
export async function readOwnedKinesisCashFeeIds(
  batchId: number,
): Promise<number[]> {
  const rows = await checkedRows(
    intIdRowSchema,
    // portfolio_cash_receipt() once per committed cash row (formerly a
    // CROSS JOIN LATERAL).
    sql`SELECT fee.id
      FROM (SELECT s.source_record_hash,
                   portfolio_cash_receipt(s.raw_data) AS receipt
              FROM portfolio_import_staging_rows s
             WHERE s.batch_id = ${batchId}
               AND s.status = 'committed'
               AND s.route = 'cash') r
      JOIN transactions fee
        ON CAST(fee.id AS TEXT) = r.receipt -> 'feeAfter' ->> 'id'
     WHERE r.receipt IS NOT NULL
       AND fee.dedup_fingerprint = r.receipt -> 'feeAfter' ->> 'dedup_fingerprint'
       AND fee.source_record_hash = r.source_record_hash
     ORDER BY fee.id`,
  );
  return rows.map((row) => row.id);
}
