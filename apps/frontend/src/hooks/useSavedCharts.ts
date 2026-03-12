import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type SavedChart, type SavedChartCreate } from '@/lib/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

export type { SavedChart };

export function useSavedCharts() {
  return useQuery({
    queryKey: ['saved-charts'],
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
      queryClient.invalidateQueries({ queryKey: ['saved-charts'] });
      toast.success(t('charts.saved'));
    },
    onError: (error: Error) => {
      toast.error(t('charts.saveFailed'), { description: error.message });
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
      queryClient.invalidateQueries({ queryKey: ['saved-charts'] });
    },
    onError: (error: Error) => {
      toast.error(t('charts.updateFailed'), { description: error.message });
    },
  });
}

export function useDeleteSavedChart() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: (id: number) => apiClient.deleteSavedChart(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-charts'] });
      toast.success(t('charts.deleted'));
    },
    onError: (error: Error) => {
      toast.error(t('charts.deleteFailed'), { description: error.message });
    },
  });
}
