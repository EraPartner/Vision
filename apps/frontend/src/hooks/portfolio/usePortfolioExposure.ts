import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

export const portfolioExposureQueryKey = (currency?: string) =>
    currency
        ? (["portfolio-exposure", currency] as const)
        : (["portfolio-exposure"] as const);

export function usePortfolioExposureQuery(currency: string) {
    return useQuery({
        queryKey: portfolioExposureQueryKey(currency),
        queryFn: () => apiClient.getPortfolioExposure(currency),
    });
}
