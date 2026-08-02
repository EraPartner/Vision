/**
 * Portfolio Transaction Repository — thin barrel composing three split modules:
 *   - portfolioTxRepo.common.js  → shared helpers (column probe, validation)
 *   - portfolioTxRepo.reads.js   → read ops (list/count/getById/summary)
 *   - portfolioTxRepo.writes.js  → write ops (create/update/hardDelete)
 */

export { __resetPortfolioTransactionSchemaCache } from './portfolioTxRepo.common.js';

import {
  getAll,
  getAllWithCount,
  getAllByInvestmentIds,
  getCount,
  getById,
  getRowsForPortfolioMath,
  getSummary,
} from './portfolioTxRepo.reads.js';
import {
  create,
  update,
  hardDelete,
  hardDeleteByImportBatch,
  repointAccount,
} from './portfolioTxRepo.writes.js';

export const portfolioTransactionRepository = {
  getAll,
  getAllWithCount,
  getAllByInvestmentIds,
  getCount,
  getById,
  getRowsForPortfolioMath,
  create,
  update,
  hardDelete,
  hardDeleteByImportBatch,
  repointAccount,
  getSummary,
};

export default portfolioTransactionRepository;
