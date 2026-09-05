import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import {
    getDbStats,
    getEndpointManifest,
    getProviderHealth,
    getRequestMetrics,
} from "@/lib/api/admin";
import type { ExchangeRatesData } from "@/lib/api/info";
import { adminKeys, exchangeRateKeys } from "@/lib/queryKeys";

export function useDbStats(staleTime = 30_000) {
    return useQuery({
        queryKey: adminKeys.dbStats,
        queryFn: getDbStats,
        staleTime,
    });
}

export function useAdminOverviewQueries() {
    const dbStats = useDbStats(60_000);
    const providers = useQuery({
        queryKey: adminKeys.providerHealth,
        queryFn: getProviderHealth,
        staleTime: 30_000,
    });
    const metrics = useQuery({
        queryKey: adminKeys.requestMetrics,
        queryFn: getRequestMetrics,
        staleTime: 15_000,
    });
    return { dbStats, providers, metrics };
}

export function useEndpointLivenessQueries() {
    const manifest = useQuery({
        queryKey: adminKeys.endpoints,
        queryFn: getEndpointManifest,
        staleTime: 300_000,
    });
    const metrics = useQuery({
        queryKey: adminKeys.requestMetrics,
        queryFn: getRequestMetrics,
        staleTime: 15_000,
    });
    return { manifest, metrics };
}

export function useProviderHealthQuery() {
    return useQuery({
        queryKey: adminKeys.providerHealth,
        queryFn: getProviderHealth,
        staleTime: 30_000,
    });
}

export function useExchangeRatesQuery() {
    return useQuery<ExchangeRatesData>({
        queryKey: exchangeRateKeys.all,
        queryFn: () => apiClient.getExchangeRates({ dbOnly: true }),
        staleTime: 10 * 60_000,
        gcTime: 30 * 60_000,
    });
}
