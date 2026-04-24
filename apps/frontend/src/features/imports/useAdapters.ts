import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

export interface BankAdapter {
  key: string;
  name: string;
  adapter_class: string;
}

export function useAdapters() {
  const { t } = useLanguage();
  const [adapters, setAdapters] = useState<BankAdapter[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiClient.getSupportedParsers()
      .then(res => { if (mounted && res?.adapters) setAdapters(res.adapters); })
      .catch(() => { if (mounted) toast.error(t('importPage.toast.parsersError')); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [t]);

  return { adapters, loading };
}
