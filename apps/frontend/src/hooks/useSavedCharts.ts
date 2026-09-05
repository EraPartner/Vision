import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type SavedChart, type SavedChartCreate } from '@/lib/api';
import { toast } from 'sonner';
import { savedChartKeys } from '@/lib/queryKeys';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import { useLanguage } from '@/stores/hydration/LanguageHydration';

export type { SavedChart };

export function useSavedCharts() {
  return useQuery({
    queryKey: savedChartKeys.all,
    queryFn: () => apiClient.getSavedCharts(),
    staleTime: 60_000,
  });
}

export function useCreateSavedChart() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: (payload: SavedChartCreate) => apiClient.createSavedChart(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: savedChartKeys.all });
      toast.success(t('charts.saved'));
    },
    onError: (error: Error) => {
      toast.error(t('charts.saveFailed'), { description: apiErrorToMessage(error, t) });
    },
  });
}

export function useUpdateSavedChart() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: ({ id, ...payload }: { id: number } & Partial<SavedChartCreate>) =>
      apiClient.updateSavedChart(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: savedChartKeys.all });
    },
    onError: (error: Error) => {
      toast.error(t('charts.updateFailed'), { description: apiErrorToMessage(error, t) });
    },
  });
}

export function useDeleteSavedChart() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: (id: number) => apiClient.deleteSavedChart(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: savedChartKeys.all });
      toast.success(t('charts.deleted'));
    },
    onError: (error: Error) => {
      toast.error(t('charts.deleteFailed'), { description: apiErrorToMessage(error, t) });
    },
  });
}
