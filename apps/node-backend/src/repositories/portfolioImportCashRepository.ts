/** Source-owned cash inserts, full after-images and guarded rollback. */
import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import type { Json } from "../database/schema.generated.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  accountLabelRowSchema,
  batchIdOnlyRowSchema,
  bigintIdRowSchema,
  cashSnapshotRowSchema,
  ibkrCashReceiptRowSchema,
  ibkrCashSnapshotRowSchema,
  intIdRowSchema,
  statementBalanceSnapshotRowSchema,
} from "../database/rows/portfolioImport.ts";
import type {
  CashTransactionSnapshot,
  IbkrCashReceipt,
  IbkrCashSnapshot,
  StatementBalanceSnapshot,
} from "../database/rows/portfolioImport.ts";
import { ConflictError } from "../middleware/errorHandler.ts";
import recipientRepository from "./recipientRepository.ts";
import {
  readReconciliationSources,
  readReconciliationBatchScope,
} from "./portfolioImportReconciliationRepository.ts";
import type {
  ReconciliationBatchScopeRow,
  ReconciliationSourceRow,
} from "./portfolioImportReconciliationRepository.ts";
import { asAccountId, asCurrencyCode, asTransactionId } from "@vision/types/brands";
import type { AccountId, CurrencyCode, TransactionId } from "@vision/types/brands";

export type {
  CashTransactionSnapshot,
  IbkrCashReceipt,
  IbkrCashSnapshot,
  StatementBalanceSnapshot,
};
/** Proven cash movement values (see portfolioKinesisCashScope). */
export interface KinesisCashValues {
  /** 'YYYY-MM-DD' */
  date: string;
  /** exact decimal text */
  amount: string;
  currency: string;
  accountId: number;
  isTransfer: boolean;
}

const CASH_SNAPSHOT_SQL = `jsonb_build_object('id',t.id,'date',to_char(t.date,'YYYY-MM-DD'),
  'amount',t.amount::text,'currency',t.currency,'memo',t.memo,'comment',t.comment,'balance',t.balance::text,
  'account_id',t.account_id,'recipient_id',t.recipient_id,'recipient_bank_account_id',t.recipient_bank_account_id,
  'category_id',t.category_id,'is_active',t.is_active,'import_batch_id',t.import_batch_id,
  'source_record_hash',t.source_record_hash,'dedup_fingerprint',t.dedup_fingerprint,
  'dedup_fingerprint_version',t.dedup_fingerprint_version,'is_transfer',t.is_transfer,
  'transfer_source',t.transfer_source,'transfer_peer_id',t.transfer_peer_id)`;
export const __CASH_SNAPSHOT_SQL = CASH_SNAPSHOT_SQL;
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
export interface KinesisCashContext {
  ledger: CashTransactionSnapshot[];
  sources: ReconciliationSourceRow[];
  batches: ReconciliationBatchScopeRow[];
  statementBalances: StatementBalanceSnapshot[];
}

export async function readKinesisCashContext(): Promise<KinesisCashContext> {
  // Whole ledger binds competing identities; no date-window guesses are adopted.
  const ledger = (
    await checkedRows(
      cashSnapshotRowSchema,
      db
        .selectFrom("transactions as t")
        .select(cashSnapshot.as("snapshot"))
        .orderBy("t.id"),
    )
  ).map((item) => item.snapshot);
  const ids = (
    await checkedRows(
      batchIdOnlyRowSchema,
      db
        .selectFrom("portfolio_import_staging_rows")
        .select("batch_id")
        .distinct()
        .where("route", "=", "cash")
        .where("committed_txn_id", "is not", null)
        .where("raw_data", "like", '%"portfolioCashReceipt"%')
        .orderBy("batch_id"),
    )
  ).map((item) => Number(item.batch_id));
  const [sources, batches] = ids.length > 0
    ? await Promise.all([
        readReconciliationSources(ids),
        readReconciliationBatchScope(ids),
      ])
    : [[], []];
  const statementBalances = (
    await checkedRows(
      statementBalanceSnapshotRowSchema,
      db
        .selectFrom("account_statement_balances as s")
        .select(sql<StatementBalanceSnapshot>`to_jsonb(s)`.as("snapshot"))
        .orderBy("account_id")
        .orderBy("currency"),
    )
  ).map((item) => item.snapshot);
  return { ledger, sources, batches, statementBalances };
}
export async function lockKinesisCashLedger(
  accountIds: readonly number[] = [],
): Promise<void> {
  await lockTransactions();
  if (accountIds.length > 0)
    await db
      .selectFrom("account_statement_balances")
      .select("account_id")
      .where("account_id", "=", sql<AccountId>`ANY(${accountIds}::integer[])`)
      .orderBy("account_id")
      .orderBy("currency")
      .forUpdate()
      .execute();
}
export interface InsertKinesisCashArgs {
  /** the matched staging source row */
  row: Pick<
    ReconciliationSourceRow,
    | "id"
    | "batch_id"
    | "note"
    | "raw_data"
    | "source_record_hash"
    | "dedup_fingerprint"
    | "dedup_fingerprint_version"
  >;
  values: KinesisCashValues;
  proof: unknown;
  feeValues?: KinesisCashValues | undefined;
  primaryRawData: string | null;
  feeFingerprint?: string | undefined;
}

