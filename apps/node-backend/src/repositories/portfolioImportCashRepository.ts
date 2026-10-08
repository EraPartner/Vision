/** Source-owned cash inserts, full after-images and guarded rollback. */
import { query } from "../database/connection.ts";
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
