/**
 * Portfolio Transaction Repository — thin barrel composing three split modules:
 *   - portfolioTxRepo.common.js  → shared helpers (schema probe, validation, inheritance-table ops)
 *   - portfolioTxRepo.reads.js   → read ops (list/count/getById/summary)
 *   - portfolioTxRepo.writes.js  → write ops (create/update/hardDelete)
 */

export { __resetPortfolioTransactionSchemaCache } from './portfolioTxRepo.common.js';

import { getAccountIdRelation } from './portfolioTxRepo.common.js';

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
  repointAccount,
  getAccountIdRelation,
  getSummary,
};

export default portfolioTransactionRepository;
