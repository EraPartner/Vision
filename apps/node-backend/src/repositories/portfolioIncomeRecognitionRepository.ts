/**
 * In-kind income writes (ADR-188, ADR-236).
 *
 * New imports insert a Kinesis yield income row with the `included_in_units`
 * role directly. Paired income recorded before ADR-236 also owns `record`
 * receipts in `portfolio_import_income_recognition_journal`; rollback closes
 * them with a `restore` entry so that the journal keeps telling the truth.
 */
import { sql } from "kysely";
import type { ExpressionBuilder } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { DB } from "../database/schema.generated.ts";
import {
  incomeRecognitionJournalRowSchema,
  portfolioIntIdRowSchema,
} from "../database/rows/portfolio.ts";
import type { IncomeRecognitionJournalDbRow } from "../database/rows/portfolio.ts";
import type {
  AccountId,
  CurrencyCode,
  InvestmentId,
} from "@vision/types/brands";

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

/** The matched staging fields an in-kind income insert reads. */
export interface IncludedInUnitsIncomeSource {
  investment_id: number;
  tx_date: string | null;
  amount: string | number | null;
  currency: string | null;
  note: string | null;
  source_record_hash: string | null;
  dedup_fingerprint: string | null;
  dedup_fingerprint_version: number | null;
}

/**
 * Insert a Kinesis yield dividend whose value its `:units` gift already
 * carries. The image matches what paired income recording wrote before
 * ADR-236: literal amount; no units, fees, taxes or EUR rate; and the
 * `included_in_units` role that keeps it out of income totals. The public
 * create and update bodies keep the role read-only.
 *
 * @returns the new transaction id, or undefined when the identity exists
 */
export async function insertIncludedInUnitsIncome(
  row: IncludedInUnitsIncomeSource,
  accountId: number | undefined,
  batchId: number,
): Promise<number | undefined> {
  const inserted = await checkedRow(
    portfolioIntIdRowSchema,
    db
      .insertInto("portfolio_transactions")
      .values({
        // A matched source row has these; NOT NULL rejects a missing value.
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
        account_id: sql<AccountId | null>`${accountId ?? null}`,
        import_batch_id: String(batchId),
        source_record_hash: row.source_record_hash,
        dedup_fingerprint: row.dedup_fingerprint,
        dedup_fingerprint_version: row.dedup_fingerprint_version,
        income_recognition_role: "included_in_units",
      })
      .onConflict((oc) => oc.doNothing())
      .returning("id"),
  );
  return inserted ? inserted.id : undefined;
}

/** Close a batch's paired income `record` receipts before its rows are removed. */
export async function restorePairedPortfolioIncomeForBatch(
  batchId: Id,
): Promise<IncomeRecognitionJournalRow[]> {
  const receipts = await checkedRows(
    incomeRecognitionJournalRowSchema,
    db
      .selectFrom("portfolio_import_income_recognition_journal as r")
      .where("r.batch_id", "=", String(batchId))
      .where("r.action", "=", "record")
      .where(notRestored)
      .selectAll("r")
      .orderBy("r.id"),
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
