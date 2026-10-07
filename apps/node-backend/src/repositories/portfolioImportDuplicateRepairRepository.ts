import { query } from "../database/connection.ts";
import { PORTFOLIO_TRANSACTION_SNAPSHOT_SQL } from "./portfolioImportReconciliationRepository.ts";
import type {
  PortfolioTransactionSnapshot,
  ReconciliationHistoryEvent,
} from "./portfolioImportReconciliationRepository.ts";

type Id = number | string;

/** FULL_TRANSACTION: the reconciliation snapshot plus its timestamps as text. */
export type RepairTransactionSnapshot = PortfolioTransactionSnapshot & {
  created_at: string;
  updated_at: string;
};

/** STAGING: `to_jsonb(s)` with BIGINT ids and NUMERIC columns as exact text. */
export type RepairStagingSnapshot = {
  id: string;
  batch_id: string;
  row_index: number;
  status: string;
  /** 'YYYY-MM-DD' */
  tx_date: string | null;
  type_raw: string | null;
  type: string | null;
  route: string | null;
  symbol_raw: string | null;
  name_raw: string | null;
  units: string | null;
  price_per_unit: string | null;
  amount: string | null;
  fees: string | null;
  taxes: string | null;
  currency: string | null;
  fx_rate_to_eur: string | null;
  note: string | null;
  raw_data: string | null;
  source_transaction_id: string | null;
  source_account_identity: string | null;
  source_record_hash: string | null;
  dedup_fingerprint: string | null;
  dedup_fingerprint_version: number | null;
  dedup_occurrence: number | null;
  resolved_investment_id: number | null;
  user_override_investment_id: number | null;
  match_source: string | null;
  match_similarity: number | null;
  committed_txn_id: number | null;
  error_message: string | null;
  asset_transfer_details: unknown;
  asset_adjustment_details: unknown;
  created_at: string;
  updated_at: string;
};

/** BATCH: `to_jsonb(b)` with BIGINT columns as text. */
export type RepairBatchSnapshot = {
  id: string;
  adapter_name: string;
  source_filename: string | null;
  source_size_bytes: string | null;
  custom_config: unknown;
  default_asset_class: string | null;
  default_type: string | null;
  status: string;
  rows_total: number;
  rows_imported: number;
  rows_duplicate: number;
  rows_error: number;
  error_summary: string | null;
  started_at: string;
  completed_at: string | null;
  account_id: number | null;
  is_brokerage: boolean;
};

export type DuplicateRepairState = {
  legacy: RepairTransactionSnapshot;
  imported: RepairTransactionSnapshot | null;
  originalBatch: RepairBatchSnapshot;
  originalStaging: RepairStagingSnapshot[];
};

export type DuplicateRepairJournalRow = {
  id: string;
  batch_id: string;
  staging_row_id: string;
  original_import_batch_id: string;
  legacy_transaction_id: number;
  imported_transaction_id: number;
  action: "repair" | "restore";
  policy: "preserve_existing" | "prefer_source";
  before_data: DuplicateRepairState;
  after_data: DuplicateRepairState;
  previous_entry_id: string | null;
  created_at: Date;
};

const FULL_TRANSACTION = `${PORTFOLIO_TRANSACTION_SNAPSHOT_SQL} || jsonb_build_object('created_at',pt.created_at::text,'updated_at',pt.updated_at::text)`;
const STAGING = `to_jsonb(s) || jsonb_build_object('id',s.id::text,'batch_id',s.batch_id::text,
  'units',s.units::text,'price_per_unit',s.price_per_unit::text,'amount',s.amount::text,
  'fees',s.fees::text,'taxes',s.taxes::text,'fx_rate_to_eur',s.fx_rate_to_eur::text)`;
const BATCH = `to_jsonb(b) || jsonb_build_object('id',b.id::text,'source_size_bytes',b.source_size_bytes::text)`;

