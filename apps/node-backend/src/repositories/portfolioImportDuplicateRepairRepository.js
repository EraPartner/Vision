import { query } from "../database/connection.ts";
import { PORTFOLIO_TRANSACTION_SNAPSHOT_SQL } from "./portfolioImportReconciliationRepository.js";

const FULL_TRANSACTION = `${PORTFOLIO_TRANSACTION_SNAPSHOT_SQL} || jsonb_build_object('created_at',pt.created_at::text,'updated_at',pt.updated_at::text)`;
const STAGING = `to_jsonb(s) || jsonb_build_object('id',s.id::text,'batch_id',s.batch_id::text,
  'units',s.units::text,'price_per_unit',s.price_per_unit::text,'amount',s.amount::text,
  'fees',s.fees::text,'taxes',s.taxes::text,'fx_rate_to_eur',s.fx_rate_to_eur::text)`;
const BATCH = `to_jsonb(b) || jsonb_build_object('id',b.id::text,'source_size_bytes',b.source_size_bytes::text)`;

export async function readDuplicateRepairContext(history) {
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
        await query(
          `SELECT ${FULL_TRANSACTION} AS snapshot FROM portfolio_transactions pt WHERE pt.id=ANY($1::integer[]) ORDER BY pt.id`,
          [transactionIds],
        )
      ).rows.map((row) => row.snapshot)
    : [];
  const batches = batchIds.length
    ? (
        await query(
          `SELECT ${BATCH} AS snapshot FROM portfolio_import_batches b WHERE b.id=ANY($1::bigint[]) ORDER BY b.id`,
          [batchIds],
        )
      ).rows.map((row) => row.snapshot)
    : [];
  const staging = batchIds.length
    ? (
        await query(
          `SELECT ${STAGING} AS snapshot FROM portfolio_import_staging_rows s WHERE s.batch_id=ANY($1::bigint[]) ORDER BY s.id`,
          [batchIds],
        )
      ).rows.map((row) => row.snapshot)
    : [];
  const known = transactionIds.length
    ? (
        await query(
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

export async function readFullRepairTransaction(id) {
  return (
    await query(
      `SELECT ${FULL_TRANSACTION} AS snapshot FROM portfolio_transactions pt WHERE pt.id=$1`,
      [id],
    )
  ).rows[0]?.snapshot;
}

export async function readOriginalRepairState(originalBatchId, importedId) {
  const originalBatch = (
    await query(
      `SELECT ${BATCH} AS snapshot FROM portfolio_import_batches b WHERE b.id=$1`,
      [originalBatchId],
    )
  ).rows[0]?.snapshot;
  const originalStaging = (
    await query(
      `SELECT ${STAGING} AS snapshot FROM portfolio_import_staging_rows s WHERE s.batch_id=$1 AND s.committed_txn_id=$2 AND s.route IS DISTINCT FROM 'cash' ORDER BY s.id`,
      [originalBatchId, importedId],
    )
  ).rows.map((row) => row.snapshot);
  return { originalBatch, originalStaging };
}

export async function readRepairStagingByIds(snapshots) {
  return (
    await query(
      `SELECT ${STAGING} AS snapshot FROM portfolio_import_staging_rows s WHERE s.id=ANY($1::bigint[]) ORDER BY s.id`,
      [snapshots.map((row) => row.id)],
    )
  ).rows.map((row) => row.snapshot);
}

export async function deleteExactImportedCopy(imported) {
  return (
    (
      await query(
        `DELETE FROM portfolio_transactions pt WHERE pt.id=$1 AND ${FULL_TRANSACTION}=$2::jsonb RETURNING pt.id`,
        [imported.id, JSON.stringify(imported)],
      )
    ).rows.length === 1
  );
}

export async function replaceRepairStaging(before, after) {
  return (
    await query(
      `UPDATE portfolio_import_staging_rows s SET status=$2::jsonb->>'status',committed_txn_id=($2::jsonb->>'committed_txn_id')::integer
    WHERE s.id=$1 AND (${STAGING}) - 'updated_at' = $3::jsonb - 'updated_at' RETURNING ${STAGING} AS snapshot`,
      [before.id, JSON.stringify(after), JSON.stringify(before)],
    )
  ).rows[0]?.snapshot;
}

export async function replaceRepairBatch(before, after) {
  return (
    await query(
      `UPDATE portfolio_import_batches b SET rows_imported=($2::jsonb->>'rows_imported')::integer,rows_duplicate=($2::jsonb->>'rows_duplicate')::integer
    WHERE b.id=$1 AND ${BATCH}=$3::jsonb RETURNING ${BATCH} AS snapshot`,
      [before.id, JSON.stringify(after), JSON.stringify(before)],
    )
  ).rows[0]?.snapshot;
}

export async function restoreExactImportedCopy(imported) {
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
}) {
  return Number(
    (
      await query(
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

export async function getActiveDuplicateRepairReceipts(batchId) {
  return (
    await query(
      `SELECT a.* FROM portfolio_import_duplicate_repair_journal a WHERE a.batch_id=$1 AND a.action='repair' AND NOT EXISTS(SELECT 1 FROM portfolio_import_duplicate_repair_journal r WHERE r.previous_entry_id=a.id) ORDER BY a.id DESC`,
      [batchId],
    )
  ).rows;
}
