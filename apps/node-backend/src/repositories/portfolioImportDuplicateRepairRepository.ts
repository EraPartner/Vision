import { query } from "../database/connection.ts";
import { checkRows, queryOne, queryRows } from "../database/rowContracts.ts";
import {
  bigintIdRowSchema,
  duplicateRepairJournalRowSchema,
  intIdRowSchema,
  repairBatchSnapshotRowSchema,
  repairStagingSnapshotRowSchema,
  repairTransactionSnapshotRowSchema,
} from "../database/rows/portfolioImport.ts";
import type {
  DuplicateRepairJournalRow,
  DuplicateRepairState,
  RepairBatchSnapshot,
  RepairStagingSnapshot,
  RepairTransactionSnapshot,
} from "../database/rows/portfolioImport.ts";
import { PORTFOLIO_TRANSACTION_SNAPSHOT_SQL } from "./portfolioImportReconciliationRepository.ts";
import type { ReconciliationHistoryEvent } from "./portfolioImportReconciliationRepository.ts";

export type {
  DuplicateRepairJournalRow,
  DuplicateRepairState,
  RepairBatchSnapshot,
  RepairStagingSnapshot,
  RepairTransactionSnapshot,
};

type Id = number | string;

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
        await queryRows(
          repairTransactionSnapshotRowSchema,
          `SELECT ${FULL_TRANSACTION} AS snapshot FROM portfolio_transactions pt WHERE pt.id=ANY($1::integer[]) ORDER BY pt.id`,
          [transactionIds],
        )
      ).map((row) => row.snapshot)
    : [];
  const batches = batchIds.length
    ? (
        await queryRows(
          repairBatchSnapshotRowSchema,
          `SELECT ${BATCH} AS snapshot FROM portfolio_import_batches b WHERE b.id=ANY($1::bigint[]) ORDER BY b.id`,
          [batchIds],
        )
      ).map((row) => row.snapshot)
    : [];
  const staging = batchIds.length
    ? (
        await queryRows(
          repairStagingSnapshotRowSchema,
          `SELECT ${STAGING} AS snapshot FROM portfolio_import_staging_rows s WHERE s.batch_id=ANY($1::bigint[]) ORDER BY s.id`,
          [batchIds],
        )
      ).map((row) => row.snapshot)
    : [];
  const known = transactionIds.length
    ? (
        await queryRows(
          intIdRowSchema,
          `SELECT a.transaction_id AS id FROM portfolio_import_reconciliation_journal a WHERE a.action='adopt' AND a.transaction_id=ANY($1::integer[]) AND NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)
    UNION SELECT a.legacy_transaction_id AS id FROM portfolio_import_duplicate_repair_journal a WHERE a.action='repair' AND a.legacy_transaction_id=ANY($1::integer[]) AND NOT EXISTS(SELECT 1 FROM portfolio_import_duplicate_repair_journal r WHERE r.previous_entry_id=a.id)`,
          [transactionIds],
        )
      ).map((row) => Number(row.id))
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
    await queryOne(
      repairTransactionSnapshotRowSchema,
      `SELECT ${FULL_TRANSACTION} AS snapshot FROM portfolio_transactions pt WHERE pt.id=$1`,
      [id],
    )
  )?.snapshot;
}

export async function readOriginalRepairState(
  originalBatchId: Id,
  importedId: Id,
): Promise<{
  originalBatch: RepairBatchSnapshot | undefined;
  originalStaging: RepairStagingSnapshot[];
}> {
  const originalBatch = (
    await queryOne(
      repairBatchSnapshotRowSchema,
      `SELECT ${BATCH} AS snapshot FROM portfolio_import_batches b WHERE b.id=$1`,
      [originalBatchId],
    )
  )?.snapshot;
  const originalStaging = (
    await queryRows(
      repairStagingSnapshotRowSchema,
      `SELECT ${STAGING} AS snapshot FROM portfolio_import_staging_rows s WHERE s.batch_id=$1 AND s.committed_txn_id=$2 AND s.route IS DISTINCT FROM 'cash' ORDER BY s.id`,
      [originalBatchId, importedId],
    )
  ).map((row) => row.snapshot);
  return { originalBatch, originalStaging };
}

export async function readRepairStagingByIds(
  snapshots: readonly { id: Id }[],
): Promise<RepairStagingSnapshot[]> {
  return (
    await queryRows(
      repairStagingSnapshotRowSchema,
      `SELECT ${STAGING} AS snapshot FROM portfolio_import_staging_rows s WHERE s.id=ANY($1::bigint[]) ORDER BY s.id`,
      [snapshots.map((row) => row.id)],
    )
  ).map((row) => row.snapshot);
}

export async function deleteExactImportedCopy(
  imported: RepairTransactionSnapshot,
): Promise<boolean> {
  return (
    (
      await query(
        `DELETE FROM portfolio_transactions pt WHERE pt.id=$1 AND ${FULL_TRANSACTION}=normalize_portfolio_income_snapshot($2::jsonb) RETURNING pt.id`,
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
    await queryOne(
      repairStagingSnapshotRowSchema,
      `UPDATE portfolio_import_staging_rows s SET status=$2::jsonb->>'status',committed_txn_id=($2::jsonb->>'committed_txn_id')::integer
    WHERE s.id=$1 AND (${STAGING}) - 'updated_at' = $3::jsonb - 'updated_at' RETURNING ${STAGING} AS snapshot`,
      [before.id, JSON.stringify(after), JSON.stringify(before)],
    )
  )?.snapshot;
}

export async function replaceRepairBatch(
  before: RepairBatchSnapshot,
  after: RepairBatchSnapshot,
): Promise<RepairBatchSnapshot | undefined> {
  return (
    await queryOne(
      repairBatchSnapshotRowSchema,
      `UPDATE portfolio_import_batches b SET rows_imported=($2::jsonb->>'rows_imported')::integer,rows_duplicate=($2::jsonb->>'rows_duplicate')::integer
    WHERE b.id=$1 AND ${BATCH}=$3::jsonb RETURNING ${BATCH} AS snapshot`,
      [before.id, JSON.stringify(after), JSON.stringify(before)],
    )
  )?.snapshot;
}

export async function restoreExactImportedCopy(
  imported: RepairTransactionSnapshot | null,
): Promise<boolean> {
  return (
    (
      await query(
        `INSERT INTO portfolio_transactions SELECT restored.* FROM jsonb_populate_record(NULL::portfolio_transactions,$1::jsonb || jsonb_build_object('income_recognition_role',COALESCE($1::jsonb->>'income_recognition_role','standard'))) restored ON CONFLICT DO NOTHING RETURNING id`,
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
  const result = await query(
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
  );
  const [inserted] = checkRows(bigintIdRowSchema, result.rows);
  // INSERT ... RETURNING without ON CONFLICT yields exactly one row.
  return Number(inserted!.id);
}

export async function getActiveDuplicateRepairReceipts(
  batchId: Id,
): Promise<DuplicateRepairJournalRow[]> {
  return queryRows(
    duplicateRepairJournalRowSchema,
    `SELECT a.* FROM portfolio_import_duplicate_repair_journal a WHERE a.batch_id=$1 AND a.action='repair' AND NOT EXISTS(SELECT 1 FROM portfolio_import_duplicate_repair_journal r WHERE r.previous_entry_id=a.id) ORDER BY a.id DESC`,
    [batchId],
  );
}
