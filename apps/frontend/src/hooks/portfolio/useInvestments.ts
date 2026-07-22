/**
 * Portfolio data queries and mutations.
 * Pure TanStack Query layer — no calculations.
 */

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { invalidateInvestmentData, portfolioKeys } from '@/lib/queryKeys';
import type {
  InvestmentCreate,
  InvestmentUpdate,
  PortfolioTransactionCreate,
} from '@/types/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

export function useInvestmentsQuery() {
  return useQuery({
    queryKey: portfolioKeys.investments,
    queryFn: () => apiClient.getInvestments({ limit: 500, active: false }),
    staleTime: 2 * 60_000,
    gcTime: 10 * 60_000,
  });
}

export function usePortfolioTransactionsQuery(investmentIds: number[]) {
  return useQuery({
    queryKey: portfolioKeys.transactions(investmentIds.join(',')),
    queryFn: async () => {
      if (investmentIds.length === 0) return [];
      try {
        const bulk = await apiClient.getPortfolioTransactionsBulk({
          investment_ids: investmentIds.join(','),
          per_investment_limit: 1000,
        });
        return bulk.items;
      } catch {
        const results = await Promise.all(
          investmentIds.map((id) => apiClient.getPortfolioTransactions(id, { limit: 1000 }))
        );
        return results.flatMap((r) => r.items);
      }
    },
    enabled: investmentIds.length > 0,
    staleTime: 2 * 60_000,
    gcTime: 10 * 60_000,
  });
}

export function useInvestmentMutations() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  const invalidateAll = useCallback(() => {
    invalidateInvestmentData(queryClient);
  }, [queryClient]);

  const addInvestmentMutation = useMutation({
    mutationFn: (data: InvestmentCreate) => apiClient.createInvestment(data),
    onSuccess: invalidateAll,
    onError: (err: Error) =>
      toast.error(t('portfolio.createInvestmentFailedTitle'), { description: err.message }),
  });

  const updateInvestmentMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: InvestmentUpdate }) =>
      apiClient.updateInvestment(id, data),
    onSuccess: invalidateAll,
    onError: (err: Error) =>
      toast.error(t('portfolio.updateInvestmentFailedTitle'), { description: err.message }),
  });

  const deleteInvestmentMutation = useMutation({
    mutationFn: (id: number) => apiClient.deleteInvestment(id),
    onSuccess: invalidateAll,
    onError: (err: Error) =>
      toast.error(t('portfolio.deleteInvestmentFailedTitle'), { description: err.message }),
  });

  const addTxnMutation = useMutation({
    mutationFn: ({
      investmentId,
      data,
    }: {
      investmentId: number;
      data: PortfolioTransactionCreate;
    }) => apiClient.createPortfolioTransaction(investmentId, data),
    onSuccess: invalidateAll,
    onError: (err: Error) =>
      toast.error(t('portfolio.recordTxnFailedTitle'), { description: err.message }),
  });

  const deleteTxnMutation = useMutation({
    mutationFn: (id: number) => apiClient.deletePortfolioTransaction(id),
    onSuccess: invalidateAll,
    onError: (err: Error) =>
      toast.error(t('portfolio.deleteTxnFailedTitle'), { description: err.message }),
  });

  const updateTxnMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Partial<PortfolioTransactionCreate>;
    }) => apiClient.updatePortfolioTransaction(id, data),
    onSuccess: invalidateAll,
    onError: (err: Error) =>
      toast.error(t('portfolio.recordTxnFailedTitle'), { description: err.message }),
  });

  const refreshPricesMutation = useMutation({
    mutationFn: () => apiClient.refreshInvestmentPrices(),
    onSuccess: (data) => {
      invalidateAll();
      const sources = Object.values(data.priceSources ?? {});
      const staleCount = sources.filter(
        (s) => s === 'historical_fallback' || s === 'cached',
      ).length;
      // Stable id => Sonner replaces, never stacks duplicates on rapid re-clicks.
      if (staleCount > 0) {
        toast.warning(t('portfolio.refreshedPrices', { n: String(data.total) }), {
          id: 'portfolio-refresh-prices',
          description: t('portfolio.refreshedPricesStale', {
            n: String(staleCount),
            total: String(data.total),
          }),
        });
      } else {
        toast.success(t('portfolio.refreshedPrices', { n: String(data.total) }), {
          id: 'portfolio-refresh-prices',
        });
      }
    },
    onError: (err: Error) => {
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      toast.error(t('portfolio.refreshPricesFailedTitle'), {
        id: 'portfolio-refresh-prices',
        description: isOffline ? t('portfolio.refreshPricesOffline') : err.message,
      });
    },
  });

  const addInvestment = useCallback(
    (data: InvestmentCreate) => addInvestmentMutation.mutateAsync(data),
    [addInvestmentMutation]
  );

  const updateInvestment = useCallback(
    (id: number, data: InvestmentUpdate) =>
      updateInvestmentMutation.mutateAsync({ id, data }),
    [updateInvestmentMutation]
  );

  const deleteInvestment = useCallback(
    (id: number) => deleteInvestmentMutation.mutate(id),
    [deleteInvestmentMutation]
  );

  const addTransaction = useCallback(
    (data: { investmentId: number } & PortfolioTransactionCreate) => {
      const { investmentId, ...txnData } = data;
      return addTxnMutation.mutateAsync({ investmentId, data: txnData });
    },
    [addTxnMutation]
  );

  const deleteTransaction = useCallback(
    (id: number) => deleteTxnMutation.mutate(id),
    [deleteTxnMutation]
  );

  const updateTransaction = useCallback(
    (id: number, data: Partial<PortfolioTransactionCreate>) =>
      updateTxnMutation.mutateAsync({ id, data }),
    [updateTxnMutation]
  );

  const refreshPrices = useCallback(
    () => refreshPricesMutation.mutate(),
    [refreshPricesMutation]
  );

  return {
    addInvestment,
    updateInvestment,
    deleteInvestment,
    addTransaction,
    deleteTransaction,
    updateTransaction,
    refreshPrices,
    isRefreshingPrices: refreshPricesMutation.isPending,
    isAddingInvestment: addInvestmentMutation.isPending,
    isUpdatingInvestment: updateInvestmentMutation.isPending,
    isAddingTransaction: addTxnMutation.isPending,
    isUpdatingTransaction: updateTxnMutation.isPending,
  };
}