export async function readDuplicateRepairContext(
  history: readonly ReconciliationHistoryEvent[],
): Promise<{
  transactions: RepairTransactionSnapshot[];
  batches: RepairBatchSnapshot[];
  staging: RepairStagingSnapshot[];
  knownTransactionIds: number[];
}> {
  const transactionIds = history
    .filter((row) => row.type !== "asset_transfer")
    .map((row) => Number(row.id));
  const batchIds = [
    ...new Set(
      history.map((row) => Number(row.import_batch_id)).filter(Boolean),
    ),
  ];
  const transactions = transactionIds.length
    ? (
        await query<{ snapshot: RepairTransactionSnapshot }>(
          `SELECT ${FULL_TRANSACTION} AS snapshot FROM portfolio_transactions pt WHERE pt.id=ANY($1::integer[]) ORDER BY pt.id`,
          [transactionIds],
        )
      ).rows.map((row) => row.snapshot)
    : [];
  const batches = batchIds.length
    ? (
        await query<{ snapshot: RepairBatchSnapshot }>(
          `SELECT ${BATCH} AS snapshot FROM portfolio_import_batches b WHERE b.id=ANY($1::bigint[]) ORDER BY b.id`,
          [batchIds],
        )
      ).rows.map((row) => row.snapshot)
    : [];
  const staging = batchIds.length
    ? (
        await query<{ snapshot: RepairStagingSnapshot }>(
          `SELECT ${STAGING} AS snapshot FROM portfolio_import_staging_rows s WHERE s.batch_id=ANY($1::bigint[]) ORDER BY s.id`,
          [batchIds],
        )
      ).rows.map((row) => row.snapshot)
    : [];
  const known = transactionIds.length
    ? (
        await query<{ id: number }>(
          `SELECT a.transaction_id AS id FROM portfolio_import_reconciliation_journal a WHERE a.action='adopt' AND a.transaction_id=ANY($1::integer[]) AND NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)
    UNION SELECT a.legacy_transaction_id AS id FROM portfolio_import_duplicate_repair_journal a WHERE a.action='repair' AND a.legacy_transaction_id=ANY($1::integer[]) AND NOT EXISTS(SELECT 1 FROM portfolio_import_duplicate_repair_journal r WHERE r.previous_entry_id=a.id)`,
          [transactionIds],
        )
      ).rows.map((row) => Number(row.id))
    : [];
  return {
    transactions,
    batches,
    staging,
    knownTransactionIds: known.sort((a, b) => a - b),
  };
}

export async function readFullRepairTransaction(
  id: Id,
): Promise<RepairTransactionSnapshot | undefined> {
  return (
    await query<{ snapshot: RepairTransactionSnapshot }>(
      `SELECT ${FULL_TRANSACTION} AS snapshot FROM portfolio_transactions pt WHERE pt.id=$1`,
      [id],
    )
  ).rows[0]?.snapshot;
}

export async function readOriginalRepairState(
  originalBatchId: Id,
  importedId: Id,
): Promise<{
  originalBatch: RepairBatchSnapshot | undefined;
  originalStaging: RepairStagingSnapshot[];
}> {
  const originalBatch = (
    await query<{ snapshot: RepairBatchSnapshot }>(
      `SELECT ${BATCH} AS snapshot FROM portfolio_import_batches b WHERE b.id=$1`,
      [originalBatchId],
    )
  ).rows[0]?.snapshot;
  const originalStaging = (
    await query<{ snapshot: RepairStagingSnapshot }>(
      `SELECT ${STAGING} AS snapshot FROM portfolio_import_staging_rows s WHERE s.batch_id=$1 AND s.committed_txn_id=$2 AND s.route IS DISTINCT FROM 'cash' ORDER BY s.id`,
      [originalBatchId, importedId],
    )
  ).rows.map((row) => row.snapshot);
  return { originalBatch, originalStaging };
}

export async function readRepairStagingByIds(
  snapshots: readonly { id: Id }[],
): Promise<RepairStagingSnapshot[]> {
  return (
    await query<{ snapshot: RepairStagingSnapshot }>(
      `SELECT ${STAGING} AS snapshot FROM portfolio_import_staging_rows s WHERE s.id=ANY($1::bigint[]) ORDER BY s.id`,
      [snapshots.map((row) => row.id)],
    )
  ).rows.map((row) => row.snapshot);
}

