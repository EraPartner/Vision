import Decimal from "decimal.js";

export type CostBasisMethod = "weighted_avg" | "fifo" | "lifo";

export interface PortfolioTxnLike {
  id?: number | string;
  type: string;
  date: string;
  fxMultiplier?: number | string;
  units?: number | string | null;
  amount?: number | string | null;
  fees?: number | string | null;
  taxes?: number | string | null;
}

export interface CostBasisResult {
  totalUnits: number;
  totalCost: number;
  avgCostBasis: number;
  realizedGain: number;
  totalBuyCost: number;
  totalSellProceeds: number;
}

export interface ConvertedTrack {
  currentValue: Decimal;
  totalInvested: Decimal;
  totalBuyCost: Decimal;
  totalSellProceeds: Decimal;
  avgCostBasis: Decimal;
  realizedGain: Decimal;
  unrealizedGain: Decimal;
  totalGain: Decimal;
  gainLoss: Decimal;
  gainLossPercent: Decimal;
  assetGain: Decimal;
  fxGain: Decimal;
  totalFees: Decimal;
  totalTaxes: Decimal;
  totalDividends: Decimal;
  totalIncome: Decimal;
}

export interface InvestmentSummaryCore {
  totalUnits: Decimal;
  avgCostBasis: Decimal;
  totalInvested: Decimal;
  totalBuyCost: Decimal;
  totalSellProceeds: Decimal;
  currentValue: Decimal;
  realizedGain: Decimal;
  unrealizedGain: Decimal;
  totalGain: Decimal;
  gainLoss: Decimal;
  gainLossPercent: Decimal;
  totalFees: Decimal;
  totalTaxes: Decimal;
  feeTxnAmount: Decimal;
  taxTxnAmount: Decimal;
  totalDividends: Decimal;
  totalInterestPaid: Decimal;
  totalRent: Decimal;
  totalAppreciation: Decimal;
  totalIncome: Decimal;
  accruedInterest: Decimal;
  projectedAnnualInterest: Decimal;
  /** True when a sell exceeded held units; values remain clamped and readable. */
  oversold: boolean;
  converted: ConvertedTrack;
}

export function daysBetweenYmd(fromYmd: string, toYmd: string): number;
export function calculateCostBasis(txns: PortfolioTxnLike[]): CostBasisResult;
export function calculateCostBasisFIFO(
  txns: PortfolioTxnLike[],
): CostBasisResult;
export function calculateCostBasisLIFO(
  txns: PortfolioTxnLike[],
): CostBasisResult;
export function calculateCostBasisByMethod(
  txns: PortfolioTxnLike[],
  method?: CostBasisMethod,
): CostBasisResult;
export function calculateAccruedInterest(
  txns: PortfolioTxnLike[],
  principal: number,
  interestRate: number,
  todayYmd: string,
): number;
export function projectedAnnualInterest(
  principal: number,
  ratePercent: number,
): number;
export function buildInvestmentSummaryCore(
  inv: {
    asset_class: string;
    current_price?: number | string | null;
    interest_rate?: number | string | null;
  },
  txns: PortfolioTxnLike[],
  opts: {
    costBasisMethod?: CostBasisMethod;
    todayYmd: string;
    fxMultiplierNow?: number | string;
  },
): InvestmentSummaryCore;

// ── ADR-108: partitioned per-broker positions & P&L ─────────────────────────

export interface PartitionedTxnLike extends PortfolioTxnLike {
  account_id?: number | string | null;
  source_account_id?: number | string;
  destination_account_id?: number | string;
  fee_units?: number | string;
  adjustment_kind?: "yield_reversal" | "asset_fee";
  basis_policy?: "zero_yield_only" | "carried";
  eligible_source_record_hashes?: string[];
  source_record_hash?: string;
}
export interface CustodyLot {
  acquisitionType?: string;
  sourceRecordHash?: string;
  units: Decimal;
  costBasis: Decimal;
  costBasisConv: Decimal;
  acquiredDate: string;
  acquisitionId: number | string;
  currency?: string;
  fxResolved: boolean;
}
export interface ProjectedCustodyTxn extends PartitionedTxnLike {
  consumedLots?: CustodyLot[];
  staging_row_id?: number;
  assetFeeLots?: CustodyLot[];
}

export interface InvestmentSummaryPartition {
  accountId: number | null;
  contributionKind: "position" | "non_position";
  core: InvestmentSummaryCore;
}

export interface PartitionedInvestmentSummaryCore {
  core: InvestmentSummaryCore;
  partitions: InvestmentSummaryPartition[];
  fullyAssigned: boolean;
}

export const LOT_TXN_TYPES: Set<string>;
export function areLotsFullyAssigned(txns: PartitionedTxnLike[]): boolean;
export function partitionTxnsByAccount(
  txns: PartitionedTxnLike[],
  method?: CostBasisMethod,
  opts?: { defaultFxMultiplier?: number | string },
): Map<number | null, PartitionedTxnLike[]>;
export function projectAssetTransferPartitions(
  txns: PartitionedTxnLike[],
  method?: CostBasisMethod,
  opts?: { defaultFxMultiplier?: number | string },
): Map<number | null, ProjectedCustodyTxn[]>;
export function partitionOversellDeficits(
  txns: PartitionedTxnLike[],
): Map<number, number>;
export function buildInvestmentSummaryCorePartitioned(
  inv: {
    asset_class: string;
    current_price?: number | string | null;
    interest_rate?: number | string | null;
  },
  txns: PartitionedTxnLike[],
  opts: {
    costBasisMethod?: CostBasisMethod;
    todayYmd: string;
    fxMultiplierNow?: number | string;
  },
): PartitionedInvestmentSummaryCore;
