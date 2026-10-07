import { query } from "../database/connection.ts";

export async function lockPortfolioReferenceScope(batchIds) {
  return (
    await query(
      "SELECT * FROM portfolio_import_batches WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
      [batchIds],
    )
  ).rows;
}
export async function lockPortfolioReferenceRows(batchIds) {
  await query(
    "SELECT id FROM portfolio_import_staging_rows WHERE batch_id=ANY($1::bigint[]) ORDER BY batch_id,id FOR UPDATE",
    [batchIds],
  );
}
export async function readPortfolioReferenceInvestments() {
  return (
    await query(
      "SELECT id,name,symbol,price_provider,price_provider_id,currency,asset_class FROM investments WHERE is_active=true ORDER BY id FOR SHARE",
    )
  ).rows;
}
export async function updatePortfolioReferenceRow(row, after) {
  const result = await query(
    `UPDATE portfolio_import_staging_rows SET amount=$2::numeric,price_per_unit=$3::numeric,currency=$4,fx_rate_to_eur=$5::numeric,raw_data=$6,asset_transfer_details=$7::jsonb,asset_adjustment_details=$8::jsonb,type_raw=$11,type=$12::portfolio_txn_type,route=$13
    WHERE id=$1 AND batch_id=$9 AND status='matched' AND raw_data=$10`,
    [
      row.id,
      after.amount,
      after.price_per_unit,
      after.currency,
      after.fx_rate_to_eur ?? null,
      after.raw_data,
      after.asset_transfer_details
        ? JSON.stringify(after.asset_transfer_details)
        : null,
      after.asset_adjustment_details
        ? JSON.stringify(after.asset_adjustment_details)
        : null,
      row.batch_id,
      row.raw_data,
      after.type_raw,
      after.type,
      after.route,
    ],
  );
  return result.rowCount === 1;
}
export async function savePortfolioReferenceConfiguration(batchId, config) {
  await query(
    "UPDATE portfolio_import_batches SET custom_config=$2::jsonb WHERE id=$1",
    [batchId, JSON.stringify(config)],
  );
}
export async function stagePortfolioReferenceRows(
  batchId,
  rows,
  { status = "matched" } = {},
) {
  for (const [index, row] of rows.entries())
    await query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,symbol_raw,name_raw,units,price_per_unit,amount,fees,taxes,currency,fx_rate_to_eur,resolved_investment_id,match_source,raw_data,source_transaction_id,source_account_identity,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence,asset_adjustment_details,note)
    VALUES($1,$2,$25,$3,$4,$5::portfolio_txn_type,$6,$7,$8,$9::numeric,$10::numeric,$11::numeric,$12::numeric,$13::numeric,$14,$15::numeric,$16,'symbol',$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$26)`,
      [
        batchId,
        index,
        row.tx_date,
        row.type_raw,
        row.type ?? null,
        row.route,
        row.symbol_raw,
        row.name_raw,
        row.units,
        row.price_per_unit ?? null,
        row.amount,
        row.fees,
        row.taxes,
        row.currency,
        row.fx_rate_to_eur ?? null,
        row.investment_id,
        row.raw_data,
        row.source_transaction_id,
        row.source_account_identity ?? null,
        row.source_record_hash,
        row.dedup_fingerprint,
        row.dedup_fingerprint_version,
        row.dedup_occurrence,
        row.asset_adjustment_details
          ? JSON.stringify(row.asset_adjustment_details)
          : null,
        status,
        row.note ?? null,
      ],
    );
  await query(
    "UPDATE portfolio_import_batches SET status='awaiting_review',rows_total=$2 WHERE id=$1",
    [batchId, rows.length],
  );
}
export async function markPortfolioReferenceAwaitingReview(batchId) {
  await query(
    "UPDATE portfolio_import_batches SET status='awaiting_review',rows_error=(SELECT count(*) FROM portfolio_import_staging_rows WHERE batch_id=$1 AND status='error') WHERE id=$1",
    [batchId],
  );
}

/** Reparse only a literal retained source record, before secondary provenance is attached. */
export async function restagePortfolioReferencePolicyRow(row, parsed) {
  await query(
    `UPDATE portfolio_import_staging_rows SET status='pending',type_raw=$2,type=NULL,route=NULL,units=$3::numeric,price_per_unit=$4::numeric,amount=$5::numeric,fees=$6::numeric,taxes=$7::numeric,currency=$8,note=$9,asset_transfer_details=$10::jsonb,asset_adjustment_details=$11::jsonb,error_message=NULL,dedup_fingerprint=NULL,dedup_fingerprint_version=NULL,dedup_occurrence=NULL
    WHERE id=$1 AND batch_id=$12 AND raw_data=$13 AND status NOT IN ('committed','duplicate')`,
    [
      row.id,
      parsed.typeRaw,
      parsed.units ?? null,
      parsed.pricePerUnit ?? null,
      parsed.amount ?? null,
      parsed.fees ?? 0,
      parsed.taxes ?? 0,
      parsed.currency,
      parsed.note ?? null,
      parsed.assetTransfer ? JSON.stringify(parsed.assetTransfer) : null,
      parsed.assetAdjustment ? JSON.stringify(parsed.assetAdjustment) : null,
      row.batch_id,
      row.raw_data,
    ],
  );
}
