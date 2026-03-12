import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type {
  Investment, InvestmentCreate, InvestmentUpdate,
  PortfolioTransaction, PortfolioTransactionCreate,
  AssetClass,
} from '@/types/api';
import type { InvestmentSummary, PortfolioTxnType } from '@/types/portfolio';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

// ---- queries ----

function useInvestmentsQuery() {
  return useQuery({
    queryKey: ['investments'],
    queryFn: () => apiClient.getInvestments({ limit: 500, active: false }),
    staleTime: 30_000,
  });
}

function usePortfolioTransactionsQuery(investmentIds: number[]) {
  return useQuery({
    queryKey: ['portfolio-transactions', investmentIds],
    queryFn: async () => {
      if (investmentIds.length === 0) return [];
      const results = await Promise.all(
        investmentIds.map((id) => apiClient.getPortfolioTransactions(id, { limit: 1000 }))
      );
      return results.flatMap((r) => r.items);
    },
    enabled: investmentIds.length > 0,
    staleTime: 30_000,
  });
}

// ---- calculation helpers ----

interface CostBasisResult {
  totalUnits: number;
  totalCost: number;           // Cost basis of current holdings
  avgCostBasis: number;        // Weighted average cost per unit
  realizedGain: number;        // Profit/loss from closed positions
  totalBuyCost: number;        // Total spent on buys (incl fees)
  totalSellProceeds: number;   // Total received from sells
}

/**
 * Calculate weighted average cost basis using FIFO-like weighted method
 * Fees are added to cost basis on buys, subtracted from proceeds on sells
 */
function calculateCostBasis(txns: PortfolioTransaction[]): CostBasisResult {
  // Sort chronologically for proper cost basis tracking
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
  
  let totalUnits = 0;
  let totalCost = 0;  // Cost basis of current holdings
  let realizedGain = 0;
  let totalBuyCost = 0;
  let totalSellProceeds = 0;

  for (const txn of sorted) {
    const units = Number(txn.units) || 0;
    const amount = Number(txn.amount) || 0;
    const fees = Number(txn.fees) || 0;
    const taxes = Number(txn.taxes) || 0;

    if (txn.type === 'buy') {
      // Add units at their cost (amount + fees are the cost)
      const buyCost = amount + fees + taxes;
      totalUnits += units;
      totalCost += buyCost;
      totalBuyCost += buyCost;
    } else if (txn.type === 'sell') {
      if (totalUnits > 0 && units > 0) {
        // Calculate average cost of units being sold
        const avgCost = totalCost / totalUnits;
        const costOfSoldUnits = avgCost * units;
        
        // Proceeds minus cost minus fees = realized gain
        const netProceeds = amount - fees - taxes;
        realizedGain += netProceeds - costOfSoldUnits;
        
        // Remove sold units from pool
        totalUnits -= units;
        totalCost -= costOfSoldUnits;
        totalSellProceeds += amount;
      }
    }
  }

  // Ensure no negative units due to floating point
  totalUnits = Math.max(0, totalUnits);
  totalCost = Math.max(0, totalCost);

  return {
    totalUnits,
    totalCost,
    avgCostBasis: totalUnits > 0 ? totalCost / totalUnits : 0,
    realizedGain,
    totalBuyCost,
    totalSellProceeds,
  };
}

/**
 * Calculate accrued interest for fixed income assets
 */
