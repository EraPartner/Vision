/**
 * Provides a stable convertToTarget(amount, fromCurrency?) callback and
 * the ratesToEur map for pages that need direct rate access.
 *
 * Replaces the inline FX query + ratesToEur memo + convertToTarget callback
 * that was duplicated across every portfolio page.
 */

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

export const EXCHANGE_RATES_QUERY_KEY_PREFIX = 'exchange-rates';

export function useCurrencyConverter(targetCurrency: string) {
  const { data: exchangeData, isLoading, error } = useQuery({
    queryKey: [EXCHANGE_RATES_QUERY_KEY_PREFIX, targetCurrency],
    queryFn: () => apiClient.getExchangeRates({ dbOnly: true }),
    staleTime: 60_000,
  });

  // Fallback rates are hardcoded constants that only fill gaps the live DB
  // rates don't cover — so they must be spread first (lowest priority) and the
  // live rates last, otherwise stale constants shadow real rates.
  const ratesToEur: Record<string, number> = useMemo(() => ({
    ...(exchangeData?.fallback_rates ?? {}),
    EUR: 1,
    ...Object.fromEntries(
      (exchangeData?.rates ?? []).map((r) => [
        r.currency,
        Number(r.rate_to_eur),
      ])
    ),
  }), [exchangeData]);

  const convertToTarget = useCallback(
    (amount: number, fromCurrency?: string): number => {
      const from = (fromCurrency ?? 'EUR').toUpperCase();
      const to = targetCurrency.toUpperCase();
      if (from === to) return amount;
      const rateFrom = ratesToEur[from];
      const rateTo = ratesToEur[to];
      if (!rateFrom || !rateTo) return amount;
      return (amount * rateFrom) / rateTo;
    },
    [ratesToEur, targetCurrency]
  );

  return { convertToTarget, ratesToEur, isLoading, error };
}
