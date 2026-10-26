/** Single canonical custody event, with no editable transaction legs. */
import { sql } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  portfolioAssetTransferRowSchema,
  portfolioBigintIdRowSchema,
  presentRowSchema,
} from "../database/rows/portfolio.ts";
import type { PortfolioAssetTransferDbRow } from "../database/rows/portfolio.ts";
import type { AccountId, InvestmentId } from "@vision/types/brands";

/**
 * BIGINT ids and NUMERIC units arrive from pg as strings. Derived from the
 * checked row schema.
 */
export type PortfolioAssetTransferRow = PortfolioAssetTransferDbRow;

export type PortfolioAssetTransferInsert = {
  investment_id: InvestmentId;
  source_account_id: AccountId;
  destination_account_id: AccountId;
  date: string;
  units: string;
  fee_units: string;
  import_batch_id: number;
  staging_row_id: number;
  source_record_hash: string;
  dedup_fingerprint: string;
  dedup_fingerprint_version: number;
  fee_basis_allocations?: unknown;
};

export async function hasAssetTransfersForInvestment(
  investmentId: number,
): Promise<boolean> {
  const row = await checkedRow(
    presentRowSchema,
    sql`SELECT EXISTS (
          SELECT 1 FROM portfolio_asset_transfers WHERE investment_id=${investmentId}
          UNION ALL
          SELECT 1 FROM portfolio_asset_adjustments WHERE investment_id=${investmentId}
        ) AS present`,
  );
  // SELECT EXISTS always returns exactly one row.
  if (!row) throw new Error("EXISTS query returned no row");
  return row.present;
}

function selectTransfers() {
  return db
    .selectFrom("portfolio_asset_transfers as at")
    .selectAll("at")
    .select(sql<string>`to_char(at.date,'YYYY-MM-DD')`.as("date"));
}

export async function findAssetTransferFingerprint(
  fingerprint: string,
  version: number,
): Promise<PortfolioAssetTransferRow | undefined> {
  return checkedRow(
    portfolioAssetTransferRowSchema,
    selectTransfers()
      .where("at.dedup_fingerprint", "=", fingerprint)
      .where("at.dedup_fingerprint_version", "=", version),
  );
}

export async function insertAssetTransfer(
  event: PortfolioAssetTransferInsert,
): Promise<{ id: string }> {
  const row = await checkedRow(
    portfolioBigintIdRowSchema,
    db
      .insertInto("portfolio_asset_transfers")
      .values({
        investment_id: event.investment_id,
        source_account_id: event.source_account_id,
        destination_account_id: event.destination_account_id,
        date: event.date,
        units: event.units,
        fee_units: event.fee_units,
        import_batch_id: event.import_batch_id,
        staging_row_id: event.staging_row_id,
        source_record_hash: event.source_record_hash,
        dedup_fingerprint: event.dedup_fingerprint,
        dedup_fingerprint_version: event.dedup_fingerprint_version,
        fee_basis_allocations: sql`${JSON.stringify(event.fee_basis_allocations)}::jsonb`,
      })
      .returning("id"),
  );
  // An INSERT ... RETURNING without ON CONFLICT returns its row or throws.
  if (!row) throw new Error("Asset transfer insert returned no row");
  return row;
}

export async function getAssetTransfersForBatch(
  batchId: string | number,
): Promise<PortfolioAssetTransferRow[]> {
  return checkedRows(
    portfolioAssetTransferRowSchema,
    selectTransfers()
      .where("at.import_batch_id", "=", String(batchId))
      .orderBy("at.investment_id").orderBy("at.date").orderBy("at.id"),
  );
}

export async function deleteAssetTransfersForBatch(
  batchId: string | number,
): Promise<number | null> {
  const result = await db
    .deleteFrom("portfolio_asset_transfers")
    .where("import_batch_id", "=", String(batchId))
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
