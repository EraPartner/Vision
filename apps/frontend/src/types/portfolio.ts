/**
 * Portfolio investment types — shared between frontend components.
 */
import type { PortfolioTransaction } from './api';

export type AssetClass = 'stock' | 'etf' | 'crypto' | 'metals' | 'real_estate' | 'savings' | 'bond';

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

export type PortfolioTxnType = 'buy' | 'sell' | 'dividend' | 'fee' | 'tax' | 'interest' | 'rent_income' | 'appreciation' | 'gift';

/** @deprecated Use getTxnTypeLabel(t, type) for UI display */
export const TXN_TYPE_LABELS: Record<PortfolioTxnType, string> = {
  buy: 'Buy',
  sell: 'Sell',
  dividend: 'Dividend',
  fee: 'Fee',
  tax: 'Tax',
  interest: 'Interest',
  rent_income: 'Rent Income',
  appreciation: 'Appreciation',
  gift: 'Gift',
};

/** Returns a translated label for a portfolio transaction type. */
export function getTxnTypeLabel(t: (key: string) => string, type: PortfolioTxnType | string): string {
  return t(`portfolio.txnType.${type}`) || type;
}

export type RecurrenceInterval = 'daily' | 'weekly' | 'bi-weekly' | 'monthly' | 'quarterly' | 'yearly';

// Computed view model returned by usePortfolio
export interface InvestmentSummary {
  id: number;
  name: string;
  symbol?: string;
  assetClass: AssetClass;
  asset_class: AssetClass;
  currency: string;
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
