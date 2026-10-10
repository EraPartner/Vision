/** Immutable in-kind income pairing and selected-only canonical writes. */
import { query } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
import {
  batchIdRowSchema,
  incomeRecognitionJournalRowSchema,
  portfolioIntIdRowSchema,
  portfolioTransactionSnapshotRowSchema,
} from "../database/rows/portfolio.ts";
import type { IncomeRecognitionJournalDbRow } from "../database/rows/portfolio.ts";
import { ConflictError } from "../middleware/errorHandler.ts";
import {
  readKinesisAdoptionContext,
  readReconciliationSources,
  readReconciliationBatchScope,
  PORTFOLIO_TRANSACTION_SNAPSHOT_SQL,
} from "./portfolioImportReconciliationRepository.ts";
import type {
  PortfolioTransactionSnapshot,
  ReconciliationContext,
  ReconciliationHistoryLike,
  ReconciliationReceiptContext,
  ReconciliationSourceRow,
} from "./portfolioImportReconciliationRepository.ts";

type Id = number | string;
/**
 * A `portfolio_import_income_recognition_journal` row (BIGINT columns arrive as
 * strings from pg). Derived from the checked row schema.
 */
export type IncomeRecognitionJournalRow = IncomeRecognitionJournalDbRow;

export async function readKinesisIncomeUnitContext(
  history: readonly ReconciliationHistoryLike[],
): Promise<ReconciliationReceiptContext> {
  const adopted = await readKinesisAdoptionContext(history);
  const ids = [
    ...new Set([
      ...adopted.batches.map((batch) => Number(batch.id)),
      ...history
        .filter((row) => row.type === "gift" && row.import_batch_id != null)
        .map((row) => Number(row.import_batch_id)),
    ]),
  ].sort((a, b) => a - b);
  if (!ids.length) return adopted;
  const batches = (await readReconciliationBatchScope(ids)).filter(
    (batch) =>
      ((typeof batch.custom_config === "object"
        ? batch.custom_config?.format
        : undefined) || batch.adapter_name) === "kinesis_transaction_history",
  );
  const sources = await readReconciliationSources(
    batches.map((batch) => Number(batch.id)),
  );
  return { ...adopted, batches, sources };
}
export async function readIncomeRecognitionContext(
  history: readonly ReconciliationHistoryLike[],
): Promise<
  ReconciliationContext & { receipts: IncomeRecognitionJournalRow[] }
> {
  const ids = history
    .filter((row) => row.type === "dividend" || row.type === "gift")
    .map((row) => Number(row.id));
  if (!ids.length) return { receipts: [], sources: [], batches: [] };
  const receipts = await queryRows(
    incomeRecognitionJournalRowSchema,
    `SELECT r.* FROM portfolio_import_income_recognition_journal r WHERE r.action='record'
    AND (r.unit_transaction_id=ANY($1::integer[]) OR r.income_transaction_id=ANY($1::integer[]))
    AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal undo WHERE undo.previous_entry_id=r.id) ORDER BY r.id`,
    [ids],
  );
  const batchIds = [...new Set(receipts.map((row) => Number(row.batch_id)))];
  if (!batchIds.length) return { receipts, sources: [], batches: [] };
  const [sources, batches] = await Promise.all([
    readReconciliationSources(batchIds),
    readReconciliationBatchScope(batchIds),
  ]);
  return { receipts, sources, batches };
}
/** The proved in-kind income pairing `recordPairedPortfolioIncome` commits. */
export interface PairedIncomeRecord {
  /** The matched income staging row being committed. */
  row: Pick<
    ReconciliationSourceRow,
    | "id"
    | "batch_id"
    | "investment_id"
    | "tx_date"
    | "amount"
    | "currency"
    | "note"
    | "account_id"
    | "source_record_hash"
    | "dedup_fingerprint"
    | "dedup_fingerprint_version"
  >;
  /** Snapshot of the unit transaction the income is included in. */
  unit: Record<string, unknown> & { id: Id };
  unitSource: { id: Id };
  proof: Record<string, unknown>;
}

