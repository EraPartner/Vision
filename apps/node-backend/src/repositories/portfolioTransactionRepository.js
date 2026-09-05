/**
 * Portfolio transaction persistence barrel:
 *   - portfolioTxRepo.common.js → schema/list SQL helpers
 *   - portfolioTxRepo.reads.js  → parameterized reads
 *   - portfolioTxRepo.writes.js → parameterized writes
 *
 * Write orchestration and domain policy live in services/portfolio/.
 */

export { __resetPortfolioTransactionSchemaCache } from "./portfolioTxRepo.common.js";

import {
  getAll,
  getAllWithCount,
  getAllByInvestmentIds,
  getCount,
  getById,
  getRowsForPortfolioMath,
  getSummary,
} from "./portfolioTxRepo.reads.js";
import {
  insert,
  updateFields,
  hardDelete,
  hardDeleteByImportBatch,
  repointAccount,
} from "./portfolioTxRepo.writes.js";

export const portfolioTransactionRepository = {
  getAll,
  getAllWithCount,
  getAllByInvestmentIds,
  getCount,
  getById,
  getRowsForPortfolioMath,
  insert,
  updateFields,
  hardDelete,
  hardDeleteByImportBatch,
  repointAccount,
  getSummary,
};

export default portfolioTransactionRepository;
