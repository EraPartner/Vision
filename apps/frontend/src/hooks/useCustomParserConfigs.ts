import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type SavedParserConfig, type CustomParserConfigPayload } from '@/lib/api';
import { toast } from 'sonner';
import { importKeys } from '@/lib/queryKeys';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import { useLanguage } from '@/contexts/LanguageContext';

export type { SavedParserConfig, CustomParserConfigPayload };

export function useCustomParserConfigs() {
  return useQuery({
    queryKey: importKeys.customParserConfigs,
    queryFn: () => apiClient.listCustomParserConfigs(),
    staleTime: 60_000,
  });
}

export function useCreateCustomParserConfig() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: ({ name, config }: { name: string; config: CustomParserConfigPayload }) =>
      apiClient.createCustomParserConfig(name, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: importKeys.customParserConfigs });
      toast.success(t('importPage.customParser.saved'));
    },
    onError: (error: Error) => {
      toast.error(t('importPage.customParser.saveFailed'), { description: apiErrorToMessage(error, t) });
    },
  });
}

export function useUpdateCustomParserConfig() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number; name?: string; config?: CustomParserConfigPayload }) =>
      apiClient.updateCustomParserConfig(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: importKeys.customParserConfigs });
      toast.success(t('importPage.customParser.updated'));
    },
    onError: (error: Error) => {
      toast.error(t('importPage.customParser.saveFailed'), { description: apiErrorToMessage(error, t) });
    },
  });
}

export function useDeleteCustomParserConfig() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: (id: number) => apiClient.deleteCustomParserConfig(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: importKeys.customParserConfigs });
      toast.success(t('importPage.customParser.deleted'));
    },
    onError: (error: Error) => {
      toast.error(t('importPage.customParser.deleteFailed'), { description: apiErrorToMessage(error, t) });
    },
  });
}