/** @returns the inserted income transaction snapshot */
export async function recordPairedPortfolioIncome({
  row,
  unit,
  unitSource,
  proof,
}: PairedIncomeRecord): Promise<PortfolioTransactionSnapshot> {
  const inserted = await queryOne(
    portfolioIntIdRowSchema,
    `INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,fx_rate_to_eur,note,account_id,import_batch_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,income_recognition_role)
    VALUES($1,'dividend',$2,$3,NULL,NULL,0,0,$4,NULL,$5,$6,$7,$8,$9,$10,'included_in_units') ON CONFLICT DO NOTHING RETURNING id`,
    [
      row.investment_id,
      row.tx_date,
      row.amount,
      row.currency,
      row.note,
      row.account_id,
      row.batch_id,
      row.source_record_hash,
      row.dedup_fingerprint,
      row.dedup_fingerprint_version,
    ],
  );
  if (!inserted)
    throw new ConflictError("Paired income identity changed", {
      details: { reason: "stale_reconciliation_plan" },
    });
  const incomeRow = await queryOne(
    portfolioTransactionSnapshotRowSchema,
    `SELECT ${PORTFOLIO_TRANSACTION_SNAPSHOT_SQL} AS snapshot FROM portfolio_transactions pt WHERE id=$1`,
    [inserted.id],
  );
  // The row was inserted a statement ago in the same transaction.
  if (!incomeRow)
    throw new Error("Paired income transaction vanished after insert");
  const income: PortfolioTransactionSnapshot = incomeRow.snapshot;
  const transitioned = await query(
    "UPDATE portfolio_import_staging_rows SET status='committed',committed_txn_id=$2 WHERE id=$1 AND status='matched' RETURNING id",
    [row.id, inserted.id],
  );
  if (transitioned.rows.length !== 1)
    throw new ConflictError("Paired income staging changed", {
      details: { reason: "stale_reconciliation_plan" },
    });
  await query(
    "INSERT INTO portfolio_import_income_recognition_journal(batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,action,income_data,unit_data,proof_data) VALUES($1,$2,$3,$4,$5,'record',$6,$7,$8)",
    [
      row.batch_id,
      row.id,
      unitSource.id,
      inserted.id,
      unit.id,
      JSON.stringify(income),
      JSON.stringify(unit),
      JSON.stringify(proof),
    ],
  );
  await query(
    "UPDATE portfolio_import_batches SET rows_imported=rows_imported+1 WHERE id=$1",
    [row.batch_id],
  );
  return income;
}
export async function restorePairedPortfolioIncomeForBatch(
  batchId: Id,
): Promise<IncomeRecognitionJournalRow[]> {
  const receipts = await queryRows(
    incomeRecognitionJournalRowSchema,
    `SELECT r.* FROM portfolio_import_income_recognition_journal r WHERE r.batch_id=$1 AND r.action='record'
    AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal undo WHERE undo.previous_entry_id=r.id) ORDER BY r.id`,
    [batchId],
  );
  for (const receipt of receipts)
    await query(
      `INSERT INTO portfolio_import_income_recognition_journal(batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,action,previous_entry_id,income_data,unit_data,proof_data)
    VALUES($1,$2,$3,$4,$5,'restore',$6,$7,$8,$9)`,
      [
        receipt.batch_id,
        receipt.staging_row_id,
        receipt.unit_staging_row_id,
        receipt.income_transaction_id,
        receipt.unit_transaction_id,
        receipt.id,
        JSON.stringify(receipt.income_data),
        JSON.stringify(receipt.unit_data),
        JSON.stringify(receipt.proof_data),
      ],
    );
  return receipts;
}

export async function readPairedIncomeRollbackBatchIds(
  batchId: Id,
): Promise<number[]> {
  return (
    await queryRows(
      batchIdRowSchema,
      `SELECT DISTINCT source.batch_id FROM portfolio_import_income_recognition_journal r
    JOIN portfolio_import_staging_rows source ON source.id=r.unit_staging_row_id WHERE r.batch_id=$1 AND r.action='record'
    AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal undo WHERE undo.previous_entry_id=r.id) ORDER BY source.batch_id`,
      [batchId],
    )
  ).map((row) => Number(row.batch_id));
}
