/**
 * Portfolio investment types — shared between frontend components.
 */

export type AssetClass = 'stock' | 'etf' | 'crypto' | 'real_estate' | 'savings' | 'bond';

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  stock: 'Stock',
  etf: 'ETF',
  crypto: 'Cryptocurrency',
  real_estate: 'Real Estate',
  savings: 'Savings Account',
  bond: 'Bond',
};

export const ASSET_CLASS_GROUPS: Record<string, AssetClass[]> = {
  'Stocks & ETFs': ['stock', 'etf'],
  'Crypto': ['crypto'],
  'Real Estate': ['real_estate'],
  'Savings & Bonds': ['savings', 'bond'],
};

export type PortfolioTxnType = 'buy' | 'sell' | 'dividend' | 'fee' | 'tax' | 'interest' | 'rent_income' | 'appreciation';

export const TXN_TYPE_LABELS: Record<PortfolioTxnType, string> = {
  buy: 'Buy',
  sell: 'Sell',
  dividend: 'Dividend',
  fee: 'Fee',
  tax: 'Tax',
  interest: 'Interest',
  rent_income: 'Rent Income',
  appreciation: 'Appreciation',
};

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
  notes?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;

  // Computed
  totalUnits: number;
  totalInvested: number;
  totalFees: number;
  totalTaxes: number;
  totalDividends: number;
  totalIncome: number;
  currentValue: number;
  gainLoss: number;
  gainLossPercent: number;
  transactions: any[];
  description?: string;
}