function calculateAccruedInterest(
  txns: PortfolioTransaction[],
  principal: number,
  interestRate: number
): number {
  if (!interestRate || principal <= 0) return 0;

  // Find last interest payment or first buy
  const sortedTxns = [...txns].sort((a, b) => b.date.localeCompare(a.date));
  const lastInterestTxn = sortedTxns.find(t => t.type === 'interest');
  const firstBuyTxn = [...txns]
    .filter(t => t.type === 'buy')
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  const startDate = lastInterestTxn?.date || firstBuyTxn?.date;
  if (!startDate) return 0;

  const start = new Date(startDate);
  const now = new Date();
  const daysSinceStart = Math.max(0, (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  
  // Simple interest calculation: P * r * t
  const dailyRate = interestRate / 100 / 365;
  return principal * dailyRate * daysSinceStart;
}

/**
 * Calculate projected annual interest
 */
function calculateProjectedAnnualInterest(principal: number, interestRate: number): number {
  if (!interestRate || principal <= 0) return 0;
  return principal * (interestRate / 100);
}

// ---- main hook ----

export function usePortfolio() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  const { data: invData } = useInvestmentsQuery();
  const investments = invData?.items ?? [];
  const investmentIds = useMemo(() => investments.map((i) => i.id), [investments]);
  const { data: transactions = [] } = usePortfolioTransactionsQuery(investmentIds);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['investments'] });
    queryClient.invalidateQueries({ queryKey: ['portfolio-transactions'] });
  };

  // ---- mutations ----

    const addInvestmentMutation = useMutation({
    mutationFn: (data: InvestmentCreate) => apiClient.createInvestment(data),
    onSuccess: () => invalidateAll(),
    onError: (err: Error) => toast.error(t('portfolio.createInvestmentFailedTitle'), { description: err.message }),
    });

    const updateInvestmentMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: InvestmentUpdate }) => apiClient.updateInvestment(id, data),
    onSuccess: () => invalidateAll(),
    onError: (err: Error) => toast.error(t('portfolio.updateInvestmentFailedTitle'), { description: err.message }),
    });

    const deleteInvestmentMutation = useMutation({
    mutationFn: (id: number) => apiClient.deleteInvestment(id),
    onSuccess: () => invalidateAll(),
    onError: (err: Error) => toast.error(t('portfolio.deleteInvestmentFailedTitle'), { description: err.message }),
    });

    const addTxnMutation = useMutation({
    mutationFn: ({ investmentId, data }: { investmentId: number; data: PortfolioTransactionCreate }) =>
      apiClient.createPortfolioTransaction(investmentId, data),
    onSuccess: () => invalidateAll(),
    onError: (err: Error) => toast.error(t('portfolio.recordTxnFailedTitle'), { description: err.message }),
    });

    const deleteTxnMutation = useMutation({
    mutationFn: (id: number) => apiClient.deletePortfolioTransaction(id),
    onSuccess: () => invalidateAll(),
    onError: (err: Error) => toast.error(t('portfolio.deleteTxnFailedTitle'), { description: err.message }),
    });

  // ---- wrapper functions (keep same interface for pages) ----

  const addInvestment = useCallback((data: Omit<InvestmentCreate, never>) => {
    return addInvestmentMutation.mutateAsync({
      name: data.name,
      symbol: data.symbol,
      asset_class: data.asset_class,
      currency: data.currency,
      current_price: data.current_price,
      interest_rate: data.interest_rate,
      maturity_date: data.maturity_date,
      location: data.location,
      notes: data.notes,
      price_provider: data.price_provider,
      price_provider_id: data.price_provider_id,
      price_provider_url: data.price_provider_url,
    });
  }, [addInvestmentMutation]);

  const updateInvestment = useCallback((id: number, data: InvestmentUpdate) => {
    updateInvestmentMutation.mutate({ id, data });
  }, [updateInvestmentMutation]);

  const deleteInvestment = useCallback((id: number) => {
    deleteInvestmentMutation.mutate(id);
  }, [deleteInvestmentMutation]);

  const addTransaction = useCallback((data: { investmentId: number } & PortfolioTransactionCreate) => {
    const { investmentId, ...txnData } = data;
    return addTxnMutation.mutateAsync({ investmentId, data: txnData });
  }, [addTxnMutation]);

  const deleteTransaction = useCallback((id: number) => {
    deleteTxnMutation.mutate(id);
  }, [deleteTxnMutation]);

    const refreshPricesMutation = useMutation({
    mutationFn: () => apiClient.refreshInvestmentPrices(),
    onSuccess: (data) => {
      invalidateAll();
      toast.success(t('portfolio.refreshedPrices', { n: String(data.updated) }));
    },
    onError: (err: Error) => toast.error(t('portfolio.refreshPricesFailedTitle'), { description: err.message }),
    });

  const refreshPrices = useCallback(() => {
    refreshPricesMutation.mutate();
  }, [refreshPricesMutation]);

  // ---- computed summaries ----

  const summaries: InvestmentSummary[] = useMemo(() => {
    return investments.map((inv) => {
      const txns = transactions.filter((t) => t.investment_id === inv.id);
      const isUnitBased = ['stock', 'etf', 'crypto'].includes(inv.asset_class);
      const isFixedIncome = ['savings', 'bond'].includes(inv.asset_class);
      const isRealEstate = inv.asset_class === 'real_estate';

      // Calculate all fee and tax transactions
      const feeTxns = txns.filter((t) => t.type === 'fee');
      const taxTxns = txns.filter((t) => t.type === 'tax');
      const totalFees = feeTxns.reduce((s, t) => s + Number(t.amount), 0)
        + txns.reduce((s, t) => s + (Number(t.fees) || 0), 0);
      const totalTaxes = taxTxns.reduce((s, t) => s + Number(t.amount), 0)
        + txns.reduce((s, t) => s + (Number(t.taxes) || 0), 0);

      // Income calculations
      const totalDividends = txns.filter((t) => t.type === 'dividend').reduce((s, t) => s + Number(t.amount), 0);
      const totalInterestPaid = txns.filter((t) => t.type === 'interest').reduce((s, t) => s + Number(t.amount), 0);
      const totalRent = txns.filter((t) => t.type === 'rent_income').reduce((s, t) => s + Number(t.amount), 0);
      const totalAppreciation = txns.filter((t) => t.type === 'appreciation').reduce((s, t) => s + Number(t.amount), 0);

      let totalUnits = 0;
      let avgCostBasis = 0;
      let realizedGain = 0;
      let unrealizedGain = 0;
      let currentValue = 0;
      let totalInvested = 0;
      let totalBuyCost = 0;
      let totalSellProceeds = 0;
      let accruedInterest = 0;
      let projectedAnnualInterest = 0;

      if (isUnitBased) {
        // Use weighted average cost basis for stocks/ETFs/crypto
        const costBasis = calculateCostBasis(txns);
        totalUnits = costBasis.totalUnits;
        avgCostBasis = costBasis.avgCostBasis;
        realizedGain = costBasis.realizedGain;
        totalBuyCost = costBasis.totalBuyCost;
        totalSellProceeds = costBasis.totalSellProceeds;
        totalInvested = costBasis.totalCost; // Current cost basis
        
        // Current value = units * current price
        const currentPrice = Number(inv.current_price) || 0;
        currentValue = totalUnits * currentPrice;
        
        // Unrealized = (current price - avg cost) * units held
        unrealizedGain = totalUnits > 0 ? (currentPrice - avgCostBasis) * totalUnits : 0;
        
      } else if (isFixedIncome) {
        // Savings accounts and bonds: principal-based
        const buys = txns.filter((t) => t.type === 'buy');
        const sells = txns.filter((t) => t.type === 'sell');
        const totalBuyAmount = buys.reduce((s, t) => s + Number(t.amount), 0);
        const totalSellAmount = sells.reduce((s, t) => s + Number(t.amount), 0);
        
        totalInvested = totalBuyAmount - totalSellAmount;
        totalBuyCost = totalBuyAmount;
        totalSellProceeds = totalSellAmount;
        
        const interestRate = Number(inv.interest_rate) || 0;
        accruedInterest = calculateAccruedInterest(txns, totalInvested, interestRate);
        projectedAnnualInterest = calculateProjectedAnnualInterest(totalInvested, interestRate);
        
        // Current value = principal + accrued interest (unpaid)
        currentValue = totalInvested + accruedInterest;
        
        // Realized gain from interest payments already received
        realizedGain = totalInterestPaid;
        unrealizedGain = accruedInterest;
        
      } else if (isRealEstate) {
        // Real estate: purchase price + appreciation - depreciation
        const buys = txns.filter((t) => t.type === 'buy');
        const sells = txns.filter((t) => t.type === 'sell');
        const totalBuyAmount = buys.reduce((s, t) => s + Number(t.amount), 0);
        const totalSellAmount = sells.reduce((s, t) => s + Number(t.amount), 0);
        
        totalInvested = totalBuyAmount - totalSellAmount;
        totalBuyCost = totalBuyAmount;
        totalSellProceeds = totalSellAmount;
        
        // Current value = purchase price + appreciation
        currentValue = totalInvested + totalAppreciation;
        
        // Unrealized = appreciation, Realized = rent income (less costs)
        unrealizedGain = totalAppreciation;
        realizedGain = totalRent - totalFees - totalTaxes;
        
      } else {
        // Generic fallback
        const buys = txns.filter((t) => t.type === 'buy');
        const sells = txns.filter((t) => t.type === 'sell');
        totalInvested = buys.reduce((s, t) => s + Number(t.amount), 0) - sells.reduce((s, t) => s + Number(t.amount), 0);
        currentValue = totalInvested;
      }

      const totalIncome = totalDividends + totalInterestPaid + totalRent;
      const totalGain = realizedGain + unrealizedGain;
      
      // Legacy calculation for backwards compatibility
      const gainLoss = totalGain + totalIncome - totalFees - totalTaxes;
      const gainLossPercent = totalBuyCost > 0 ? (gainLoss / totalBuyCost) * 100 : 0;

      return {
        ...inv,
        assetClass: inv.asset_class as any,
        totalUnits,
        totalInvested: Math.abs(totalInvested),
        totalFees,
        totalTaxes,
        totalDividends,
        totalIncome,
        currentValue,
        currentPrice: Number(inv.current_price) || undefined,
        interestRate: Number(inv.interest_rate) || undefined,
        
        // Advanced metrics
        avgCostBasis,
        realizedGain,
        unrealizedGain,
        totalGain,
        gainLoss,
        gainLossPercent,
        
        // Fixed income
        accruedInterest,
        projectedAnnualInterest,
        totalAppreciation,
        
        // Cost tracking
        totalBuyCost,
        totalSellProceeds,
        
        transactions: txns.sort((a, b) => b.date.localeCompare(a.date)),
      } as InvestmentSummary;
    });
  }, [investments, transactions]);

  const byAssetClass = useCallback((cls: AssetClass | AssetClass[]) => {
    const classes = Array.isArray(cls) ? cls : [cls];
    return summaries.filter((s) => classes.includes(s.assetClass));
  }, [summaries]);

  const totalPortfolioValue = useMemo(() => summaries.reduce((s, i) => s + i.currentValue, 0), [summaries]);
  const totalGainLoss = useMemo(() => summaries.reduce((s, i) => s + i.gainLoss, 0), [summaries]);
  const totalRealizedGain = useMemo(() => summaries.reduce((s, i) => s + i.realizedGain, 0), [summaries]);
  const totalUnrealizedGain = useMemo(() => summaries.reduce((s, i) => s + i.unrealizedGain, 0), [summaries]);

  return {
    investments, transactions, summaries,
    addInvestment, updateInvestment, deleteInvestment,
    addTransaction, deleteTransaction,
    refreshPrices, isRefreshingPrices: refreshPricesMutation.isPending,
    byAssetClass, totalPortfolioValue, totalGainLoss,
    totalRealizedGain, totalUnrealizedGain,
  };
}
