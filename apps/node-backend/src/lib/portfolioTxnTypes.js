/**
 * Canonical portfolio transaction types.
 *
 * Single source of truth for the portfolio_txn_type value set, shared by the
 * import pipeline's type normalizer (services/portfolioImportPipeline/
 * portfolioTypeNormalizer.js), the import routes' Zod schema, and repository
 * payload validation (repositories/portfolioTxRepo.common.js) — a plain
 * constant, so it lives in lib/ where both layers may import it.
 */
export const VALID_PORTFOLIO_TXN_TYPES = new Set([
  'buy', 'sell', 'dividend', 'fee', 'tax', 'interest',
  'rent_income', 'appreciation', 'gift', 'split', 'merger',
  'spinoff', 'return_of_capital',
]);
