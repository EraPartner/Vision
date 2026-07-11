/**
 * Portfolio import batch service — the route-facing seam over
 * portfolioImportBatchRepository (eslint vision-local/no-repo-direct-from-route).
 *
 * Pure data access (history, review preview, per-row override) is re-exported
 * straight from the repository. The two operations that coordinate multiple
 * repositories — creating a holding from a row, and rollback — live here.
 */

import portfolioTransactionRepository from '../repositories/portfolioTransactionRepository.js';
import transactionRepository from '../repositories/transactionRepository.js';
import investmentRepository from '../repositories/investmentRepository.js';
import { deleteTradeCashLegs } from './portfolio/tradeCashLegService.js';
import {
  getRowForInvestmentCreation,
  overrideInvestment,
  getCommittedTxnTargets,
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

  const investment = await investmentRepository.create(/** @type {any} */ ({
    name,
    symbol: (row.symbol_raw || '').trim() || undefined,
    asset_class: row.default_asset_class,
    currency: (row.currency || 'EUR').trim() || 'EUR',
    price_provider: 'manual',
  }));

  await overrideInvestment({ batchId, rowId, investmentId: investment.id });
  return investment;
}

/**
 * Rollback: hard-delete every committed row this batch produced and mark the
 * batch aborted. Each id is routed to the table it was actually written to
 * (ADR-095): a cash row's committed_txn_id is a `transactions.id`, a trade's is
 * a `portfolio_transactions` id — the two tables have independent sequences, so
 * a cross-table delete would destroy an unrelated record (deleting every id
 * through the portfolio repo removed UNRELATED trades that shared a cash row's
 * number). Trades also drop their ADR-090 cash leg first (no FK cascade — the
 * inheritance schema can't support one).
 */
export async function rollbackBatch(batchId) {
  const targets = await getCommittedTxnTargets(batchId);

  let deleted = 0;
  for (const { id, route } of targets) {
    if (route === 'cash') {
      const ok = await transactionRepository.hardDelete(id);
      if (ok) deleted++;
    } else {
      await deleteTradeCashLegs(id);
      const ok = await portfolioTransactionRepository.hardDelete(id);
      if (ok) deleted++;
    }
  }

  await markBatchAborted(batchId);
  return { deleted };
}
