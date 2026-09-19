import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";

export function useTaxIncomeCategories() {
    return useQuery({
        queryKey: ["categories", "all-for-tax-profile"],
        queryFn: async () => {
            const response = await apiClient.getCategoryTree();
            return response.items.filter((category) => category.is_active);
        },
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
    });
}
