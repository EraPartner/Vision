/** Read and restore duplicate repairs applied before ADR-236. */
import { requireRow } from "../database/rowContracts.ts";
import { sql } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { Json } from "../database/schema.generated.ts";
import {
  bigintIdRowSchema,
  duplicateRepairJournalRowSchema,
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

export type {
  DuplicateRepairJournalRow,
  DuplicateRepairState,
  RepairBatchSnapshot,
  RepairStagingSnapshot,
  RepairTransactionSnapshot,
};

type Id = number | string;

const FULL_TRANSACTION = sql<RepairTransactionSnapshot>`${sql.raw(PORTFOLIO_TRANSACTION_SNAPSHOT_SQL)} || jsonb_build_object('created_at',pt.created_at::text,'updated_at',pt.updated_at::text)`;
const STAGING = sql<RepairStagingSnapshot>`to_jsonb(s) || jsonb_build_object('id',s.id::text,'batch_id',s.batch_id::text,
  'units',s.units::text,'price_per_unit',s.price_per_unit::text,'amount',s.amount::text,
  'fees',s.fees::text,'taxes',s.taxes::text,'fx_rate_to_eur',s.fx_rate_to_eur::text)`;
const BATCH = sql<RepairBatchSnapshot>`to_jsonb(b) || jsonb_build_object('id',b.id::text,'source_size_bytes',b.source_size_bytes::text)`;
const jsonb = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;
const anyBigint = (ids: readonly Id[]) => sql<string>`ANY(${ids}::bigint[])`;

export async function readFullRepairTransaction(
  id: Id,
): Promise<RepairTransactionSnapshot | undefined> {
  return (
    await checkedRow(
      repairTransactionSnapshotRowSchema,
      sql`SELECT ${FULL_TRANSACTION} AS snapshot FROM portfolio_transactions pt WHERE pt.id=${id}`,
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
    await checkedRow(
      repairBatchSnapshotRowSchema,
      db
        .selectFrom("portfolio_import_batches as b")
        .select(BATCH.as("snapshot"))
        .where("b.id", "=", String(originalBatchId)),
    )
  )?.snapshot;
  const originalStaging = (
    await checkedRows(
      repairStagingSnapshotRowSchema,
      sql`SELECT ${STAGING} AS snapshot FROM portfolio_import_staging_rows s WHERE s.batch_id=${originalBatchId} AND s.committed_txn_id=${importedId} AND s.route IS DISTINCT FROM 'cash' ORDER BY s.id`,
    )
  ).map((row) => row.snapshot);
  return { originalBatch, originalStaging };
}

export async function readRepairStagingByIds(
  snapshots: readonly { id: Id }[],
): Promise<RepairStagingSnapshot[]> {
  return (
    await checkedRows(
      repairStagingSnapshotRowSchema,
      db
        .selectFrom("portfolio_import_staging_rows as s")
        .select(STAGING.as("snapshot"))
        .where("s.id", "=", anyBigint(snapshots.map((row) => row.id)))
        .orderBy("s.id"),
    )
  ).map((row) => row.snapshot);
}

export async function replaceRepairStaging(
  before: RepairStagingSnapshot,
  after: RepairStagingSnapshot,
): Promise<RepairStagingSnapshot | undefined> {
  return (
    await checkedRow(
      repairStagingSnapshotRowSchema,
      sql`UPDATE portfolio_import_staging_rows s SET status=${jsonb(after)}->>'status',committed_txn_id=(${jsonb(after)}->>'committed_txn_id')::integer
    WHERE s.id=${before.id} AND (${STAGING}) - 'updated_at' = ${jsonb(before)} - 'updated_at' RETURNING ${STAGING} AS snapshot`,
    )
  )?.snapshot;
}

export async function replaceRepairBatch(
  before: RepairBatchSnapshot,
  after: RepairBatchSnapshot,
): Promise<RepairBatchSnapshot | undefined> {
  return (
    await checkedRow(
      repairBatchSnapshotRowSchema,
      sql`UPDATE portfolio_import_batches b SET rows_imported=(${jsonb(after)}->>'rows_imported')::integer,rows_duplicate=(${jsonb(after)}->>'rows_duplicate')::integer
    WHERE b.id=${before.id} AND ${BATCH}=${jsonb(before)} RETURNING ${BATCH} AS snapshot`,
    )
  )?.snapshot;
}

export async function restoreExactImportedCopy(
  imported: RepairTransactionSnapshot | null,
): Promise<boolean> {
  const image = jsonb(imported);
  const result = await sql`INSERT INTO portfolio_transactions SELECT restored.* FROM jsonb_populate_record(NULL::portfolio_transactions,${image} || jsonb_build_object('income_recognition_role',COALESCE(${image}->>'income_recognition_role','standard'))) restored ON CONFLICT DO NOTHING RETURNING id`.execute(
    db,
  );
  return result.rows.length === 1;
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
  previousEntryId,
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
  const [inserted] = await checkedRows(
    bigintIdRowSchema,
    db
      .insertInto("portfolio_import_duplicate_repair_journal")
      .values({
        batch_id: batchId,
        staging_row_id: stagingRowId,
        original_import_batch_id: originalBatchId,
        legacy_transaction_id: legacyId,
        imported_transaction_id: importedId,
        action,
        policy,
        before_data: jsonb(before),
        after_data: jsonb(after),
        previous_entry_id: previousEntryId ?? null,
      })
      .returning("id"),
  );
  // INSERT ... RETURNING without ON CONFLICT yields exactly one row.
  return Number(requireRow(inserted, "duplicate repair receipt insert").id);
}

export async function getActiveDuplicateRepairReceipts(
  batchId: Id,
): Promise<DuplicateRepairJournalRow[]> {
  return checkedRows(
    duplicateRepairJournalRowSchema,
    db
      .selectFrom("portfolio_import_duplicate_repair_journal as a")
      .selectAll("a")
      .where("a.batch_id", "=", String(batchId))
      .where("a.action", "=", "repair")
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("portfolio_import_duplicate_repair_journal as r")
              .select(sql`1`.as("one"))
              .whereRef("r.previous_entry_id", "=", "a.id"),
          ),
        ),
      )
      .orderBy("a.id", "desc"),
  );
}
