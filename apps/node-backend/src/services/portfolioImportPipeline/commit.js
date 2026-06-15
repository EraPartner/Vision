/**
 * Portfolio import pipeline — COMMIT
 *
 * Drains 'matched' staging rows into portfolio_transactions via the existing
 * portfolioTransactionRepository.create (so 2-of-3 unit math, oversell
 * prevention, and asset-class routing are reused). Each create is atomic on its
 * own connection, so a per-row failure (oversell, unresolved instrument) is
 * caught and recorded as a row error without aborting the batch.
 *
 * FX is auto-resolved (on-or-before stored rate) when the row has no rate and
 * is non-EUR. Dedup is field-based against portfolio_transactions (no tx_hash
 * column there) plus an intra-batch hash guard.
 */

import { query } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import portfolioTransactionRepository from '../../repositories/portfolioTransactionRepository.js';
import { autoResolveFxRateToEur } from '../portfolio/fxResolve.js';

export async function commitBatch({ batchId, onProgress }) {
  await query(`UPDATE portfolio_import_batches SET status = 'committing' WHERE id = $1`, [batchId]);

  const { rows: matched } = await query(
    `SELECT isr.id,
            to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date,
            isr.type,
            isr.units,
            isr.price_per_unit,
            isr.amount,
            isr.fees,
            isr.taxes,
            isr.currency,
            isr.fx_rate_to_eur,
            isr.note,
            isr.tx_hash,
            COALESCE(isr.user_override_investment_id, isr.resolved_investment_id) AS investment_id,
            inv.asset_class,
            inv.currency AS investment_currency
       FROM portfolio_import_staging_rows isr
       LEFT JOIN investments inv
         ON inv.id = COALESCE(isr.user_override_investment_id, isr.resolved_investment_id)
      WHERE isr.batch_id = $1 AND isr.status = 'matched'
      ORDER BY isr.row_index ASC`,
    [batchId],
  );

  const total = matched.length;
  let imported = 0;
  let duplicates = 0;
  let errors = 0;
  const committedHashes = new Set();

  if (onProgress) onProgress({ phase: 'committing', current: 0, total });

  for (let i = 0; i < total; i++) {
    const row = matched[i];

    if (!row.investment_id) {
      errors++;
      await markRow(row.id, 'error', 'unresolved instrument — pick or create a holding');
      continue;
    }

    if (row.tx_hash && committedHashes.has(row.tx_hash)) {
      duplicates++;
      await markRow(row.id, 'duplicate');
      continue;
    }

    if (await isFieldDuplicate(row)) {
      duplicates++;
      await markRow(row.id, 'duplicate');
      continue;
    }

    try {
      const currency = row.currency || row.investment_currency || 'EUR';
      let fxRate = row.fx_rate_to_eur != null ? Number(row.fx_rate_to_eur) : undefined;
      if (fxRate === undefined) fxRate = await autoResolveFxRateToEur(currency, row.tx_date);

      const created = await portfolioTransactionRepository.create(/** @type {any} */ ({
        investment_id: row.investment_id,
        type: row.type,
        date: row.tx_date,
        amount: row.amount != null ? Number(row.amount) : undefined,
        units: row.units != null ? Number(row.units) : undefined,
        price_per_unit: row.price_per_unit != null ? Number(row.price_per_unit) : undefined,
        fees: row.fees != null ? Number(row.fees) : 0,
        taxes: row.taxes != null ? Number(row.taxes) : 0,
        currency,
        note: row.note || undefined,
        fx_rate_to_eur: fxRate,
        preloaded_asset_class: row.asset_class,
      }));

      imported++;
      if (row.tx_hash) committedHashes.add(row.tx_hash);
      await query(
        `UPDATE portfolio_import_staging_rows SET status = 'committed', committed_txn_id = $2 WHERE id = $1`,
        [row.id, created?.id ?? null],
      );
    } catch (err) {
      errors++;
      await markRow(row.id, 'error', err?.message?.slice(0, 500) || 'insert failed');
    }

    if (onProgress && ((i + 1) % 50 === 0 || i + 1 === total)) {
      onProgress({ phase: 'committing', current: i + 1, total, imported, duplicates, errors });
    }
  }

  await query(
    `UPDATE portfolio_import_batches
        SET rows_imported = COALESCE(rows_imported, 0) + $2,
            rows_duplicate = COALESCE(rows_duplicate, 0) + $3,
            rows_error = COALESCE(rows_error, 0) + $4
      WHERE id = $1`,
    [batchId, imported, duplicates, errors],
  );

  logger.info('[portfolio-pipeline:commit] done', { batchId, total, imported, duplicates, errors });
  return { imported, duplicates, errors };
}

async function markRow(id, status, message) {
  await query(
    `UPDATE portfolio_import_staging_rows SET status = $2, error_message = $3 WHERE id = $1`,
    [id, status, message ?? null],
  );
}

async function isFieldDuplicate(row) {
  const dup = await query(
    `SELECT 1
       FROM portfolio_transactions
      WHERE investment_id = $1
        AND date = $2::date
        AND type = $3::portfolio_txn_type
        AND amount = $4
        AND COALESCE(units, 0) = COALESCE($5, 0)
      LIMIT 1`,
    [
      row.investment_id,
      row.tx_date,
      row.type,
      row.amount != null ? Number(row.amount) : 0,
      row.units != null ? Number(row.units) : null,
    ],
  );
  return dup.rows.length > 0;
}
