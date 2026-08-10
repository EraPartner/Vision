/**
 * Portfolio investment types — shared between frontend components.
 */
import type { PortfolioTransaction } from './api';
import type { AssetClass } from '@vision/types/assetClasses';
import type { PortfolioTxnType as CanonicalPortfolioTxnType } from '@vision/types/portfolioTxnTypes';
import type { RecurrenceInterval } from '@vision/types/recurrence';

// Derived from the canonical runtime array in @vision/types/assetClasses, so
// this union can no longer drift from the shared ASSET_CLASSES list.
export type { AssetClass };

/** @deprecated Use getAssetClassLabel(t, assetClass) for UI display */
export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  stock: 'Stock',
  etf: 'ETF',
  crypto: 'Cryptocurrency',
  metals: 'Metals',
  real_estate: 'Real Estate',
  savings: 'Savings Account',
  bond: 'Bond',
};

/** Returns a translated label for an asset class. */
export function getAssetClassLabel(t: (key: string) => string, assetClass: AssetClass): string {
  return t(`portfolio.assetClass.${assetClass}`);
}

/** @deprecated Use getAssetClassGroups(t) for UI display */
export const ASSET_CLASS_GROUPS: Record<string, AssetClass[]> = {
  'Stocks & ETFs': ['stock', 'etf'],
  'Crypto': ['crypto'],
  'Real Estate': ['real_estate'],
  'Savings & Bonds': ['savings', 'bond'],
};

/** Returns translated asset class groups for UI display. */
export function getAssetClassGroups(t: (key: string) => string): Record<string, AssetClass[]> {
  return {
    [t('portfolio.assetGroup.stocksEtfs')]: ['stock', 'etf'],
    [t('portfolio.assetGroup.crypto')]: ['crypto'],
    [t('portfolio.assetGroup.metals')]: ['metals'],
    [t('portfolio.assetGroup.realEstate')]: ['real_estate'],
    [t('portfolio.assetGroup.savingsBonds')]: ['savings', 'bond'],
  };
}

// Deliberate UI-facing SUBSET of the canonical PORTFOLIO_TXN_TYPES list in
// @vision/types/portfolioTxnTypes: only the types with portfolio.txnType.*
// labels are offered in the transaction dialogs. Corporate actions
// (split/merger/spinoff/return_of_capital) stay importable via CSV but are not
// part of this union. The parity check below fails typecheck if this subset
// ever contains a value outside the canonical set.
export type PortfolioTxnType = 'buy' | 'sell' | 'dividend' | 'fee' | 'tax' | 'interest' | 'rent_income' | 'appreciation' | 'gift';
type _TxnTypeSubsetParity = PortfolioTxnType extends CanonicalPortfolioTxnType ? true : never;
const _txnTypeSubsetParity: _TxnTypeSubsetParity = true;
void _txnTypeSubsetParity;

/** Returns a translated label for a portfolio transaction type. */
export function getTxnTypeLabel(t: (key: string) => string, type: PortfolioTxnType | string): string {
  return t(`portfolio.txnType.${type}`) || type;
}

// Was declared here verbatim a second time (the identical union also lived in
// ./api.ts). Both now derive from the canonical PORTFOLIO_RECURRENCE_INTERVALS
// tuple in @vision/types/recurrence; re-exported so the portfolio dialogs keep
// importing it from '@/types/portfolio'.
export type { RecurrenceInterval };

// Computed view model returned by usePortfolio
export interface InvestmentSummary {
  id: number;
  name: string;
  symbol?: string;
  assetClass: AssetClass;
  asset_class: AssetClass;
  /** Display currency of every monetary field below (the app's target currency). */
  currency: string;
  /** The investment's native currency, preserved for labelling (mirrors backend). */
  originalCurrency?: string;
  currentPrice?: number;
  current_price?: number;
  interestRate?: number;
  interest_rate?: number;
  maturityDate?: string;
  maturity_date?: string;
  location?: string;
  municipality?: string;
  cadastral_income?: number;
  municipality_tax_rate?: number;
  notes?: string;
  price_provider?: 'manual' | 'binance' | 'yahoo' | 'custom' | 'kinesis';
  price_provider_id?: string;
  price_provider_url?: string;
  price_provider_latest_url?: string;
  price_provider_latest_path?: string;
  price_provider_history_url?: string;
  price_provider_history_path?: string;
  price_provider_history_ts_path?: string;
  price_provider_history_price_path?: string;
  price_updated_at?: string;
  is_active: boolean;
  /** Whether this holding appears in the portfolio price ticker (default true). */
  show_in_ticker?: boolean;
  created_at: string;
  updated_at: string;

  // Computed - Core
  totalUnits: number;
  totalInvested: number;       // Net capital deployed (buys - sells principal)
  totalFees: number;           // fee tx-type rows + per-row fees columns
  totalTaxes: number;          // tax tx-type rows + per-row taxes columns
  // Standalone fee/tax *transaction-type* totals only (NOT the per-row
  // fees/taxes columns, which buys/sells already fold into cost basis). Net-gain
  // cards must subtract these, never totalFees/totalTaxes, to avoid double-count.
  // Optional so existing test fixtures stay valid; production always sets them.
  feeTransactions?: number;
  taxTransactions?: number;
  totalDividends: number;
  totalIncome: number;         // All income: dividends + interest + rent
  currentValue: number;
  
  // Computed - Advanced
  avgCostBasis: number;        // Weighted average cost per unit (for unit-based)
  realizedGain: number;        // Profit/loss from sells
  unrealizedGain: number;      // Paper profit/loss on current holdings
  totalGain: number;           // realizedGain + unrealizedGain
  gainLoss: number;            // Legacy: totalGain + income - fees - taxes
  gainLossPercent: number;
  
  // Fixed income specific
  accruedInterest: number;     // Interest earned since last payout
  projectedAnnualInterest: number; // Expected annual interest
  totalAppreciation: number;   // For real estate
  
  // Cost tracking
  totalBuyCost: number;        // Total spent on buys (including fees)
  totalSellProceeds: number;   // Total received from sells
  
  transactions: PortfolioTransaction[];
  description?: string;

  // ── Belgian tax classification (optional overrides used by the PortfolioTaxPage) ──
  /**
   * ETF accumulation/distribution flag — drives the TOB rate on `buy` legs.
   * `accumulating` → 1.32% (cap €4,000); `distributing` → 0.12% (cap €1,300).
   * When unset, the calc defaults to `accumulating` (more common in BE retail).
   */
  etfStructure?: 'accumulating' | 'distributing';
  /**
   * Explicit override for whether realised gains are subject to Reynders tax (30% on
   * the bond-attributable portion). When unset, the calc falls back to `assetClass === 'bond'`
   * — this default treats the `bond` asset class as a bond-fund proxy. Set explicitly:
   *   true  → bond fund / >10% bond mixed fund (apply Reynders to the interest portion)
   *   false → direct sovereign / corporate bond (no Reynders; from IY 2026 the gain is
   *           subject to the 10% CGT, before that exempt under normal management)
   */
  subjectToReynders?: boolean;
  /**
   * Share of the realised gain attributable to interest (Reynders base). Range [0, 1].
   * Default 1.0 — treats the full gain as interest, matching pure accumulating bond
   * funds. For mixed funds the user can lower this fraction; the remainder (1 - share)
   * is taxed under the 10% CGT regime from IY 2026 onwards.
   */
  reyndersInterestPortion?: number;
}
