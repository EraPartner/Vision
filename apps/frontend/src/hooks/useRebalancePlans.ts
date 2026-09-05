/**
 * Saved cash-aware rebalancing plans (ADR-098). Custom target allocations are
 * persisted as one array under the `rebalance_plans` setting (no dedicated table),
 * mirroring how `backup_settings` reuses the generic key-value settings store.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api';
import { settingKeys } from '@/lib/queryKeys';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import { useLanguage } from '@/stores/hydration/LanguageHydration';
import type { RebalancePlan } from '@/lib/api/crossWorkspace';

export type { RebalancePlan };

const SETTING_KEY = 'rebalance_plans';
const QUERY_KEY = settingKeys.rebalancePlans;

export function useRebalancePlans() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<RebalancePlan[]> => {
      const res = await apiClient.getSetting(SETTING_KEY);
      const value = res?.value;
      return Array.isArray(value) ? (value as RebalancePlan[]) : [];
    },
    staleTime: 60_000,
  });

  const plans = query.data ?? [];

  const save = useMutation({
    mutationFn: (next: RebalancePlan[]) => apiClient.saveSetting(SETTING_KEY, next),
    onError: (error: Error) => {
      toast.error(t('rebalance.plan.saveFailed'), { description: apiErrorToMessage(error, t) });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const upsertPlan = async (plan: RebalancePlan) => {
    const exists = plans.some((p) => p.id === plan.id);
    const next = exists ? plans.map((p) => (p.id === plan.id ? plan : p)) : [...plans, plan];
    await save.mutateAsync(next);
    toast.success(t(exists ? 'rebalance.plan.updated' : 'rebalance.plan.saved'));
    return plan;
  };

  const deletePlan = async (id: string) => {
    const next = plans.filter((p) => p.id !== id);
    await save.mutateAsync(next);
    toast.success(t('rebalance.plan.deleted'));
  };

  return {
    plans,
    isLoading: query.isLoading,
    isSaving: save.isPending,
    upsertPlan,
    deletePlan,
  };
}
