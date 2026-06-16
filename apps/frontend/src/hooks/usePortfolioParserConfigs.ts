import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api';
import type { PortfolioCustomConfig } from '@/lib/api/portfolioImports';

const QUERY_KEY = ['portfolio-parser-configs'];

export function usePortfolioParserConfigs() {
  return useQuery({
    queryKey: QUERY_KEY,
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
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(t('importPage.customParser.saved'));
    },
    onError: (error: Error) => {
      toast.error(t('importPage.customParser.saveFailed'), { description: error.message });
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
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(t('importPage.customParser.updated'));
    },
    onError: (error: Error) => {
      toast.error(t('importPage.customParser.saveFailed'), { description: error.message });
    },
  });
}

export function useDeletePortfolioParserConfig() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  return useMutation({
    mutationFn: (id: number) => apiClient.deletePortfolioParserConfig(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(t('importPage.customParser.deleted'));
    },
    onError: (error: Error) => {
      toast.error(t('importPage.customParser.deleteFailed'), { description: error.message });
    },
  });
}
