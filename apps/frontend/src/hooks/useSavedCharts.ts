import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type SavedChart, type SavedChartCreate } from '@/lib/api';
import { toast } from 'sonner';

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
  return useMutation({
    mutationFn: (payload: SavedChartCreate) => apiClient.createSavedChart(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-charts'] });
      toast.success('Chart saved');
    },
    onError: (error: Error) => {
      toast.error(`Failed to save chart: ${error.message}`);
    },
  });
}

export function useUpdateSavedChart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: { id: number } & Partial<SavedChartCreate>) =>
      apiClient.updateSavedChart(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-charts'] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to update chart: ${error.message}`);
    },
  });
}

export function useDeleteSavedChart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.deleteSavedChart(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-charts'] });
      toast.success('Chart deleted');
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete chart: ${error.message}`);
    },
  });
}
