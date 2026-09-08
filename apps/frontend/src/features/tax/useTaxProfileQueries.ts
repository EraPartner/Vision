import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";

export function useTaxIncomeCategories() {
    return useQuery({
        queryKey: ["categories", "all-for-tax-profile"],
        queryFn: async () => {
            const response = await apiClient.getCategories({
                limit: 500,
                active: true,
            });
            return response.items;
        },
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
    });
}
