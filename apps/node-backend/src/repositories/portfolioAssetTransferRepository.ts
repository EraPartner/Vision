/** Single canonical custody event, with no editable transaction legs. */
import { query } from "../database/connection.ts";

/** BIGINT ids and NUMERIC units arrive from pg as strings. */
export type PortfolioAssetTransferRow = {
  id: string;
  investment_id: number;
  source_account_id: number;
  destination_account_id: number;
  /** `to_char(date, 'YYYY-MM-DD')` */
  date: string;
  units: string;
  fee_units: string;
  fee_basis_allocations: Record<string, unknown>;
  import_batch_id: string;
  staging_row_id: string;
  source_record_hash: string;
  dedup_fingerprint: string;
  dedup_fingerprint_version: number;
  created_at: Date;
};

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
  return (
    await query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM portfolio_asset_transfers WHERE investment_id=$1 UNION ALL SELECT 1 FROM portfolio_asset_adjustments WHERE investment_id=$1) AS present",
      [investmentId],
    )
  ).rows[0].present;
}

export async function findAssetTransferFingerprint(
  fingerprint: string,
  version: number,
): Promise<PortfolioAssetTransferRow | undefined> {
  return (
    await query<PortfolioAssetTransferRow>(
      `SELECT *, to_char(date,'YYYY-MM-DD') AS date FROM portfolio_asset_transfers
    WHERE dedup_fingerprint=$1 AND dedup_fingerprint_version=$2`,
      [fingerprint, version],
    )
  ).rows[0];
}

export async function insertAssetTransfer(
  event: PortfolioAssetTransferInsert,
): Promise<{ id: string }> {
  return (
    await query<{ id: string }>(
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
    )
  ).rows[0];
}

export async function getAssetTransfersForBatch(
  batchId: string | number,
): Promise<PortfolioAssetTransferRow[]> {
  return (
    await query<PortfolioAssetTransferRow>(
      `SELECT at.*, to_char(at.date,'YYYY-MM-DD') AS date FROM portfolio_asset_transfers at WHERE import_batch_id=$1 ORDER BY at.investment_id,at.date,at.id`,
      [batchId],
    )
  ).rows;
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