export async function deleteExactImportedCopy(
  imported: RepairTransactionSnapshot,
): Promise<boolean> {
  return (
    (
      await query(
        `DELETE FROM portfolio_transactions pt WHERE pt.id=$1 AND ${FULL_TRANSACTION}=$2::jsonb RETURNING pt.id`,
        [imported.id, JSON.stringify(imported)],
      )
    ).rows.length === 1
  );
}

export async function replaceRepairStaging(
  before: RepairStagingSnapshot,
  after: RepairStagingSnapshot,
): Promise<RepairStagingSnapshot | undefined> {
  return (
    await query<{ snapshot: RepairStagingSnapshot }>(
      `UPDATE portfolio_import_staging_rows s SET status=$2::jsonb->>'status',committed_txn_id=($2::jsonb->>'committed_txn_id')::integer
    WHERE s.id=$1 AND (${STAGING}) - 'updated_at' = $3::jsonb - 'updated_at' RETURNING ${STAGING} AS snapshot`,
      [before.id, JSON.stringify(after), JSON.stringify(before)],
    )
  ).rows[0]?.snapshot;
}

export async function replaceRepairBatch(
  before: RepairBatchSnapshot,
  after: RepairBatchSnapshot,
): Promise<RepairBatchSnapshot | undefined> {
  return (
    await query<{ snapshot: RepairBatchSnapshot }>(
      `UPDATE portfolio_import_batches b SET rows_imported=($2::jsonb->>'rows_imported')::integer,rows_duplicate=($2::jsonb->>'rows_duplicate')::integer
    WHERE b.id=$1 AND ${BATCH}=$3::jsonb RETURNING ${BATCH} AS snapshot`,
      [before.id, JSON.stringify(after), JSON.stringify(before)],
    )
  ).rows[0]?.snapshot;
}

export async function restoreExactImportedCopy(
  imported: RepairTransactionSnapshot | null,
): Promise<boolean> {
  return (
    (
      await query(
        `INSERT INTO portfolio_transactions SELECT restored.* FROM jsonb_populate_record(NULL::portfolio_transactions,$1::jsonb) restored ON CONFLICT DO NOTHING RETURNING id`,
        [JSON.stringify(imported)],
      )
    ).rows.length === 1
  );
}

export async function insertDuplicateRepairReceipt({
  batchId,
  stagingRowId,
  originalBatchId,
  legacyId,
  importedId,
  action,
  policy,
  before,
  after,
  previousEntryId = undefined,
}: {
  batchId: Id;
  stagingRowId: Id;
  originalBatchId: Id;
  legacyId: number;
  importedId: number;
  action: DuplicateRepairJournalRow["action"];
  policy: DuplicateRepairJournalRow["policy"];
  before: DuplicateRepairState;
  after: DuplicateRepairState;
  previousEntryId?: Id | null;
}): Promise<number> {
  return Number(
    (
      await query<{ id: string }>(
        `INSERT INTO portfolio_import_duplicate_repair_journal(batch_id,staging_row_id,original_import_batch_id,legacy_transaction_id,imported_transaction_id,action,policy,before_data,after_data,previous_entry_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING id`,
        [
          batchId,
          stagingRowId,
          originalBatchId,
          legacyId,
          importedId,
          action,
          policy,
          JSON.stringify(before),
          JSON.stringify(after),
          previousEntryId ?? null,
        ],
      )
    ).rows[0].id,
  );
}

export async function getActiveDuplicateRepairReceipts(
  batchId: Id,
): Promise<DuplicateRepairJournalRow[]> {
  return (
    await query<DuplicateRepairJournalRow>(
      `SELECT a.* FROM portfolio_import_duplicate_repair_journal a WHERE a.batch_id=$1 AND a.action='repair' AND NOT EXISTS(SELECT 1 FROM portfolio_import_duplicate_repair_journal r WHERE r.previous_entry_id=a.id) ORDER BY a.id DESC`,
      [batchId],
    )
  ).rows;
}
