/** Source-owned cash inserts, full after-images and guarded rollback. */
import { query, withTransaction } from "../database/connection.ts";
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

/**
 * Full after-image of a `transactions` row as built by CASH_SNAPSHOT_SQL
 * (jsonb: NUMERIC columns as exact text, `date` as 'YYYY-MM-DD').
 */
export interface CashTransactionSnapshot {
  id: number;
  date: string;
  amount: string;
  currency: string | null;
  memo: string | null;
  comment: string | null;
  balance: string | null;
  account_id: number | null;
  recipient_id: number | null;
  recipient_bank_account_id: number | null;
  category_id: number | null;
  is_active: boolean;
  import_batch_id: number | null;
  source_record_hash: string | null;
  dedup_fingerprint: string | null;
  dedup_fingerprint_version: number | null;
  is_transfer: boolean;
  transfer_source: string | null;
  transfer_peer_id: number | null;
}
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
/** An `account_statement_balances` row as `to_jsonb` (NUMERIC as a JSON number). */
export interface StatementBalanceSnapshot {
  account_id: number;
  currency: string;
  balance: number;
  /** 'YYYY-MM-DD' */
  balance_date: string;
}

const CASH_SNAPSHOT_SQL = `jsonb_build_object('id',t.id,'date',to_char(t.date,'YYYY-MM-DD'),
  'amount',t.amount::text,'currency',t.currency,'memo',t.memo,'comment',t.comment,'balance',t.balance::text,
  'account_id',t.account_id,'recipient_id',t.recipient_id,'recipient_bank_account_id',t.recipient_bank_account_id,
  'category_id',t.category_id,'is_active',t.is_active,'import_batch_id',t.import_batch_id,
  'source_record_hash',t.source_record_hash,'dedup_fingerprint',t.dedup_fingerprint,
  'dedup_fingerprint_version',t.dedup_fingerprint_version,'is_transfer',t.is_transfer,
  'transfer_source',t.transfer_source,'transfer_peer_id',t.transfer_peer_id)`;
