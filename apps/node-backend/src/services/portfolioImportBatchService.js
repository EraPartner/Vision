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
 * @returns {Promise<import('../types/rows.js').InvestmentRow|null|undefined>} the
 *          created investment row, `undefined` when the staging row does not
 *          exist, or (in principle) `null` per investmentRepository.create's
 *          own return type — never actually null here since the insert above
 *          always finds the row it just created.
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
 * batch aborted.
 *
 * ROUTING (ADR-095, the ffb13d7 fix) is the invariant to preserve: a cash row's
 * committed_txn_id is a `transactions.id`, a trade's is a portfolio-transaction
 * id — the sequences are independent, so feeding every id to the portfolio repo
 * removed UNRELATED trades that happened to share a cash row's number (and left
 * the imported cash row in the ledger). Nothing below ever crosses that line:
 * trades are deleted from the portfolio table, cash from `transactions`, and the
 * two id sets are kept apart by `route`.
 *
 * Three passes, in this order:
 *   1. TRADES, bulk — one `DELETE ... WHERE import_batch_id = $1` (migration
 *      0086), scoped by the batch stamp rather than by an id list, so it cannot
 *      touch a lot this batch did not create. Replaces the old per-row loop.
 *   2. CASH, batched — one `DELETE FROM transactions WHERE id = ANY(...)` over
 *      exactly the route='cash' ids. `transactions.import_batch_id` FKs to the
 *      BANK `import_batches` table and is never stamped with a portfolio batch
 *      id, so pass 1 structurally cannot have covered these.
 *   3. TRADES, per-id fallback — for rows committed BEFORE 0086 applied (and on
 *      an un-migrated database, where pass 1 is a no-op): their lots carry
 *      import_batch_id NULL, so they are invisible to the bulk DELETE. Only ids
 *      pass 1 did not already report as deleted are retried here, so nothing is
 *      double-counted and no batch is left un-rollbackable by the migration
 *      boundary.
 *
 * @param {number} batchId
 * @returns {Promise<{ deleted: number }>} rows actually deleted (unchanged
 *          semantics: already-gone rows are not counted)
 */
export async function rollbackBatch(batchId) {
  const rows = await getCommittedRows(batchId);

  // 1. Trades stamped with this batch — one statement.
  const bulkDeletedIds = await portfolioTransactionRepository.hardDeleteByImportBatch(batchId);
  let deleted = bulkDeletedIds.length;
  // committed_txn_id is INTEGER while portfolio ids can arrive as BIGINT strings
  // from pg; compare as strings so the "already covered" test can't miss.
  const bulkDeleted = new Set(bulkDeletedIds.map(String));

  // 2. Cash rows → the ledger, never the portfolio table.
  const cashIds = rows.filter((r) => r.route === 'cash' && r.id != null).map((r) => r.id);
  if (cashIds.length > 0) {
    const r = await query('DELETE FROM transactions WHERE id = ANY($1::int[])', [cashIds]);
    deleted += r.rowCount ?? 0;
  }

  // 3. Pre-0086 trades the stamp cannot reach.
  const unstampedTradeIds = rows
    .filter((r) => r.route !== 'cash' && r.id != null && !bulkDeleted.has(String(r.id)))
    .map((r) => r.id);
  for (const id of unstampedTradeIds) {
    const ok = await portfolioTransactionRepository.hardDelete(id);
    if (ok) deleted++;
  }

  await markBatchAborted(batchId);
  return { deleted };
}
