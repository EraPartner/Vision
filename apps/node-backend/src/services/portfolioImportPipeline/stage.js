/**
 * Portfolio import pipeline — STAGE
 *
 * Parses the uploaded CSV via the portfolio generic adapter and bulk-inserts
 * each parsed row into `portfolio_import_staging_rows` (status='pending').
 * Creates the parent `portfolio_import_batches` row. No type normalization,
 * instrument matching, or dedup happens here.
 */

import { query, withTransaction } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { parsedDateToYmd } from '../../lib/importDates.js';
import { parseWithConfig } from './portfolioGenericAdapter.js';

const STAGE_INSERT_CHUNK = 500;

export async function createBatch({ adapterName, filename, sizeBytes, customConfig, defaultAssetClass, defaultType, isBrokerage = false, accountId }) {
  const result = await query(
    `INSERT INTO portfolio_import_batches
       (adapter_name, source_filename, source_size_bytes, custom_config, default_asset_class, default_type, is_brokerage, account_id, status, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
     RETURNING id`,
    [
      adapterName,
      filename || null,
      sizeBytes || null,
      customConfig ? JSON.stringify(customConfig) : null,
      defaultAssetClass || null,
      defaultType || null,
      !!isBrokerage,
      accountId != null ? Number(accountId) : null,
    ],
  );
  return result.rows[0].id;
}

export async function stageBatch({ batchId, filePath, customConfig, onProgress }) {
  await query(`UPDATE portfolio_import_batches SET status = 'staging' WHERE id = $1`, [batchId]);

  const rows = await parseWithConfig(filePath, customConfig);
  const total = rows.length;
  const skipped = Number(rows.skipped) || 0;
  logger.info('[portfolio-pipeline:stage] parsed rows', { batchId, total, skipped });

  await query(`UPDATE portfolio_import_batches SET rows_total = $1 WHERE id = $2`, [total, batchId]);
  if (onProgress) onProgress({ phase: 'staging', current: 0, total });

  for (let start = 0; start < total; start += STAGE_INSERT_CHUNK) {
    const end = Math.min(start + STAGE_INSERT_CHUNK, total);
    await insertStagingChunk(batchId, rows.slice(start, end), start);
    if (onProgress) onProgress({ phase: 'staging', current: end, total });
  }

  return { rowsTotal: total, rowsSkipped: skipped };
}

async function insertStagingChunk(batchId, rows, startIndex) {
  if (!rows.length) return;
  await withTransaction(async (client) => {
    const values = [];
    const placeholders = [];
    rows.forEach((r, i) => {
      const idx = startIndex + i;
      const dateStr = parsedDateToYmd(r.date) ?? null;

      const base = values.length;
      const ph = Array.from({ length: 15 }, (_, k) => `$${base + k + 1}`);
      // status defaults to 'pending' via the column default.
      placeholders.push(`(${ph.join(',')})`);
      values.push(
        batchId, idx, dateStr,
        r.typeRaw || null, r.symbolRaw || null, r.nameRaw || null,
        r.units != null ? r.units : null,
        r.pricePerUnit != null ? r.pricePerUnit : null,
        r.amount != null ? r.amount : null,
        r.fees != null ? r.fees : null,
        r.taxes != null ? r.taxes : null,
        r.currency || null,
        r.fxRateToEur != null ? r.fxRateToEur : null,
        r.note || null,
        r.rawData || null,
      );
    });

    const sql = `INSERT INTO portfolio_import_staging_rows
      (batch_id, row_index, tx_date, type_raw, symbol_raw, name_raw,
       units, price_per_unit, amount, fees, taxes, currency, fx_rate_to_eur, note, raw_data)
      VALUES ${placeholders.join(',')}`;
    await client.query(sql, values);
  });
}
