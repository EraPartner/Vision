/**
 * Read and restore duplicate repairs applied before ADR-236.
 *
 * The repair images are canonical jsonb text built in SQL (ADR-263): the
 * portfolio transaction snapshot of schemaFunctions.ts plus its timestamps,
 * and the full staging and batch rows (PostgreSQL's `to_jsonb(row)`) with
 * BIGINT and NUMERIC columns as exact text. Timestamps are Vision's canonical
 * UTC text. Receipts that PostgreSQL wrote hold its timestamp text in the
 * session's zone instead; {@link getActiveDuplicateRepairReceipts} reads them
 * back in the canonical form, so a current image and its receipt compare
 * equal whatever zone the receipt was written in.
 */
import { requireRow } from "../database/rowContracts.ts";
import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import { canonicalTimestamp } from "../database/sqlite/timestamps.ts";
import { portfolioIncomeTransactionSnapshotSql } from "../database/sqlite/schemaFunctions.ts";
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

export type {
  DuplicateRepairJournalRow,
  DuplicateRepairState,
  RepairBatchSnapshot,
  RepairStagingSnapshot,
  RepairTransactionSnapshot,
};

type Id = number | string;

/** The reconciliation snapshot of transaction `alias` plus its timestamps. */
const fullTransaction = (alias: string) =>
  sql.raw<RepairTransactionSnapshot>(
    `vision_jsonb(json_set(${portfolioIncomeTransactionSnapshotSql(alias)},
      '$.created_at', ${alias}.created_at, '$.updated_at', ${alias}.updated_at))`,
  );

/** REAL as PostgreSQL's float output: a whole value without a fraction. */
const real = (column: string) =>
  `CASE WHEN ${column} = CAST(${column} AS INTEGER) THEN CAST(${column} AS INTEGER) ELSE ${column} END`;

/** `to_jsonb(s)` of staging row `alias`, BIGINT and NUMERIC columns as text. */
const staging = (alias: string) =>
  sql.raw<RepairStagingSnapshot>(`vision_jsonb(json_object(
    'id', CAST(${alias}.id AS TEXT), 'batch_id', CAST(${alias}.batch_id AS TEXT),
    'row_index', ${alias}.row_index, 'status', ${alias}.status,
    'tx_date', ${alias}.tx_date, 'type_raw', ${alias}.type_raw, 'type', ${alias}.type,
    'symbol_raw', ${alias}.symbol_raw, 'name_raw', ${alias}.name_raw,
    'units', ${alias}.units, 'price_per_unit', ${alias}.price_per_unit,
    'amount', ${alias}.amount, 'fees', ${alias}.fees, 'taxes', ${alias}.taxes,
    'currency', ${alias}.currency, 'fx_rate_to_eur', ${alias}.fx_rate_to_eur,
    'note', ${alias}.note, 'raw_data', ${alias}.raw_data,
    'resolved_investment_id', ${alias}.resolved_investment_id,
    'user_override_investment_id', ${alias}.user_override_investment_id,
    'match_source', ${alias}.match_source,
    'match_similarity', ${real(`${alias}.match_similarity`)},
    'committed_txn_id', ${alias}.committed_txn_id,
    'error_message', ${alias}.error_message,
    'created_at', ${alias}.created_at, 'route', ${alias}.route,
    'updated_at', ${alias}.updated_at,
    'source_transaction_id', ${alias}.source_transaction_id,
    'source_account_identity', ${alias}.source_account_identity,
    'dedup_occurrence', ${alias}.dedup_occurrence,
    'source_record_hash', ${alias}.source_record_hash,
    'dedup_fingerprint', ${alias}.dedup_fingerprint,
    'dedup_fingerprint_version', ${alias}.dedup_fingerprint_version,
    'asset_transfer_details', json(${alias}.asset_transfer_details),
    'asset_adjustment_details', json(${alias}.asset_adjustment_details)))`);

