/** Immutable source-backed unit corrections, with no cash or disposal legs. */
import { query } from "../database/connection.ts";

/** BIGINT ids and NUMERIC units arrive from pg as strings. */
export type PortfolioAssetAdjustmentRow = {
  id: string;
  investment_id: number;
  account_id: number;
  /** `to_char(date, 'YYYY-MM-DD')` */
  date: string;
  units: string;
  adjustment_kind: "yield_reversal" | "asset_fee";
  basis_policy: "zero_yield_only" | "carried";
  eligible_source_record_hashes: string[];
  basis_allocations: Record<string, unknown>;
  import_batch_id: string;
  staging_row_id: string;
  source_record_hash: string;
  dedup_fingerprint: string;
  dedup_fingerprint_version: number;
  created_at: Date;
};

export type EligibleYieldSourceRow = {
  source_record_hash: string;
  staging_row_id: string;
};

export type PortfolioAssetAdjustmentInsert = {
  investment_id: number;
  account_id: number;
  date: string;
  units: string;
  adjustment_kind: string;
  basis_policy: string;
  basis_allocations?: unknown;
  eligible_source_record_hashes: string[];
  import_batch_id: number;
  staging_row_id: number;
  source_record_hash: string;
  dedup_fingerprint: string;
  dedup_fingerprint_version: number;
};

export async function getEligibleYieldSources(
  investmentId: number,
  accountId: number,
): Promise<EligibleYieldSourceRow[]> {
  return (
    await query<EligibleYieldSourceRow>(
      `SELECT s.source_record_hash,MIN(s.id) AS staging_row_id FROM portfolio_import_staging_rows s
       JOIN portfolio_import_batches b ON b.id=s.batch_id
       WHERE COALESCE(s.user_override_investment_id,s.resolved_investment_id)=$1
         AND b.account_id=$2 AND s.type='gift'
         AND s.asset_adjustment_details->>'kind'='yield_acquisition'
         AND s.asset_adjustment_details->>'basisPolicy'='zero'
         AND s.status IN ('matched','committed','duplicate')
         AND s.source_record_hash IS NOT NULL GROUP BY s.source_record_hash ORDER BY s.source_record_hash`,
      [investmentId, accountId],
    )
  ).rows;
}

export async function getEligibleYieldSourceHashes(
  investmentId: number,
  accountId: number,
): Promise<string[]> {
  return (await getEligibleYieldSources(investmentId, accountId)).map(
    (row) => row.source_record_hash,
  );
}

export async function retainAssetAdjustmentSources(
  adjustmentId: string | number,
  sources: readonly EligibleYieldSourceRow[],
): Promise<void> {
  for (const source of sources)
    await query(
      "INSERT INTO portfolio_asset_adjustment_sources(adjustment_id,staging_row_id,source_record_hash) VALUES ($1,$2,$3)",
      [adjustmentId, source.staging_row_id, source.source_record_hash],
    );
}

export async function findAssetAdjustmentFingerprint(
  fingerprint: string,
  version: number,
): Promise<PortfolioAssetAdjustmentRow | undefined> {
  return (
    await query<PortfolioAssetAdjustmentRow>(
      "SELECT a.*,to_char(a.date,'YYYY-MM-DD') AS date FROM portfolio_asset_adjustments a WHERE dedup_fingerprint=$1 AND dedup_fingerprint_version=$2",
      [fingerprint, version],
    )
  ).rows[0];
}

export async function insertAssetAdjustment(
  event: PortfolioAssetAdjustmentInsert,
): Promise<{ id: string }> {
  return (
    await query<{ id: string }>(
      `INSERT INTO portfolio_asset_adjustments
      (investment_id,account_id,date,units,adjustment_kind,basis_policy,basis_allocations,eligible_source_record_hashes,
       import_batch_id,staging_row_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::text[],$9,$10,$11,$12,$13) RETURNING id`,
      [
        event.investment_id,
        event.account_id,
        event.date,
        event.units,
        event.adjustment_kind,
        event.basis_policy,
        JSON.stringify(event.basis_allocations),
        event.eligible_source_record_hashes,
        event.import_batch_id,
        event.staging_row_id,
        event.source_record_hash,
        event.dedup_fingerprint,
        event.dedup_fingerprint_version,
      ],
    )
  ).rows[0];
}

export async function getAssetAdjustmentsForBatch(
  batchId: string | number,
): Promise<PortfolioAssetAdjustmentRow[]> {
  return (
    await query<PortfolioAssetAdjustmentRow>(
      "SELECT a.*,to_char(a.date,'YYYY-MM-DD') AS date FROM portfolio_asset_adjustments a WHERE import_batch_id=$1 ORDER BY a.investment_id,a.date,a.id",
      [batchId],
    )
  ).rows;
}

export async function deleteAssetAdjustmentsForBatch(
  batchId: string | number,
): Promise<number | null> {
  return (
    await query(
      "DELETE FROM portfolio_asset_adjustments WHERE import_batch_id=$1",
      [batchId],
    )
  ).rowCount;
}
