import { z } from "zod";
import { CategoryIdSchema } from "@vision/types/brands";
import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import { getResearchProviderKeys } from "@/lib/api/research";
import { recipientKeys, researchKeys, settingKeys } from "@/lib/queryKeys";
import type { CategoryId } from "@vision/types/brands";

export function useResearchProviderKeys() {
    return useQuery({
        queryKey: researchKeys.providerKeys,
        queryFn: getResearchProviderKeys,
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
    });
}

export function useStatisticsRecipientOptions() {
    return useQuery({
        queryKey: recipientKeys.allList,
        queryFn: () => apiClient.getRecipients({ limit: 1000 }),
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
    });
}

export function useSetting(key: string) {
    return useQuery({
        queryKey: settingKeys.byKey(key),
        queryFn: () => apiClient.getSetting(key),
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
    });
}

export interface BrokerageCashCategoryIds {
    dividend: CategoryId | null;
    interest: CategoryId | null;
    fee: CategoryId | null;
    tax: CategoryId | null;
}

export const EMPTY_BROKERAGE_CASH_CATEGORY_IDS: BrokerageCashCategoryIds = {
    dividend: null,
    interest: null,
    fee: null,
    tax: null,
};

const BROKERAGE_CASH_CATEGORY_KEY = "brokerage_cash_category_ids";

const categorySlot = CategoryIdSchema.nullable().catch(null);
const brokerageCashCategoryIdsSchema = z.object({
    dividend: categorySlot,
    interest: categorySlot,
    fee: categorySlot,
    tax: categorySlot,
});

export function useBrokerageCashCategoryIds() {
    const queryClient = useQueryClient();
    const queryKey = settingKeys.byKey(BROKERAGE_CASH_CATEGORY_KEY);
    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<BrokerageCashCategoryIds> => {
            const result = await apiClient.getSetting(
                BROKERAGE_CASH_CATEGORY_KEY,
            );
            // The stored value is untrusted: a malformed slot reads as "unset".
            const parsed = brokerageCashCategoryIdsSchema.safeParse(
                result.value,
            );
            return parsed.success
                ? parsed.data
                : EMPTY_BROKERAGE_CASH_CATEGORY_IDS;
        },
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
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
