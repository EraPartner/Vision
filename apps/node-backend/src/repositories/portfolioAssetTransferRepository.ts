/** Single canonical custody event, with no editable transaction legs. */
import { query } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
import {
  portfolioAssetTransferRowSchema,
  portfolioBigintIdRowSchema,
  presentRowSchema,
} from "../database/rows/portfolio.ts";
import type { PortfolioAssetTransferDbRow } from "../database/rows/portfolio.ts";

/**
 * BIGINT ids and NUMERIC units arrive from pg as strings. Derived from the
 * checked row schema.
 */
export type PortfolioAssetTransferRow = PortfolioAssetTransferDbRow;

export type PortfolioAssetTransferInsert = {
  investment_id: number;
  source_account_id: number;
  destination_account_id: number;
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
  const row = await queryOne(
    presentRowSchema,
    "SELECT EXISTS (SELECT 1 FROM portfolio_asset_transfers WHERE investment_id=$1 UNION ALL SELECT 1 FROM portfolio_asset_adjustments WHERE investment_id=$1) AS present",
    [investmentId],
  );
  // SELECT EXISTS always returns exactly one row.
  if (!row) throw new Error("EXISTS query returned no row");
  return row.present;
}

export async function findAssetTransferFingerprint(
  fingerprint: string,
  version: number,
): Promise<PortfolioAssetTransferRow | undefined> {
  return queryOne(
    portfolioAssetTransferRowSchema,
    `SELECT *, to_char(date,'YYYY-MM-DD') AS date FROM portfolio_asset_transfers
    WHERE dedup_fingerprint=$1 AND dedup_fingerprint_version=$2`,
    [fingerprint, version],
  );
}

export async function insertAssetTransfer(
  event: PortfolioAssetTransferInsert,
): Promise<{ id: string }> {
  const row = await queryOne(
    portfolioBigintIdRowSchema,
    `INSERT INTO portfolio_asset_transfers
    (investment_id,source_account_id,destination_account_id,date,units,fee_units,
     import_batch_id,staging_row_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,fee_basis_allocations)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
    [
      event.investment_id,
      event.source_account_id,
      event.destination_account_id,
      event.date,
      event.units,
      event.fee_units,
      event.import_batch_id,
      event.staging_row_id,
      event.source_record_hash,
      event.dedup_fingerprint,
      event.dedup_fingerprint_version,
      JSON.stringify(event.fee_basis_allocations),
    ],
  );
  // An INSERT ... RETURNING without ON CONFLICT returns its row or throws.
  if (!row) throw new Error("Asset transfer insert returned no row");
  return row;
}

export async function getAssetTransfersForBatch(
  batchId: string | number,
): Promise<PortfolioAssetTransferRow[]> {
  return queryRows(
    portfolioAssetTransferRowSchema,
    `SELECT at.*, to_char(at.date,'YYYY-MM-DD') AS date FROM portfolio_asset_transfers at WHERE import_batch_id=$1 ORDER BY at.investment_id,at.date,at.id`,
    [batchId],
  );
}

export async function deleteAssetTransfersForBatch(
  batchId: string | number,
): Promise<number | null> {
  return (
    await query(
      "DELETE FROM portfolio_asset_transfers WHERE import_batch_id=$1",
      [batchId],
    )
  ).rowCount;
}