export const __CASH_SNAPSHOT_SQL = CASH_SNAPSHOT_SQL;
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
    await query<{ snapshot: CashTransactionSnapshot }>(
      `SELECT ${CASH_SNAPSHOT_SQL} AS snapshot FROM transactions t ORDER BY t.id`,
    )
  ).rows.map((item) => item.snapshot);
  const ids = (
    await query<{
      batch_id: string;
    }>(`SELECT DISTINCT batch_id FROM portfolio_import_staging_rows
    WHERE route='cash' AND committed_txn_id IS NOT NULL AND raw_data LIKE '%"portfolioCashReceipt"%' ORDER BY batch_id`)
  ).rows.map((item) => Number(item.batch_id));
  const [sources, batches] = ids.length
    ? await Promise.all([
        readReconciliationSources(ids),
        readReconciliationBatchScope(ids),
      ])
    : [[], []];
  const statementBalances = (
    await query<{ snapshot: StatementBalanceSnapshot }>(
      "SELECT to_jsonb(s) AS snapshot FROM account_statement_balances s ORDER BY account_id,currency",
    )
  ).rows.map((item) => item.snapshot);
  return { ledger, sources, batches, statementBalances };
}
export async function lockKinesisCashLedger(
  accountIds: readonly number[] = [],
): Promise<void> {
  await query("LOCK TABLE transactions IN SHARE ROW EXCLUSIVE MODE");
  if (accountIds.length)
    await query(
      "SELECT account_id FROM account_statement_balances WHERE account_id=ANY($1::integer[]) ORDER BY account_id,currency FOR UPDATE",
      [accountIds],
    );
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
  feeValues?: KinesisCashValues;
  primaryRawData: string | null;
  feeFingerprint?: string;
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
  const account = (
    await query<{ institution: string | null; name: string }>(
      "SELECT institution,name FROM accounts WHERE id=$1",
      [values.accountId],
    )
  ).rows[0];
  const label = String(account?.institution || account?.name || "").trim();
  const recipientId = label
    ? // getById right after the upsert that returned this id: never null.
      (await recipientRepository.createOrGet({ name: label })).recipient!.id
    : await recipientRepository.getOrCreateSystemId();
  const inserted = (
    await query<{ id: number }>(
      `INSERT INTO transactions(date,amount,currency,memo,account_id,recipient_id,category_id,
    source_record_hash,dedup_fingerprint,dedup_fingerprint_version,is_transfer,transfer_source,transfer_peer_id,is_active)
    VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,'brokerage',NULL,true) ON CONFLICT DO NOTHING RETURNING id`,
      [
        values.date,
        values.amount,
        values.currency,
        row.note,
        values.accountId,
        recipientId,
        row.source_record_hash,
        row.dedup_fingerprint,
        row.dedup_fingerprint_version,
        values.isTransfer,
      ],
    )
  ).rows[0];
  if (!inserted) throw stale();
  const after = (
    await query<{ snapshot: CashTransactionSnapshot }>(
      `SELECT ${CASH_SNAPSHOT_SQL} AS snapshot FROM transactions t WHERE id=$1`,
      [inserted.id],
    )
  ).rows[0].snapshot;
  let feeAfter: CashTransactionSnapshot | undefined;
  if (feeValues) {
    const fee = (
      await query<{ id: number }>(
        `INSERT INTO transactions(date,amount,currency,memo,account_id,recipient_id,category_id,
      source_record_hash,dedup_fingerprint,dedup_fingerprint_version,is_transfer,transfer_source,transfer_peer_id,is_active)
      VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,false,'brokerage',NULL,true) ON CONFLICT DO NOTHING RETURNING id`,
        [
          feeValues.date,
          feeValues.amount,
          feeValues.currency,
          `${row.note} (withdrawal fee)`,
          feeValues.accountId,
          recipientId,
          row.source_record_hash,
          feeFingerprint,
          row.dedup_fingerprint_version,
        ],
      )
    ).rows[0];
    if (!fee) throw stale();
    feeAfter = (
      await query<{ snapshot: CashTransactionSnapshot }>(
        `SELECT ${CASH_SNAPSHOT_SQL} AS snapshot FROM transactions t WHERE id=$1`,
        [fee.id],
      )
    ).rows[0].snapshot;
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
  const changed = await query(
    `UPDATE portfolio_import_staging_rows SET status='committed',committed_txn_id=$2,raw_data=$3
    WHERE id=$1 AND status='matched' AND raw_data=$4 RETURNING id`,
    [row.id, inserted.id, envelope, row.raw_data],
  );
  if (changed.rows.length !== 1) throw stale();
  await query(
    "UPDATE portfolio_import_batches SET rows_imported=rows_imported+1 WHERE id=$1",
    [row.batch_id],
  );
  return {
    after,
    ...(feeAfter ? { feeAfter } : {}),
    recordedCash: feeAfter ? 2 : 1,
  };
}
export async function readCashImagesForUpdate(
  ids: readonly number[],
): Promise<CashTransactionSnapshot[]> {
  return (
    await query<{ snapshot: CashTransactionSnapshot }>(
      `SELECT ${CASH_SNAPSHOT_SQL} AS snapshot FROM transactions t WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [ids],
    )
  ).rows.map((item) => item.snapshot);
}

// Categories and ordinary bank pairing can change after adoption. They do not
// weaken the immutable financial/provenance after-image used for restoration.
const IBKR_CASH_SNAPSHOT_SQL = `(${CASH_SNAPSHOT_SQL}) - ARRAY['category_id','is_transfer','transfer_source','transfer_peer_id']::text[]`;
export const __IBKR_CASH_SNAPSHOT_SQL = IBKR_CASH_SNAPSHOT_SQL;

/** IBKR_CASH_SNAPSHOT_SQL: the cash after-image without categorization/pairing. */
export type IbkrCashSnapshot = Omit<
  CashTransactionSnapshot,
  "category_id" | "is_transfer" | "transfer_source" | "transfer_peer_id"
>;
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
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter-specific batch config */
  custom_config: any;
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
  currency: string;
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
export interface IbkrCashReceipt {
  id: string;
  batch_id: string;
  staging_row_id: string;
  transaction_id: number;
  action: "adopt" | "restore";
  policy: string;
  previous_entry_id: string | null;
  before_data: IbkrCashEnvelope;
  after_data: IbkrCashEnvelope;
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
    await query<{ snapshot: CashTransactionSnapshot }>(
      `SELECT ${CASH_SNAPSHOT_SQL} AS snapshot FROM transactions t ORDER BY t.id`,
    )
  ).rows.map((item) => item.snapshot);
  const ids = (
    await query<{ id: string }>(`SELECT id FROM portfolio_import_batches
      WHERE custom_config::jsonb->>'format'='ibkr_transaction_history' ORDER BY id`)
  ).rows.map((item) => Number(item.id));
  const [sources, batches, receipts] = await Promise.all([
    ids.length ? readReconciliationSources(ids) : [],
    ids.length ? readReconciliationBatchScope(ids) : [],
    query<IbkrCashReceipt>(`SELECT a.* FROM portfolio_import_reconciliation_journal a
      WHERE a.action='adopt' AND a.after_data->>'ledgerKind'='cash'
        AND NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)
      ORDER BY a.id`),
  ]);
  return { ledger, sources, batches, receipts: receipts.rows };
}

export async function readIbkrCashImagesForUpdate(
  ids: readonly number[],
): Promise<IbkrCashSnapshot[]> {
  return (
    await query<{ snapshot: IbkrCashSnapshot }>(`SELECT ${IBKR_CASH_SNAPSHOT_SQL} AS snapshot FROM transactions t
      WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE`, [ids])
  ).rows.map((item) => item.snapshot);
}

/** Compare every financial and source field; preserve user categorization/pairs. */
export async function compareAndSetIbkrCashImage(
  before: IbkrCashFinancialImage,
  after: IbkrCashFinancialImage,
): Promise<IbkrCashSnapshot> {
  const result = await query<{ snapshot: IbkrCashSnapshot }>(`UPDATE transactions t SET
      amount=($2::jsonb->>'amount')::numeric, currency=$2::jsonb->>'currency',
      dedup_fingerprint=$2::jsonb->>'dedup_fingerprint',
      dedup_fingerprint_version=($2::jsonb->>'dedup_fingerprint_version')::smallint
    WHERE t.id=$1 AND ${IBKR_CASH_SNAPSHOT_SQL}=$3::jsonb
    RETURNING ${IBKR_CASH_SNAPSHOT_SQL} AS snapshot`,
  [before.id, JSON.stringify(after), JSON.stringify(before)]);
  if (result.rows.length !== 1) throw stale();
  return result.rows[0].snapshot;
}

async function assertIbkrSourceBindings(
  bindings: readonly IbkrCashSourceBinding[],
): Promise<void> {
  for (const binding of bindings) {
    const result = await query(`SELECT 1 FROM portfolio_import_staging_rows s
      JOIN portfolio_import_batches b ON b.id=s.batch_id
      WHERE s.id=$1 AND s.batch_id=$2
        AND (to_jsonb(s) - ARRAY['created_at','updated_at']::text[]) @> $3::jsonb
        AND b.account_id=$4 AND b.custom_config::jsonb=$5::jsonb FOR UPDATE OF s`,
    [binding.id, binding.batch_id, JSON.stringify(binding.staging), binding.account_id,
      JSON.stringify(binding.custom_config)]);
    if (result.rows.length !== 1) throw stale();
  }
}

async function settleIbkrNativeSource(
  row: ReconciliationSourceRow,
): Promise<void> {
  const changed = await query(`UPDATE portfolio_import_staging_rows SET
      status='duplicate',committed_txn_id=NULL,error_message=NULL
    WHERE id=$1 AND batch_id=$2 AND status=$3 RETURNING id`,
  [row.id, row.batch_id, row.status]);
  if (changed.rows.length !== 1) throw stale();
  const batch = await query(`UPDATE portfolio_import_batches SET
    rows_duplicate=rows_duplicate+1, rows_error=rows_error-CASE WHEN $2='error' THEN 1 ELSE 0 END
    WHERE id=$1 RETURNING id`, [row.batch_id, row.status]);
  if (batch.rows.length !== 1) throw stale();
}

export async function writeIbkrCashCorrection(
  action: IbkrCashCorrectionAction,
): Promise<{ receiptId: number; after: IbkrCashSnapshot; recordedCash: 0 }> {
  return withTransaction(async () => {
    await query("LOCK TABLE transactions IN SHARE ROW EXCLUSIVE MODE");
    await assertIbkrSourceBindings(action.sourceBindings);
    const after = await compareAndSetIbkrCashImage(action.before.snapshot, action.after.snapshot);
    const receipt = (await query<{ id: string }>(`INSERT INTO portfolio_import_reconciliation_journal
      (batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data)
      VALUES($1,$2,$3,'adopt','prefer_source',$4::jsonb,$5::jsonb) RETURNING id`,
    [action.row.batch_id, action.row.id, action.transactionId,
      JSON.stringify(action.before), JSON.stringify(action.after)])).rows[0];
    await settleIbkrNativeSource(action.row);
    return { receiptId: Number(receipt!.id), after, recordedCash: 0 as const };
  });
}

export async function writeIbkrCashCorrectionRepeat(
  action: IbkrCashCorrectionAction,
): Promise<{ recordedCash: 0 }> {
  return withTransaction(async () => {
    await query("LOCK TABLE transactions IN SHARE ROW EXCLUSIVE MODE");
    await assertIbkrSourceBindings(action.sourceBindings);
    const current = await query(`SELECT 1 FROM transactions t WHERE t.id=$1
      AND ${IBKR_CASH_SNAPSHOT_SQL}=$2::jsonb FOR UPDATE`,
    [action.transactionId, JSON.stringify(action.after.snapshot)]);
    const receipt = await query(`SELECT 1 FROM portfolio_import_reconciliation_journal a
      WHERE a.id=$1 AND a.action='adopt' AND a.after_data=$2::jsonb
        AND NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)`,
    [action.receiptId, JSON.stringify(action.after)]);
    if (current.rows.length !== 1 || receipt.rows.length !== 1) throw stale();
    await settleIbkrNativeSource(action.row);
    return { recordedCash: 0 as const };
  });
}

export async function writeIbkrCashRestoration(
  receipt: IbkrCashReceipt,
): Promise<IbkrCashSnapshot> {
  return withTransaction(async () => {
    await query("LOCK TABLE transactions IN SHARE ROW EXCLUSIVE MODE");
    const active = await query(`SELECT 1 FROM portfolio_import_reconciliation_journal a
      WHERE a.id=$1 AND a.action='adopt' AND a.before_data=$2::jsonb AND a.after_data=$3::jsonb
        AND NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)`,
    [receipt.id, JSON.stringify(receipt.before_data), JSON.stringify(receipt.after_data)]);
    if (active.rows.length !== 1) throw stale();
    if (!Array.isArray(receipt.after_data.proof?.sourceBindings) || ![2, 3].includes(receipt.after_data.proof.sourceBindings.length)) throw stale();
    await assertIbkrSourceBindings(receipt.after_data.proof.sourceBindings);
    const after = await compareAndSetIbkrCashImage(receipt.after_data.snapshot, receipt.before_data.snapshot);
    await query(`INSERT INTO portfolio_import_reconciliation_journal
      (batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data,previous_entry_id)
      VALUES($1,$2,$3,'restore','prefer_source',$4::jsonb,$5::jsonb,$6)`,
    [receipt.batch_id, receipt.staging_row_id, receipt.transaction_id,
      JSON.stringify(receipt.after_data), JSON.stringify(receipt.before_data), receipt.id]);
    return after;
  });
}

/** An original import cannot delete a cash record adopted by another batch. */
export async function guardOriginalIbkrCashRollback(
  batchId: number,
): Promise<void> {
  const active = await query(`SELECT 1 FROM portfolio_import_reconciliation_journal a
    WHERE a.action='adopt' AND a.after_data->>'ledgerKind'='cash'
      AND ((a.after_data->'proof'->'original'->>'batchId')::bigint=$1
        OR (a.after_data->'proof'->'primaryReference'->>'batchId')::bigint=$1)
      AND NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)
    LIMIT 1`, [batchId]);
  if (active.rows.length) throw stale();
}
