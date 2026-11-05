import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClassificationChanges } from "@/lib/api/portfolioExposure";
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

export const exposureClassificationsQueryKey = [
    "portfolio-exposure-classifications",
] as const;

/** Holdings with their classification, for the Classify holdings sheet. */
export function useExposureClassificationsQuery(enabled: boolean) {
    return useQuery({
        queryKey: exposureClassificationsQueryKey,
        queryFn: () => apiClient.getPortfolioExposureClassifications(),
        enabled,
    });
}

/** Save manual classifications and refresh the exposure view. */
export function useSaveExposureClassifications(onSaved: () => void) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (changes: ClassificationChanges) =>
            apiClient.savePortfolioExposureClassifications(changes),
        onSuccess: (data) => {
            queryClient.setQueryData(exposureClassificationsQueryKey, data);
            void queryClient.invalidateQueries({
                queryKey: portfolioExposureQueryKey(),
            });
            onSaved();
        },
    });
}