/** `to_jsonb(b)` of batch row `alias`, BIGINT columns as text. */
const batch = (alias: string) =>
  sql.raw<RepairBatchSnapshot>(`vision_jsonb(json_object(
    'id', CAST(${alias}.id AS TEXT), 'adapter_name', ${alias}.adapter_name,
    'source_filename', ${alias}.source_filename,
    'source_size_bytes', CAST(${alias}.source_size_bytes AS TEXT),
    'custom_config', json(${alias}.custom_config),
    'default_asset_class', ${alias}.default_asset_class,
    'default_type', ${alias}.default_type, 'status', ${alias}.status,
    'rows_total', ${alias}.rows_total, 'rows_imported', ${alias}.rows_imported,
    'rows_duplicate', ${alias}.rows_duplicate, 'rows_error', ${alias}.rows_error,
    'error_summary', ${alias}.error_summary, 'started_at', ${alias}.started_at,
    'completed_at', ${alias}.completed_at, 'account_id', ${alias}.account_id,
    'is_brokerage', json(iif(${alias}.is_brokerage, 'true', 'false'))))`);

/** A JSON array parameter for `IN (SELECT value FROM json_each(?))`. */
const inIds = (ids: readonly Id[]) =>
  sql`(SELECT value FROM json_each(${JSON.stringify(ids.map(Number))}))`;

export async function readFullRepairTransaction(
  id: Id,
): Promise<RepairTransactionSnapshot | undefined> {
  return (
    await checkedRow(
      repairTransactionSnapshotRowSchema,
      sql`SELECT ${fullTransaction("pt")} AS "snapshot::json" FROM portfolio_transactions pt WHERE pt.id=${id}`,
    )
  )?.snapshot;
}

async function readRepairBatch(
  batchId: Id,
): Promise<RepairBatchSnapshot | undefined> {
  return (
    await checkedRow(
      repairBatchSnapshotRowSchema,
      sql`SELECT ${batch("b")} AS "snapshot::json" FROM portfolio_import_batches b WHERE b.id=${batchId}`,
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
  const originalBatch = await readRepairBatch(originalBatchId);
  const originalStaging = (
    await checkedRows(
      repairStagingSnapshotRowSchema,
      sql`SELECT ${staging("s")} AS "snapshot::json" FROM portfolio_import_staging_rows s WHERE s.batch_id=${originalBatchId} AND s.committed_txn_id=${importedId} AND s.route IS NOT 'cash' ORDER BY s.id`,
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
      sql`SELECT ${staging("s")} AS "snapshot::json" FROM portfolio_import_staging_rows s
           WHERE s.id IN ${inIds(snapshots.map((row) => row.id))} ORDER BY s.id`,
    )
  ).map((row) => row.snapshot);
}

/**
 * Write `after`'s status and pointer over the staging row only while it still
 * equals `before` apart from updated_at; the read-back carries the new
 * updated_at the trigger stamps, as PostgreSQL's RETURNING did.
 */
export async function replaceRepairStaging(
  before: RepairStagingSnapshot,
  after: RepairStagingSnapshot,
): Promise<RepairStagingSnapshot | undefined> {
  const image = JSON.stringify(after);
  return withTransaction(async () => {
    // SQLite 3.39 has no UPDATE target alias: the image names the table.
    const result = await sql`UPDATE portfolio_import_staging_rows
         SET status = ${image} ->> 'status',
             committed_txn_id = CAST(${image} ->> 'committed_txn_id' AS INTEGER)
       WHERE portfolio_import_staging_rows.id = ${before.id}
         AND vision_jsonb(json_remove(${staging("portfolio_import_staging_rows")}, '$.updated_at'))
           = vision_jsonb(json_remove(vision_jsonb(${JSON.stringify(before)}), '$.updated_at'))`.execute(
      db,
    );
    if (Number(result.numAffectedRows ?? 0) !== 1) return undefined;
    const [restored] = await readRepairStagingByIds([before]);
    return restored;
  });
}

/** Write `after`'s counters over the batch only while it still equals `before`. */
export async function replaceRepairBatch(
  before: RepairBatchSnapshot,
  after: RepairBatchSnapshot,
): Promise<RepairBatchSnapshot | undefined> {
  const image = JSON.stringify(after);
  return withTransaction(async () => {
    const result = await sql`UPDATE portfolio_import_batches
         SET rows_imported = CAST(${image} ->> 'rows_imported' AS INTEGER),
             rows_duplicate = CAST(${image} ->> 'rows_duplicate' AS INTEGER)
       WHERE portfolio_import_batches.id = ${before.id}
         AND ${batch("portfolio_import_batches")} = vision_jsonb(${JSON.stringify(before)})`.execute(
      db,
    );
    if (Number(result.numAffectedRows ?? 0) !== 1) return undefined;
    return readRepairBatch(before.id);
  });
}

/**
 * Re-insert the exact imported copy a repair deleted, from its full image
 * (PostgreSQL's jsonb_populate_record): every column from the image, a
 * missing key as NULL, the income role 'standard' when the image predates it.
 * @returns false when its id or identity is taken again
 */
export async function restoreExactImportedCopy(
  imported: RepairTransactionSnapshot | null,
): Promise<boolean> {
  const image = JSON.stringify(imported);
  const result = await sql`INSERT INTO portfolio_transactions
      (id, investment_id, type, date, amount, units, price_per_unit, fees, taxes,
       currency, fx_rate_to_eur, note, is_recurring, recurrence_interval,
       recurrence_end_date, created_at, updated_at, account_id, import_batch_id,
       dividend_amount_convention, source_record_hash, dedup_fingerprint,
       dedup_fingerprint_version, income_recognition_role)
    SELECT CAST(j ->> 'id' AS INTEGER), CAST(j ->> 'investment_id' AS INTEGER),
           j ->> 'type', j ->> 'date',
           vision_numeric(j ->> 'amount', 18, 4), vision_numeric(j ->> 'units', 18, 8),
           vision_numeric(j ->> 'price_per_unit', 18, 6),
           vision_numeric(j ->> 'fees', 18, 4), vision_numeric(j ->> 'taxes', 18, 4),
           j ->> 'currency', vision_numeric(j ->> 'fx_rate_to_eur', 20, 10),
           j ->> 'note', j ->> 'is_recurring', j ->> 'recurrence_interval',
           j ->> 'recurrence_end_date', vision_ts(j ->> 'created_at'),
           vision_ts(j ->> 'updated_at'), CAST(j ->> 'account_id' AS INTEGER),
           CAST(j ->> 'import_batch_id' AS INTEGER), j ->> 'dividend_amount_convention',
           j ->> 'source_record_hash', j ->> 'dedup_fingerprint',
           CAST(j ->> 'dedup_fingerprint_version' AS INTEGER),
           COALESCE(j ->> 'income_recognition_role', 'standard')
      FROM (SELECT ${image} AS j) restored
     WHERE true
    ON CONFLICT DO NOTHING RETURNING id`.execute(db);
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
        before_data: JSON.stringify(before),
        after_data: JSON.stringify(after),
        previous_entry_id: previousEntryId ?? null,
      })
      .returning("id"),
  );
  // INSERT ... RETURNING without ON CONFLICT yields exactly one row.
  return Number(requireRow(inserted, "duplicate repair receipt insert").id);
}

