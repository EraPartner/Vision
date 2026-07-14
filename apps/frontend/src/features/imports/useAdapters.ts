import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

export interface BankAdapter {
  key: string;
  name: string;
  adapter_class?: string;
}

export function useAdapters() {
  const { t } = useLanguage();

  // The supported-parser list is near-static; a shared React Query entry dedupes
  // the two import-page cards that each used to fetch it, and stops the refetch
  // that fired on every language switch (the old useEffect had `t` in its deps).
  const { data, isLoading, isError } = useQuery({
    queryKey: ['supported-parsers'],
    queryFn: () => apiClient.getSupportedParsers(),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (isError) toast.error(t('importPage.toast.parsersError'));
  }, [isError, t]);

  return { adapters: data?.adapters ?? [], loading: isLoading };
}
