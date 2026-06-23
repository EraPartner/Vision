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
import { createTradeCashLeg } from '../portfolio/tradeCashLegService.js';

export async function commitBatch({ batchId, onProgress }) {
  await query(`UPDATE portfolio_import_batches SET status = 'committing' WHERE id = $1`, [batchId]);

  // Batch-level brokerage account (ADR-095): every lot from this batch lands on it,
  // giving imported holdings a real per-account position (ADR-091). NULL = unassigned.
  // In brokerage mode the batch ALSO fans out cash rows + trade cash legs.
  const { rows: batchRows } = await query(
    `SELECT account_id, is_brokerage FROM portfolio_import_batches WHERE id = $1`,
    [batchId],
  );
  const batchAccountId = batchRows[0]?.account_id ?? undefined;
  const isBrokerage = batchRows[0]?.is_brokerage === true;

  const { rows: matched } = await query(
    `SELECT isr.id,
            to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date,
            isr.type,
            isr.route,
            isr.type_raw,
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

  let legs = 0;

  for (let i = 0; i < total; i++) {
    const row = matched[i];

    // ── Brokerage cash row (ADR-095): an external deposit/withdrawal → a plain
    // cash transaction on the sleeve (NOT a trade, no leg). ──
    if (isBrokerage && row.route === 'cash') {
      if (!batchAccountId) {
        errors++;
        await markRow(row.id, 'error', 'brokerage cash row requires a batch account');
        continue;
      }
      if (row.tx_hash && committedHashes.has(row.tx_hash)) {
        duplicates++;
        await markRow(row.id, 'duplicate');
        continue;
      }
      if (await isCashFieldDuplicate(batchAccountId, row)) {
        duplicates++;
        await markRow(row.id, 'duplicate');
        continue;
      }
      try {
        const memo = row.note || (row.type_raw ? String(row.type_raw).toUpperCase() : 'BROKERAGE CASH');
        const r = await query(
          `INSERT INTO transactions (date, amount, currency, memo, account_id, is_active)
           VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
          [row.tx_date, Number(row.amount), row.currency || 'EUR', memo, batchAccountId],
        );
        imported++;
        if (row.tx_hash) committedHashes.add(row.tx_hash);
        await query(
          `UPDATE portfolio_import_staging_rows SET status = 'committed', committed_txn_id = $2 WHERE id = $1`,
          [row.id, r.rows[0]?.id ?? null],
        );
      } catch (err) {
        errors++;
        await markRow(row.id, 'error', err?.message?.slice(0, 500) || 'cash insert failed');
      }
      continue;
    }

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
        account_id: batchAccountId,
        preloaded_asset_class: row.asset_class,
      }));

      imported++;
      if (row.tx_hash) committedHashes.add(row.tx_hash);

      // Brokerage trade (ADR-095/ADR-090): the trade's single cash movement is its
      // auto-created leg on the same sleeve — never a second standalone cash row.
      if (isBrokerage && batchAccountId) {
        try {
          const legId = await createTradeCashLeg({
            portfolioTxn: { ...created, type: row.type, amount: created?.amount ?? row.amount, fees: created?.fees ?? row.fees, taxes: created?.taxes ?? row.taxes, currency, date: row.tx_date, id: created?.id },
            cashAccountId: batchAccountId,
          });
          if (legId) legs++;
        } catch (legErr) {
          logger.warn('[portfolio-pipeline:commit] trade cash leg failed (trade kept)', { rowId: row.id, err: legErr?.message });
        }
      }

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

  logger.info('[portfolio-pipeline:commit] done', { batchId, total, imported, duplicates, errors, legs, isBrokerage });
  return { imported, duplicates, errors, legs };
}

async function markRow(id, status, message) {
  await query(
    `UPDATE portfolio_import_staging_rows SET status = $2, error_message = $3 WHERE id = $1`,
    [id, status, message ?? null],
  );
}

// Field-based dedup for an external brokerage cash row, so re-importing a
// statement is a no-op (cash rows have no tx_hash partial-unique of their own here).
async function isCashFieldDuplicate(accountId, row) {
  const memo = row.note || (row.type_raw ? String(row.type_raw).toUpperCase() : 'BROKERAGE CASH');
  const dup = await query(
    `SELECT 1 FROM transactions
      WHERE account_id = $1 AND date = $2::date AND amount = $3
        AND COALESCE(memo, '') = COALESCE($4, '') AND is_active = true
      LIMIT 1`,
    [accountId, row.tx_date, Number(row.amount), memo],
  );
  return dup.rows.length > 0;
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
