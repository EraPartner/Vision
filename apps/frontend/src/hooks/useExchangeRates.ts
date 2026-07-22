/**
 * Exchange-rate map for client-side FX conversion.
 *
 * Mirrors the backend's rate model: every rate is `rate_to_eur`, so converting
 * A → B is `amount × rate(A) / rate(B)`. Database rates win over fallback
 * constants (same precedence as the backend conversion service). While the
 * query is in flight (or on error) the map only contains EUR, and
 * `multiplierFor` falls back to 1 — callers degrade to unconverted values
 * instead of blanking out.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getExchangeRates } from '@/lib/api/info';
import { exchangeRateKeys } from '@/lib/queryKeys';

export interface ExchangeRateMap {
  /** rate_to_eur per upper-cased currency code (EUR = 1). */
  rateToEur: Map<string, number>;
  /** Multiplier converting `from` → `to`; 1 when either rate is unknown. */
  multiplierFor: (from: string, to: string) => number;
  isLoading: boolean;
}

export function useExchangeRates(): ExchangeRateMap {
  const query = useQuery({
    queryKey: exchangeRateKeys.all,
    // db_only: read-through of stored rates — never triggers external fetches
    // from a passive consumer (the backend scheduler owns refreshes).
    queryFn: () => getExchangeRates({ dbOnly: true }),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
  });

  const rateToEur = useMemo(() => {
    const map = new Map<string, number>([['EUR', 1]]);
    for (const [currency, rate] of Object.entries(query.data?.fallback_rates ?? {})) {
      if (Number(rate) > 0) map.set(currency.toUpperCase(), Number(rate));
    }
    for (const row of query.data?.rates ?? []) {
      if (Number(row.rate_to_eur) > 0) map.set(row.currency.toUpperCase(), Number(row.rate_to_eur));
    }
    return map;
  }, [query.data]);

  const multiplierFor = useMemo(() => {
    return (from: string, to: string): number => {
      const f = (from || 'EUR').toUpperCase();
      const t = (to || 'EUR').toUpperCase();
      if (f === t) return 1;
      const rateFrom = rateToEur.get(f);
      const rateTo = rateToEur.get(t);
      if (!rateFrom || !rateTo) return 1;
      return rateFrom / rateTo;
    };
  }, [rateToEur]);

  return { rateToEur, multiplierFor, isLoading: query.isLoading };
}
