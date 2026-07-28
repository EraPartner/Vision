/**
 * Portfolio import batch service — the route-facing seam over
 * portfolioImportBatchRepository (eslint vision-local/no-repo-direct-from-route).
 *
 * Pure data access (history, review preview, per-row override) is re-exported
 * straight from the repository. The two operations that coordinate multiple
 * repositories — creating a holding from a row, and rollback — live here.
 */

import portfolioTransactionRepository from '../repositories/portfolioTransactionRepository.js';
import investmentRepository from '../repositories/investmentRepository.js';
import { query } from '../database/connection.js';
import {
  getRowForInvestmentCreation,
  overrideInvestment,
  getCommittedRows,
  markBatchAborted,
} from '../repositories/portfolioImportBatchRepository.js';

export {
  listBatches,
  getBatch,
  getPreviewRows,
  overrideInvestment,
  setBatchAccount,
} from '../repositories/portfolioImportBatchRepository.js';

/**
 * Create a new investment from a staging row's symbol/name and the batch's
 * default asset class, then point the row at it. Used by the review "create
 * new holding" action.
 *
 * @param {{ batchId: number, rowId: number }} args
 * @returns {Promise<object|undefined>} the created investment row, or
 *          `undefined` when the staging row does not exist.
 */
export async function createInvestmentForRow({ batchId, rowId }) {
  const row = await getRowForInvestmentCreation({ batchId, rowId });
  if (!row) return undefined;
  if (!row.default_asset_class) {
    const err = /** @type {Error & { code?: string }} */ (new Error('batch has no default asset class for new holdings'));
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const name = (row.name_raw || row.symbol_raw || '').trim();
  if (!name) {
    const err = /** @type {Error & { code?: string }} */ (new Error('row has no symbol or name to create a holding from'));
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  // CSV-derived currency: coalesce to EUR unless it is a clean ISO-shaped code
  // (uppercased). investments.currency is VARCHAR(10) with no CHECK, so a
  // malformed CSV cell either stored garbage or (>10 chars) 500'd the insert —
  // fallback (not reject) matches the pipeline's existing `|| 'EUR'` coalescing.
  const rawCurrency = String(row.currency || '').trim().toUpperCase();
  const investment = await investmentRepository.create(/** @type {any} */ ({
    name,
    symbol: (row.symbol_raw || '').trim() || undefined,
    asset_class: row.default_asset_class,
    currency: /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'EUR',
    price_provider: 'manual',
  }));

  await overrideInvestment({ batchId, rowId, investmentId: investment.id });
  return investment;
}

/**
 * Rollback: hard-delete every committed row this batch produced and mark the
 * batch aborted. Routed by target table (ADR-095): a cash row's
 * committed_txn_id is a `transactions.id`, a trade's is a portfolio-
 * transaction id — the sequences are independent, so deleting every id
 * through the portfolio repo removed UNRELATED trades that happened to share
 * a cash row's number (and left the imported cash row in the ledger).
 *
 * @param {number} batchId
 * @returns {Promise<{ deleted: number }>}
 */
export async function rollbackBatch(batchId) {
  const rows = await getCommittedRows(batchId);

  let deleted = 0;
  for (const { id, route } of rows) {
    if (route === 'cash') {
      const r = await query('DELETE FROM transactions WHERE id = $1', [id]);
      if ((r.rowCount ?? 0) > 0) deleted++;
    } else {
      const ok = await portfolioTransactionRepository.hardDelete(id);
      if (ok) deleted++;
    }
  }

  await markBatchAborted(batchId);
  return { deleted };
}
