import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import {
  mapFromAPI,
  mapToCreateAPI,
  mapToUpdateAPI,
  type PlannedPayment,
} from "@/lib/plannedPaymentMapper";
import type { PlannedTransactionExecuteRequest } from "@/types/api";

// The PlannedPayment view model and its wire-shape mappers live in
// lib/plannedPaymentMapper.ts (pure, unit-tested); re-export the type so
// consumers keep importing it from here.
export type { PlannedPayment } from "@/lib/plannedPaymentMapper";

export function usePlannedPayments(showInactive: boolean = false) {
  const queryClient = useQueryClient();
  const queryKey = ["plannedTransactions", showInactive] as const;

  const {
    data: payments = [],
    isLoading: loading,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await apiClient.getPlannedTransactions({
        active: !showInactive,
        limit: 1000,
      });
      return response.items.map(mapFromAPI);
    },
  });

  // The app-wide "upcoming payments" banner is a separate React Query cache
  // (['upcomingPlannedPayments', queryDate]). Every mutating path must bust it
  // or the banner shows stale data for up to its staleTime.
  const invalidateUpcoming = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["upcomingPlannedPayments"] });
  }, [queryClient]);

  // Mutations write the SERVER RESPONSE into the list cache in onSuccess (not
  // optimistically) so the on-screen timing matches the old await-then-splice
  // behavior exactly. The list query itself is not invalidated — the server
  // returns the mutated row, so splicing it in keeps the same single round-trip.
  const setList = useCallback(
    (updater: (prev: PlannedPayment[]) => PlannedPayment[]) => {
      queryClient.setQueryData<PlannedPayment[]>(queryKey, (prev) => updater(prev ?? []));
    },
    // queryKey is stable per showInactive; spread its member to satisfy the linter.
    [queryClient, showInactive], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const addMutation = useMutation({
    mutationFn: (payment: Omit<PlannedPayment, "id" | "created_at">) =>
      apiClient.createPlannedTransaction(mapToCreateAPI(payment)),
    onSuccess: (created) => {
      setList((prev) => [...prev, mapFromAPI(created)]);
      invalidateUpcoming();
    },
    onError: (err) => logger.error("Error creating planned payment:", err),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: number; updates: Partial<PlannedPayment> }) =>
      apiClient.updatePlannedTransaction(id, mapToUpdateAPI(updates)),
    onSuccess: (updated, { id }) => {
      setList((prev) => prev.map((p) => (p.id === id ? mapFromAPI(updated) : p)));
      invalidateUpcoming();
    },
    onError: (err) => logger.error("Error updating planned payment:", err),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiClient.deletePlannedTransaction(id),
    onSuccess: (_res, id) => {
      setList((prev) => prev.filter((p) => p.id !== id));
      invalidateUpcoming();
    },
    onError: (err) => logger.error("Error deleting planned payment:", err),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: number) => {
      const current = queryClient
        .getQueryData<PlannedPayment[]>(queryKey)
        ?.find((p) => p.id === id);
      if (!current) return Promise.resolve(null);
      return apiClient.updatePlannedTransaction(id, { is_active: !current.is_active });
    },
    onSuccess: (updated, id) => {
      if (!updated) return;
      setList((prev) => prev.map((p) => (p.id === id ? mapFromAPI(updated) : p)));
      invalidateUpcoming();
    },
    onError: (err) => logger.error("Error toggling payment active status:", err),
  });

  const executeMutation = useMutation({
    mutationFn: ({ id, transactionId, executionDate }: { id: number; transactionId: number; executionDate?: string }) => {
      const executeRequest: PlannedTransactionExecuteRequest = {
        executed_transaction_id: transactionId,
        execution_date: executionDate,
      };
      return apiClient.executePlannedTransaction(id, executeRequest);
    },
    onSuccess: (updated, { id }) => {
      setList((prev) => prev.map((p) => (p.id === id ? mapFromAPI(updated) : p)));
      invalidateUpcoming();
    },
    onError: (err) => logger.error("Error executing payment:", err),
  });

  const addPayment = useCallback(
    async (payment: Omit<PlannedPayment, "id" | "created_at">) => {
      await addMutation.mutateAsync(payment);
    },
    [addMutation],
  );

  const updatePayment = useCallback(
    async (id: number, updates: Partial<PlannedPayment>) => {
      await updateMutation.mutateAsync({ id, updates });
    },
    [updateMutation],
  );

  const deletePayment = useCallback(
    async (id: number) => {
      await deleteMutation.mutateAsync(id);
    },
    [deleteMutation],
  );

  const toggleActive = useCallback(
    async (id: number) => {
      await toggleMutation.mutateAsync(id);
    },
    [toggleMutation],
  );

  const executePayment = useCallback(
    async (id: number, transactionId: number, executionDate?: string) => {
      await executeMutation.mutateAsync({ id, transactionId, executionDate });
    },
    [executeMutation],
  );

  return {
    payments,
    addPayment,
    updatePayment,
    deletePayment,
    toggleActive,
    executePayment,
    loading,
    error: queryError ? (queryError instanceof Error ? queryError.message : "Failed to fetch planned payments") : null,
    refetch,
  };
}
