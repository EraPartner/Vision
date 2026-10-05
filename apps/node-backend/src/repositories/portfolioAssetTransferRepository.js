/** Single canonical custody event, with no editable transaction legs. */
import { query } from "../database/connection.js";

export async function hasAssetTransfersForInvestment(investmentId) {
  return (
    await query(
      "SELECT EXISTS (SELECT 1 FROM portfolio_asset_transfers WHERE investment_id=$1 UNION ALL SELECT 1 FROM portfolio_asset_adjustments WHERE investment_id=$1) AS present",
      [investmentId],
    )
  ).rows[0].present;
}

export async function findAssetTransferFingerprint(fingerprint, version) {
  return (
    await query(
      `SELECT *, to_char(date,'YYYY-MM-DD') AS date FROM portfolio_asset_transfers
    WHERE dedup_fingerprint=$1 AND dedup_fingerprint_version=$2`,
      [fingerprint, version],
    )
  ).rows[0];
}

export async function insertAssetTransfer(event) {
  return (
    await query(
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

export async function getAssetTransfersForBatch(batchId) {
  return (
    await query(
      `SELECT at.*, to_char(at.date,'YYYY-MM-DD') AS date FROM portfolio_asset_transfers at WHERE import_batch_id=$1 ORDER BY at.investment_id,at.date,at.id`,
      [batchId],
    )
  ).rows;
}

export async function deleteAssetTransfersForBatch(batchId) {
  return (
    await query(
      "DELETE FROM portfolio_asset_transfers WHERE import_batch_id=$1",
      [batchId],
    )
  ).rowCount;
}
