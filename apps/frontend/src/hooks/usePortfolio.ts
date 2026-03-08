import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type {
  Investment, InvestmentCreate, InvestmentUpdate,
  PortfolioTransaction, PortfolioTransactionCreate,
  AssetClass,
} from '@/types/api';
import type { InvestmentSummary } from '@/types/portfolio';
import { toast } from 'sonner';

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

// ---- main hook ----

export function usePortfolio() {
  const queryClient = useQueryClient();
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
    onError: (err: Error) => toast.error(`Failed to create investment: ${err.message}`),
  });

  const updateInvestmentMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: InvestmentUpdate }) => apiClient.updateInvestment(id, data),
    onSuccess: () => invalidateAll(),
    onError: (err: Error) => toast.error(`Failed to update investment: ${err.message}`),
  });

  const deleteInvestmentMutation = useMutation({
    mutationFn: (id: number) => apiClient.deleteInvestment(id),
    onSuccess: () => invalidateAll(),
    onError: (err: Error) => toast.error(`Failed to delete investment: ${err.message}`),
  });

  const addTxnMutation = useMutation({
    mutationFn: ({ investmentId, data }: { investmentId: number; data: PortfolioTransactionCreate }) =>
      apiClient.createPortfolioTransaction(investmentId, data),
    onSuccess: () => invalidateAll(),
    onError: (err: Error) => toast.error(`Failed to record transaction: ${err.message}`),
  });

  const deleteTxnMutation = useMutation({
    mutationFn: (id: number) => apiClient.deletePortfolioTransaction(id),
    onSuccess: () => invalidateAll(),
    onError: (err: Error) => toast.error(`Failed to delete transaction: ${err.message}`),
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

  // ---- computed summaries ----

  const summaries: InvestmentSummary[] = useMemo(() => {
    return investments.map((inv) => {
      const txns = transactions.filter((t) => t.investment_id === inv.id);
      const buys = txns.filter((t) => t.type === 'buy');
      const sells = txns.filter((t) => t.type === 'sell');
      const totalBuyUnits = buys.reduce((s, t) => s + (Number(t.units) || 0), 0);
      const totalSellUnits = sells.reduce((s, t) => s + (Number(t.units) || 0), 0);
      const totalUnits = totalBuyUnits - totalSellUnits;
      const totalInvested = buys.reduce((s, t) => s + Number(t.amount), 0) - sells.reduce((s, t) => s + Number(t.amount), 0);
      const totalFees = txns.filter((t) => t.type === 'fee').reduce((s, t) => s + Number(t.amount), 0)
        + txns.reduce((s, t) => s + (Number(t.fees) || 0), 0);
      const totalTaxes = txns.filter((t) => t.type === 'tax').reduce((s, t) => s + Number(t.amount), 0)
        + txns.reduce((s, t) => s + (Number(t.taxes) || 0), 0);
      const totalDividends = txns.filter((t) => t.type === 'dividend').reduce((s, t) => s + Number(t.amount), 0);
      const totalInterest = txns.filter((t) => t.type === 'interest').reduce((s, t) => s + Number(t.amount), 0);
      const totalRent = txns.filter((t) => t.type === 'rent_income').reduce((s, t) => s + Number(t.amount), 0);
      const totalIncome = totalDividends + totalInterest + totalRent;

      let currentValue: number;
      if (['stock', 'etf', 'crypto'].includes(inv.asset_class)) {
        currentValue = (Number(inv.current_price) || 0) * totalUnits;
      } else if (inv.asset_class === 'real_estate') {
        const appreciations = txns.filter((t) => t.type === 'appreciation').reduce((s, t) => s + Number(t.amount), 0);
        currentValue = totalInvested + appreciations;
      } else {
        currentValue = totalInvested + totalInterest;
      }

      const gainLoss = currentValue - totalInvested - totalFees - totalTaxes + totalIncome;
      const gainLossPercent = totalInvested > 0 ? (gainLoss / totalInvested) * 100 : 0;

      return {
        ...inv,
        // Map DB field to portfolio type field
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
        gainLoss,
        gainLossPercent,
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

  return {
    investments, transactions, summaries,
    addInvestment, updateInvestment, deleteInvestment,
    addTransaction, deleteTransaction,
    byAssetClass, totalPortfolioValue, totalGainLoss,
  };
}
