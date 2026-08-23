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
import { exchangeRateKeys } from '@/lib/queryKeys';

export function useCurrencyConverter(targetCurrency: string) {
  // The endpoint's response does not depend on targetCurrency (conversion
  // happens client-side from the rate map), so the key must not include it —
  // keying per display currency cached a duplicate copy of the identical
  // payload for every currency in view. One flat key shares a single cache
  // entry with useExchangeRates and ExchangeRatesPage; staleTime/gcTime match
  // useExchangeRates (the backend scheduler owns refreshes, and the manual
  // refresh invalidates this namespace).
  const { data: exchangeData, isLoading, error } = useQuery({
    queryKey: exchangeRateKeys.all,
    queryFn: () => apiClient.getExchangeRates({ dbOnly: true }),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
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

  const convertToTargetIfAvailable = useCallback(
    (amount: number, fromCurrency?: string): number | undefined => {
      const from = (fromCurrency ?? 'EUR').toUpperCase();
      const to = targetCurrency.toUpperCase();
      if (from === to) return amount;
      const rateFrom = ratesToEur[from];
      const rateTo = ratesToEur[to];
      if (!rateFrom || !rateTo) return undefined;
      return (amount * rateFrom) / rateTo;
    },
    [ratesToEur, targetCurrency]
  );

  // Legacy display consumers intentionally retain the original-amount fallback.
  // Aggregates must use convertToTargetIfAvailable so a missing rate cannot blend
  // source and target currencies into one total.
  const convertToTarget = useCallback(
    (amount: number, fromCurrency?: string): number =>
      convertToTargetIfAvailable(amount, fromCurrency) ?? amount,
    [convertToTargetIfAvailable]
  );

  return { convertToTarget, convertToTargetIfAvailable, ratesToEur, isLoading, error };
}
