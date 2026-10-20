/**
 * Cash records written by the reconciliation workflows that ADR-236 removed:
 * IBKR native funding corrections (reconciliation journal, `ledgerKind='cash'`)
 * and Kinesis cash-only components (a `portfolioCashReceipt` envelope in the
 * staging row's `raw_data`). No new rows of either kind are written. These
 * reads and the restoration keep already applied records reversible.
 */
import { sql } from "kysely";
import type { Json } from "../database/schema.generated.ts";
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

const CASH_SNAPSHOT_SQL = `jsonb_build_object('id',t.id,'date',to_char(t.date,'YYYY-MM-DD'),
  'amount',t.amount::text,'currency',t.currency,'memo',t.memo,'comment',t.comment,'balance',t.balance::text,
  'account_id',t.account_id,'recipient_id',t.recipient_id,'recipient_bank_account_id',t.recipient_bank_account_id,
  'category_id',t.category_id,'is_active',t.is_active,'import_batch_id',t.import_batch_id,
  'source_record_hash',t.source_record_hash,'dedup_fingerprint',t.dedup_fingerprint,
  'dedup_fingerprint_version',t.dedup_fingerprint_version,'is_transfer',t.is_transfer,
  'transfer_source',t.transfer_source,'transfer_peer_id',t.transfer_peer_id)`;
const cashSnapshot = sql.raw<CashTransactionSnapshot>(CASH_SNAPSHOT_SQL);
const jsonb = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;
const lockTransactions = () =>
  sql`LOCK TABLE transactions IN SHARE ROW EXCLUSIVE MODE`.execute(db);
/** The journal entry has not been superseded by a later restore. */
const activeJournalEntry = sql<boolean>`NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)`;
const stale = () =>
  new ConflictError("Owned cash source or ledger image changed", {
    details: { reason: "cash_receipt_changed" },
  });

// Categories and ordinary bank pairing can change after a correction. They do
// not weaken the financial/provenance image compared for restoration.
const ibkrCashSnapshot = sql<IbkrCashSnapshot>`(${cashSnapshot}) - ARRAY['category_id','is_transfer','transfer_source','transfer_peer_id']::text[]`;

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
/** The stored proof of an applied IBKR funding correction (read only). */
export interface IbkrCashProof {
  kind: "ibkr_native_funding";
  version: 1;
  original: { batchId: number; [key: string]: unknown };
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

export async function readIbkrCashImagesForUpdate(
  ids: readonly number[],
): Promise<IbkrCashSnapshot[]> {
  return (
    await checkedRows(
      ibkrCashSnapshotRowSchema,
      db
        .selectFrom("transactions as t")
        .select(ibkrCashSnapshot.as("snapshot"))
        .where("id", "=", sql<TransactionId>`ANY(${ids}::integer[])`)
        .orderBy("id")
        .forUpdate(),
    )
  ).map((item) => item.snapshot);
}

/** Restore only amount, currency and identity; keep categorization and pairs. */
async function compareAndSetIbkrCashImage(
  before: IbkrCashFinancialImage,
  after: IbkrCashFinancialImage,
): Promise<IbkrCashSnapshot> {
  const image = jsonb(after);
  const [row, ...extra] = await checkedRows(
    ibkrCashSnapshotRowSchema,
    sql`UPDATE transactions t SET
      amount=(${image}->>'amount')::numeric, currency=${image}->>'currency',
      dedup_fingerprint=${image}->>'dedup_fingerprint',
      dedup_fingerprint_version=(${image}->>'dedup_fingerprint_version')::smallint
    WHERE t.id=${before.id} AND ${ibkrCashSnapshot}=${jsonb(before)}
    RETURNING ${ibkrCashSnapshot} AS snapshot`,
  );
  if (!row || extra.length > 0) throw stale();
  return row.snapshot;
}

/** Undo one applied IBKR funding correction and append its inverse receipt. */
export async function writeIbkrCashRestoration(
  receipt: IbkrCashReceipt,
): Promise<IbkrCashSnapshot> {
  await lockTransactions();
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
      policy: "prefer_source",
      before_data: jsonb(receipt.after_data),
      after_data: jsonb(receipt.before_data),
      previous_entry_id: receipt.id,
    })
    .execute();
  return after;
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
      AND ((a.after_data->'proof'->'original'->>'batchId')::bigint=${batchId}
        OR (a.after_data->'proof'->'primaryReference'->>'batchId')::bigint=${batchId})
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
    sql`SELECT fee.id
      FROM portfolio_import_staging_rows s
      CROSS JOIN LATERAL (SELECT portfolio_cash_receipt(s.raw_data) AS receipt) r
      JOIN transactions fee ON fee.id::text = r.receipt->'feeAfter'->>'id'
     WHERE s.batch_id = ${batchId}
       AND s.status = 'committed'
       AND s.route = 'cash'
       AND r.receipt IS NOT NULL
       AND fee.dedup_fingerprint = r.receipt->'feeAfter'->>'dedup_fingerprint'
       AND fee.source_record_hash = s.source_record_hash
     ORDER BY fee.id`,
  );
  return rows.map((row) => row.id);
}
