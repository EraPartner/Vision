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
        staleTime: 60_000,
    });
}