export async function insertKinesisCash({
  row,
  values,
  proof,
  feeValues,
  primaryRawData,
  feeFingerprint,
}: InsertKinesisCashArgs): Promise<{
  after: CashTransactionSnapshot;
  feeAfter?: CashTransactionSnapshot;
  recordedCash: number;
}> {
  const account = await checkedRow(
    accountLabelRowSchema,
    db
      .selectFrom("accounts")
      .select(["institution", "name"])
      .where("id", "=", asAccountId(values.accountId)),
  );
  const label = String(account?.institution || account?.name || "").trim();
  const recipientId = label
    ? // getById right after the upsert that returned this id: never null.
      (await recipientRepository.createOrGet({ name: label })).recipient!.id
    : await recipientRepository.getOrCreateSystemId();
  const insertCash = (
    cash: KinesisCashValues,
    memo: string | null,
    dedupFingerprint: string | null | undefined,
    isTransfer: boolean,
  ) =>
    checkedRow(
      intIdRowSchema,
      db
        .insertInto("transactions")
        .values({
          date: cash.date,
          amount: cash.amount,
          currency: asCurrencyCode(cash.currency),
          memo,
          account_id: asAccountId(cash.accountId),
          recipient_id: recipientId,
          category_id: null,
          source_record_hash: row.source_record_hash,
          dedup_fingerprint: dedupFingerprint ?? null,
          dedup_fingerprint_version: row.dedup_fingerprint_version,
          is_transfer: isTransfer,
          transfer_source: "brokerage",
          transfer_peer_id: null,
          is_active: true,
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id"),
    );
  const inserted = await insertCash(
    values,
    row.note,
    row.dedup_fingerprint,
    values.isTransfer,
  );
  if (!inserted) throw stale();
  const after = await readCashImage(inserted.id);
  let feeAfter: CashTransactionSnapshot | undefined;
  if (feeValues) {
    const fee = await insertCash(
      feeValues,
      `${row.note} (withdrawal fee)`,
      feeFingerprint,
      false,
    );
    if (!fee) throw stale();
    feeAfter = await readCashImage(fee.id);
  }
  const envelope = JSON.stringify({
    primaryRawData,
    portfolioCashReceipt: {
      version: 1,
      proof,
      values,
      after,
      ...(feeAfter ? { feeValues, feeAfter } : {}),
    },
  });
  const changed = await db
    .updateTable("portfolio_import_staging_rows")
    .set({
      status: "committed",
      committed_txn_id: inserted.id,
      raw_data: envelope,
    })
    .where("id", "=", String(row.id))
    .where("status", "=", "matched")
    .where("raw_data", "=", row.raw_data)
    .returning("id")
    .execute();
  if (changed.length !== 1) throw stale();
  await db
    .updateTable("portfolio_import_batches")
    .set((eb) => ({ rows_imported: eb("rows_imported", "+", 1) }))
    .where("id", "=", String(row.batch_id))
    .execute();
  return {
    after,
    ...(feeAfter ? { feeAfter } : {}),
    recordedCash: feeAfter ? 2 : 1,
  };
}
/** The after-image of a row this transaction just inserted (so it exists). */
async function readCashImage(id: number): Promise<CashTransactionSnapshot> {
  const row = await checkedRow(
    cashSnapshotRowSchema,
    db
      .selectFrom("transactions as t")
      .select(cashSnapshot.as("snapshot"))
      .where("id", "=", asTransactionId(id)),
  );
  if (!row) throw new Error("Inserted cash transaction is missing its image");
  return row.snapshot;
}
export async function readCashImagesForUpdate(
  ids: readonly number[],
): Promise<CashTransactionSnapshot[]> {
  return (
    await checkedRows(
      cashSnapshotRowSchema,
      db
        .selectFrom("transactions as t")
        .select(cashSnapshot.as("snapshot"))
        .where("id", "=", sql<TransactionId>`ANY(${ids}::int[])`)
        .orderBy("id")
        .forUpdate(),
    )
  ).map((item) => item.snapshot);
}

// Categories and ordinary bank pairing can change after adoption. They do not
// weaken the immutable financial/provenance after-image used for restoration.
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
/** The authenticated original base-currency cash event. */
export interface IbkrBaseCashEvidence {
  version: 1;
  batchId: number;
  stagingRowId: number;
  type: "deposit" | "withdrawal";
  date: string;
  baseCurrency: string;
  baseAmount: string;
  fxRate: string;
  sourceAccount: string;
  sourceRecordHash: string | null;
  sourceFileHash: string | null;
  rawData: string;
  contextOrigin?: "retained_repeat_source";
}
/** The authenticated native-currency funding workbook record. */
export interface IbkrFundingEvidence {
  type: "deposit" | "withdrawal";
  direction: "in" | "out";
  date: string;
  completedDate: string;
  currency: CurrencyCode;
  amount: string;
  sourceAccount: string;
  sourceId: string;
  reference: string;
  accountTitle: string;
  institution: string | undefined;
  method: string;
  status: string;
  rawData: string;
  recordHash: string;
  sourceFileHash: string;
  sourceFormat: "xls" | "xlsx";
}
export interface IbkrCashProof {
  kind: "ibkr_native_funding";
  version: 1;
  original: IbkrBaseCashEvidence;
  native: IbkrFundingEvidence;
  oldFingerprint: string | null;
  newFingerprint: string | null;
  primaryReference?: IbkrBaseCashEvidence;
  sourceBindings: IbkrCashSourceBinding[];
}
/** Journal before/after data of an IBKR cash correction. */
export interface IbkrCashEnvelope {
  ledgerKind: "cash";
  version: 1;
  snapshot: IbkrCashFinancialImage;
  proof: IbkrCashProof;
}
export interface IbkrCashCorrectionContext {
  ledger: CashTransactionSnapshot[];
  sources: ReconciliationSourceRow[];
  batches: ReconciliationBatchScopeRow[];
  receipts: IbkrCashReceipt[];
}
/** A proven correction (adopt) or a repeat of an already corrected record. */
export interface IbkrCashCorrectionAction {
  action: "adopt" | "duplicate";
  policy: "prefer_source";
  settled: boolean;
  row: ReconciliationSourceRow;
  originalRow: ReconciliationSourceRow;
  transactionId: number;
  receiptId?: number;
  before: IbkrCashEnvelope;
  after: IbkrCashEnvelope;
  proof?: IbkrCashProof;
  corrections: { field: string; before: unknown; after: unknown }[];
  sourceBindings: IbkrCashSourceBinding[];
}

export async function readIbkrCashCorrectionContext(): Promise<IbkrCashCorrectionContext> {
  const ledger = (
    await checkedRows(
      cashSnapshotRowSchema,
      db
        .selectFrom("transactions as t")
        .select(cashSnapshot.as("snapshot"))
        .orderBy("t.id"),
    )
  ).map((item) => item.snapshot);
  const ids = (
    await checkedRows(
      bigintIdRowSchema,
      db
        .selectFrom("portfolio_import_batches")
        .select("id")
        .where(sql<boolean>`custom_config::jsonb->>'format'='ibkr_transaction_history'`)
        .orderBy("id"),
    )
  ).map((item) => Number(item.id));
  const [sources, batches, receipts] = await Promise.all([
    ids.length > 0 ? readReconciliationSources(ids) : [],
    ids.length > 0 ? readReconciliationBatchScope(ids) : [],
    checkedRows(
      ibkrCashReceiptRowSchema,
      db
        .selectFrom("portfolio_import_reconciliation_journal as a")
        .selectAll("a")
        .where("a.action", "=", "adopt")
        .where(sql<boolean>`a.after_data->>'ledgerKind'='cash'`)
        .where(activeJournalEntry)
        .orderBy("a.id"),
    ),
  ]);
  return { ledger, sources, batches, receipts };
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

/** Compare every financial and source field; preserve user categorization/pairs. */
export async function compareAndSetIbkrCashImage(
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

async function assertIbkrSourceBindings(
  bindings: readonly IbkrCashSourceBinding[],
): Promise<void> {
  for (const binding of bindings) {
    const result = await sql`SELECT 1 FROM portfolio_import_staging_rows s
      JOIN portfolio_import_batches b ON b.id=s.batch_id
      WHERE s.id=${binding.id} AND s.batch_id=${binding.batch_id}
        AND (to_jsonb(s) - ARRAY['created_at','updated_at']::text[]) @> ${jsonb(binding.staging)}
        AND b.account_id=${binding.account_id} AND b.custom_config::jsonb=${jsonb(binding.custom_config)} FOR UPDATE OF s`.execute(
      db,
    );
    if (result.rows.length !== 1) throw stale();
  }
}

async function settleIbkrNativeSource(
  row: ReconciliationSourceRow,
): Promise<void> {
  const changed = await db
    .updateTable("portfolio_import_staging_rows")
    .set({ status: "duplicate", committed_txn_id: null, error_message: null })
    .where("id", "=", String(row.id))
    .where("batch_id", "=", String(row.batch_id))
    .where("status", "=", row.status)
    .returning("id")
    .execute();
  if (changed.length !== 1) throw stale();
  const batch = await db
    .updateTable("portfolio_import_batches")
    .set((eb) => ({
      rows_duplicate: eb("rows_duplicate", "+", 1),
      rows_error: eb("rows_error", "-", row.status === "error" ? 1 : 0),
    }))
    .where("id", "=", String(row.batch_id))
    .returning("id")
    .execute();
  if (batch.length !== 1) throw stale();
}

export async function writeIbkrCashCorrection(
  action: IbkrCashCorrectionAction,
): Promise<{ receiptId: number; after: IbkrCashSnapshot; recordedCash: 0 }> {
  return withTransaction(async () => {
    await lockTransactions();
    await assertIbkrSourceBindings(action.sourceBindings);
    const after = await compareAndSetIbkrCashImage(action.before.snapshot, action.after.snapshot);
    const receipt = await checkedRow(
      bigintIdRowSchema,
      db
        .insertInto("portfolio_import_reconciliation_journal")
        .values({
          batch_id: action.row.batch_id,
          staging_row_id: action.row.id,
          transaction_id: action.transactionId,
          action: "adopt",
          policy: "prefer_source",
          before_data: jsonb(action.before),
          after_data: jsonb(action.after),
        })
        .returning("id"),
    );
    await settleIbkrNativeSource(action.row);
    return { receiptId: Number(receipt!.id), after, recordedCash: 0 as const };
  });
}

export async function writeIbkrCashCorrectionRepeat(
  action: IbkrCashCorrectionAction,
): Promise<{ recordedCash: 0 }> {
  return withTransaction(async () => {
    await lockTransactions();
    await assertIbkrSourceBindings(action.sourceBindings);
    const current = await sql`SELECT 1 FROM transactions t WHERE t.id=${action.transactionId}
      AND ${ibkrCashSnapshot}=${jsonb(action.after.snapshot)} FOR UPDATE`.execute(db);
    const receipt = await sql`SELECT 1 FROM portfolio_import_reconciliation_journal a
      WHERE a.id=${action.receiptId} AND a.action='adopt' AND a.after_data=${jsonb(action.after)}
        AND ${activeJournalEntry}`.execute(db);
    if (current.rows.length !== 1 || receipt.rows.length !== 1) throw stale();
    await settleIbkrNativeSource(action.row);
    return { recordedCash: 0 as const };
  });
}

export async function writeIbkrCashRestoration(
  receipt: IbkrCashReceipt,
): Promise<IbkrCashSnapshot> {
  return withTransaction(async () => {
    await lockTransactions();
    const active = await sql`SELECT 1 FROM portfolio_import_reconciliation_journal a
      WHERE a.id=${receipt.id} AND a.action='adopt' AND a.before_data=${jsonb(receipt.before_data)} AND a.after_data=${jsonb(receipt.after_data)}
        AND ${activeJournalEntry}`.execute(db);
    if (active.rows.length !== 1) throw stale();
    if (!Array.isArray(receipt.after_data.proof?.sourceBindings) || ![2, 3].includes(receipt.after_data.proof.sourceBindings.length)) throw stale();
    await assertIbkrSourceBindings(receipt.after_data.proof.sourceBindings);
    const after = await compareAndSetIbkrCashImage(receipt.after_data.snapshot, receipt.before_data.snapshot);
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
  });
}

/** An original import cannot delete a cash record adopted by another batch. */
export async function guardOriginalIbkrCashRollback(
  batchId: number,
): Promise<void> {
  const active = await sql`SELECT 1 FROM portfolio_import_reconciliation_journal a
    WHERE a.action='adopt' AND a.after_data->>'ledgerKind'='cash'
      AND ((a.after_data->'proof'->'original'->>'batchId')::bigint=${batchId}
        OR (a.after_data->'proof'->'primaryReference'->>'batchId')::bigint=${batchId})
      AND ${activeJournalEntry}
    LIMIT 1`.execute(db);
  if (active.rows.length > 0) throw stale();
}
