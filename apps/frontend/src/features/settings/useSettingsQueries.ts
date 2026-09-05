import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import { getResearchProviderKeys } from "@/lib/api/research";
import { recipientKeys, researchKeys, settingKeys } from "@/lib/queryKeys";

export function useResearchProviderKeys() {
    return useQuery({
        queryKey: researchKeys.providerKeys,
        queryFn: getResearchProviderKeys,
        staleTime: 60_000,
    });
}

export function useStatisticsRecipientOptions() {
    return useQuery({
        queryKey: recipientKeys.allList,
        queryFn: () => apiClient.getRecipients({ limit: 1000 }),
        staleTime: 60_000,
    });
}

export function useSetting(key: string) {
    return useQuery({
        queryKey: settingKeys.byKey(key),
        queryFn: () => apiClient.getSetting(key),
        staleTime: 60_000,
    });
}

export interface BrokerageCashCategoryIds {
    dividend: number | null;
    interest: number | null;
    fee: number | null;
    tax: number | null;
}

export const EMPTY_BROKERAGE_CASH_CATEGORY_IDS: BrokerageCashCategoryIds = {
    dividend: null,
    interest: null,
    fee: null,
    tax: null,
};

const BROKERAGE_CASH_CATEGORY_KEY = "brokerage_cash_category_ids";

export function useBrokerageCashCategoryIds() {
    const queryClient = useQueryClient();
    const queryKey = settingKeys.byKey(BROKERAGE_CASH_CATEGORY_KEY);
    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<BrokerageCashCategoryIds> => {
            const result = await apiClient.getSetting(
                BROKERAGE_CASH_CATEGORY_KEY,
            );
            const value =
                result.value as Partial<BrokerageCashCategoryIds> | null;
            return { ...EMPTY_BROKERAGE_CASH_CATEGORY_IDS, ...(value ?? {}) };
        },
        staleTime: 60_000,
    });
    const save = useMutation({
        mutationFn: (value: BrokerageCashCategoryIds) =>
            apiClient.saveSetting(BROKERAGE_CASH_CATEGORY_KEY, value),
        onSuccess: (result) => {
            queryClient.setQueryData(queryKey, result.value);
        },
    });
    return {
        value: query.data ?? EMPTY_BROKERAGE_CASH_CATEGORY_IDS,
        isLoading: query.isLoading,
        isSaving: save.isPending,
        save: save.mutateAsync,
    };
}
