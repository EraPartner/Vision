import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import type { CurrencyCode } from "@vision/types/brands";

export const portfolioExposureQueryKey = (currency?: CurrencyCode) =>
    currency
        ? (["portfolio-exposure", currency] as const)
        : (["portfolio-exposure"] as const);

export function usePortfolioExposureQuery(currency: CurrencyCode) {
    return useQuery({
        queryKey: portfolioExposureQueryKey(currency),
        queryFn: () => apiClient.getPortfolioExposure(currency),
    });
}
