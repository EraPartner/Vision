/** Immutable in-kind income pairing and selected-only canonical writes. */
import { sql } from "kysely";
import type { ExpressionBuilder } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { DB } from "../database/schema.generated.ts";
import {
  batchIdRowSchema,
  incomeRecognitionJournalRowSchema,
  portfolioIntIdRowSchema,
  portfolioTransactionSnapshotRowSchema,
} from "../database/rows/portfolio.ts";
import type { IncomeRecognitionJournalDbRow } from "../database/rows/portfolio.ts";
import { ConflictError } from "../middleware/errorHandler.ts";
import { asPortfolioTransactionId } from "@vision/types/brands";
import type { CurrencyCode, InvestmentId } from "@vision/types/brands";
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

/** Journal entry `r` has not been undone by a later restore entry. */
function notRestored(
  eb: ExpressionBuilder<
    DB & { r: DB["portfolio_import_income_recognition_journal"] },
    "r"
  >,
) {
  return eb.not(
    eb.exists(
      eb
        .selectFrom("portfolio_import_income_recognition_journal as undo")
        .select(sql`1`.as("one"))
        .whereRef("undo.previous_entry_id", "=", "r.id"),
    ),
  );
}
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
  if (ids.length === 0) return adopted;
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
  if (ids.length === 0) return { receipts: [], sources: [], batches: [] };
  const anyId = sql<number>`ANY(${ids}::integer[])`;
  const receipts = await checkedRows(
    incomeRecognitionJournalRowSchema,
    db
      .selectFrom("portfolio_import_income_recognition_journal as r")
      .selectAll("r")
      .where("r.action", "=", "record")
      .where((eb) =>
        eb.or([
          eb("r.unit_transaction_id", "=", anyId),
          eb("r.income_transaction_id", "=", anyId),
        ]),
      )
      .where(notRestored)
      .orderBy("r.id"),
  );
  const batchIds = [...new Set(receipts.map((row) => Number(row.batch_id)))];
  if (batchIds.length === 0) return { receipts, sources: [], batches: [] };
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
  const inserted = await checkedRow(
    portfolioIntIdRowSchema,
    db
      .insertInto("portfolio_transactions")
      .values({
        // A matched source row has these; NOT NULL rejects a stale plan's null.
        investment_id: sql<InvestmentId>`${row.investment_id}`,
        type: "dividend",
        date: sql<string>`${row.tx_date}`,
        amount: sql<string>`${row.amount}`,
        units: null,
        price_per_unit: null,
        fees: 0,
        taxes: 0,
        currency: sql<CurrencyCode>`${row.currency}`,
        fx_rate_to_eur: null,
        note: row.note,
        account_id: row.account_id,
        import_batch_id: row.batch_id,
        source_record_hash: row.source_record_hash,
        dedup_fingerprint: row.dedup_fingerprint,
        dedup_fingerprint_version: row.dedup_fingerprint_version,
        income_recognition_role: "included_in_units",
      })
      .onConflict((oc) => oc.doNothing())
      .returning("id"),
  );
  if (!inserted)
    throw new ConflictError("Paired income identity changed", {
      details: { reason: "stale_reconciliation_plan" },
    });
  const incomeRow = await checkedRow(
    portfolioTransactionSnapshotRowSchema,
    db
      .selectFrom("portfolio_transactions as pt")
      .select(
        sql
          .raw<PortfolioTransactionSnapshot>(PORTFOLIO_TRANSACTION_SNAPSHOT_SQL)
          .as("snapshot"),
      )
      .where("pt.id", "=", asPortfolioTransactionId(inserted.id)),
  );
  // The row was inserted a statement ago in the same transaction.
  if (!incomeRow)
    throw new Error("Paired income transaction vanished after insert");
  const income: PortfolioTransactionSnapshot = incomeRow.snapshot;
  const transitioned = await db
    .updateTable("portfolio_import_staging_rows")
    .set({ status: "committed", committed_txn_id: inserted.id })
    .where("id", "=", String(row.id))
    .where("status", "=", "matched")
    .returning("id")
    .execute();
  if (transitioned.length !== 1)
    throw new ConflictError("Paired income staging changed", {
      details: { reason: "stale_reconciliation_plan" },
    });
  await db
    .insertInto("portfolio_import_income_recognition_journal")
    .values({
      batch_id: row.batch_id,
      staging_row_id: row.id,
      unit_staging_row_id: unitSource.id,
      income_transaction_id: inserted.id,
      unit_transaction_id: Number(unit.id),
      action: "record",
      income_data: JSON.stringify(income),
      unit_data: JSON.stringify(unit),
      proof_data: JSON.stringify(proof),
    })
    .execute();
  await db
    .updateTable("portfolio_import_batches")
    .set((eb) => ({ rows_imported: eb("rows_imported", "+", 1) }))
    .where("id", "=", String(row.batch_id))
    .execute();
  return income;
}
/** A batch's `record` journal entries that no restore has undone. */
function selectActiveRecords(batchId: Id) {
  return db
    .selectFrom("portfolio_import_income_recognition_journal as r")
    .where("r.batch_id", "=", String(batchId))
    .where("r.action", "=", "record")
    .where(notRestored);
}

export async function restorePairedPortfolioIncomeForBatch(
  batchId: Id,
): Promise<IncomeRecognitionJournalRow[]> {
  const receipts = await checkedRows(
    incomeRecognitionJournalRowSchema,
    selectActiveRecords(batchId).selectAll("r").orderBy("r.id"),
  );
  for (const receipt of receipts)
    await db
      .insertInto("portfolio_import_income_recognition_journal")
      .values({
        batch_id: receipt.batch_id,
        staging_row_id: receipt.staging_row_id,
        unit_staging_row_id: receipt.unit_staging_row_id,
        income_transaction_id: receipt.income_transaction_id,
        unit_transaction_id: receipt.unit_transaction_id,
        action: "restore",
        previous_entry_id: receipt.id,
        income_data: JSON.stringify(receipt.income_data),
        unit_data: JSON.stringify(receipt.unit_data),
        proof_data: JSON.stringify(receipt.proof_data),
      })
      .execute();
  return receipts;
}

export async function readPairedIncomeRollbackBatchIds(
  batchId: Id,
): Promise<number[]> {
  return (
    await checkedRows(
      batchIdRowSchema,
      selectActiveRecords(batchId)
        .innerJoin(
          "portfolio_import_staging_rows as source",
          "source.id",
          "r.unit_staging_row_id",
        )
        .select("source.batch_id")
        .distinct()
        .orderBy("source.batch_id"),
    )
  ).map((row) => Number(row.batch_id));
}