/** A stored timestamp in Vision's canonical text; other values as they are. */
function canonicalTime(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return canonicalTimestamp(value) ?? value;
  } catch {
    return value;
  }
}

/** A stored image with its timestamp fields in canonical text. */
function withCanonicalTimes<T extends object>(
  image: T,
  fields: readonly string[],
): T {
  const out = { ...image } as Record<string, unknown>;
  for (const field of fields)
    if (field in out) out[field] = canonicalTime(out[field]);
  return out as T;
}

const TRANSACTION_TIMES = ["created_at", "updated_at"] as const;
const BATCH_TIMES = ["started_at", "completed_at"] as const;

/** A repair state as the image readers above produce it. */
function canonicalRepairState(state: DuplicateRepairState): DuplicateRepairState {
  return {
    ...state,
    legacy: withCanonicalTimes(state.legacy, TRANSACTION_TIMES),
    imported:
      state.imported === null
        ? null
        : withCanonicalTimes(state.imported, TRANSACTION_TIMES),
    originalBatch: withCanonicalTimes(state.originalBatch, BATCH_TIMES),
    originalStaging: state.originalStaging.map((row) =>
      withCanonicalTimes(row, TRANSACTION_TIMES),
    ),
  };
}

export async function getActiveDuplicateRepairReceipts(
  batchId: Id,
): Promise<DuplicateRepairJournalRow[]> {
  const receipts = await checkedRows(
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
  return receipts.map((receipt) => ({
    ...receipt,
    before_data: canonicalRepairState(receipt.before_data),
    after_data: canonicalRepairState(receipt.after_data),
  }));
}
