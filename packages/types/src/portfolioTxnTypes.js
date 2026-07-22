/**
 * Canonical portfolio transaction types (the portfolio_txn_type value set), in
 * canonical order. Single source shared by the backend (lib/portfolioTxnTypes →
 * import pipeline normalizer, import routes' Zod schema, repository payload
 * validation) and the frontend unions (types/api.ts, lib/api/portfolioImports).
 *
 * Keep this list append-only — the values are stored in the DB enum and used
 * on the wire. Note the frontend's UI-facing PortfolioTxnType
 * (apps/frontend/src/types/portfolio.ts) is a deliberate SUBSET of this list:
 * corporate actions (split/merger/spinoff/return_of_capital) are importable
 * but not offered in the transaction dialogs.
 */
export const PORTFOLIO_TXN_TYPES = [
  'buy', 'sell', 'dividend', 'fee', 'tax', 'interest',
  'rent_income', 'appreciation', 'gift', 'split', 'merger',
  'spinoff', 'return_of_capital',
];
