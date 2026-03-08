/**
 * Portfolio investment types and transaction model.
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

export interface PortfolioTransaction {
  id: string;
  investmentId: string;
  type: PortfolioTxnType;
  date: string; // YYYY-MM-DD
  amount: number; // monetary value (always positive, sign derived from type)
  units?: number; // shares / coins bought or sold
  pricePerUnit?: number;
  fees?: number;
  taxes?: number;
  currency: string;
  note?: string;
  /** Recurring buy/sell config */
  isRecurring?: boolean;
  recurrenceInterval?: RecurrenceInterval;
  recurrenceEndDate?: string;
}

export interface Investment {
  id: string;
  name: string;
  symbol?: string; // ticker / coin symbol
  assetClass: AssetClass;
  currency: string;
  /** Current / estimated price per unit (manually set or fetched) */
  currentPrice?: number;
  /** Real estate specific */
  location?: string;
  /** Savings / bond specific */
  interestRate?: number;
  maturityDate?: string;
  /** General */
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// Computed view model
export interface InvestmentSummary extends Investment {
  totalUnits: number;
  totalInvested: number; // sum of buys
  totalFees: number;
  totalTaxes: number;
  totalDividends: number;
  totalIncome: number; // dividends + interest + rent
  currentValue: number;
  gainLoss: number;
  gainLossPercent: number;
  transactions: PortfolioTransaction[];
}
