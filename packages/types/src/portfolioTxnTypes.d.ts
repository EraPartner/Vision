/**
 * TypeScript declarations for ./portfolioTxnTypes.js — the canonical
 * portfolio transaction type list. The PortfolioTxnType union derives from the
 * const tuple so the type and the runtime array cannot drift apart.
 */

export declare const PORTFOLIO_TXN_TYPES: readonly [
  'buy', 'sell', 'dividend', 'fee', 'tax', 'interest',
  'rent_income', 'appreciation', 'gift', 'split', 'merger',
  'spinoff', 'return_of_capital',
];

export type PortfolioTxnType = (typeof PORTFOLIO_TXN_TYPES)[number];
