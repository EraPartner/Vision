import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import { useLanguage } from '@/stores/hydration/LanguageHydration';
import { apiClient } from '@/lib/api';
import { importKeys } from '@/lib/queryKeys';
import type { PortfolioCustomConfig } from '@/lib/api/portfolioImports';

export function usePortfolioParserConfigs() {
  return useQuery({
    queryKey: importKeys.portfolioParserConfigs,
    queryFn: () => apiClient.listPortfolioParserConfigs(),
    staleTime: 60_000,
  });
}

export function useCreatePortfolioParserConfig() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: ({ name, config }: { name: string; config: PortfolioCustomConfig }) =>
      apiClient.createPortfolioParserConfig(name, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: importKeys.portfolioParserConfigs });
      toast.success(t('importPage.customParser.saved'));
    },
    onError: (error: Error) => {
      toast.error(t('importPage.customParser.saveFailed'), { description: apiErrorToMessage(error, t) });
    },
  });
}

export function useUpdatePortfolioParserConfig() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number; name?: string; config?: PortfolioCustomConfig }) =>
      apiClient.updatePortfolioParserConfig(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: importKeys.portfolioParserConfigs });
      toast.success(t('importPage.customParser.updated'));
    },
    onError: (error: Error) => {
      toast.error(t('importPage.customParser.saveFailed'), { description: apiErrorToMessage(error, t) });
    },
  });
}

export function useDeletePortfolioParserConfig() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: (id: number) => apiClient.deletePortfolioParserConfig(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: importKeys.portfolioParserConfigs });
      toast.success(t('importPage.customParser.deleted'));
    },
    onError: (error: Error) => {
      toast.error(t('importPage.customParser.deleteFailed'), { description: apiErrorToMessage(error, t) });
    },
  });
}
