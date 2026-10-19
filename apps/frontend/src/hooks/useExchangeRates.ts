import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
/**
 * FX freshness status for the banner. Client-side conversion lives in
 * `useCurrencyConverter` (stored rates only, ADR-216).
 */

import { useQuery } from "@tanstack/react-query";
import { getExchangeRates } from "@/lib/api/info";
import { exchangeRateKeys } from "@/lib/queryKeys";
import type { ExchangeRatesData } from "@/lib/api/info";

export function useFxStatus() {
    return useQuery<ExchangeRatesData>({
        queryKey: exchangeRateKeys.fxStatus,
        queryFn: () => getExchangeRates({ dbOnly: true }),
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
        retry: false,
    });
}
