/**
 * Portfolio investment types — shared between frontend components.
 */

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
  price_provider?: 'manual' | 'coingecko' | 'yahoo' | 'kraken' | 'custom';
  price_provider_id?: string;
  price_provider_url?: string;
  price_provider_latest_url?: string;
  price_provider_latest_path?: string;
  price_provider_history_url?: string;
  price_provider_history_path?: string;
  price_provider_history_ts_path?: string;
  price_provider_history_price_path?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;

  // Computed - Core
  totalUnits: number;
  totalInvested: number;       // Net capital deployed (buys - sells principal)
  totalFees: number;
  totalTaxes: number;
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
  
  transactions: any[];
  description?: string;
}
