import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { invalidateTransactionData } from "@/lib/queryKeys";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

export interface ExistingTransferLeg {
    id: number;
    accountId?: number;
    bank: string;
    date: string;
    amount: number;
    currency: string;
    is_active: boolean;
    transferPeerId?: number | null;
}

export function eligibleExistingTransferPair(
    legs: readonly ExistingTransferLeg[],
): legs is readonly [ExistingTransferLeg, ExistingTransferLeg] {
    if (legs.length !== 2) return false;
    const [first, second] = legs;
    return (
        first.id !== second.id &&
        legs.every(
            (leg) =>
                Number.isSafeInteger(leg.id) &&
                leg.id > 0 &&
                Number.isSafeInteger(leg.accountId) &&
                Number(leg.accountId) > 0 &&
                leg.is_active &&
                leg.transferPeerId == null &&
                Number.isFinite(leg.amount) &&
                leg.amount !== 0 &&
                Boolean(leg.date) &&
                /^[A-Z]{3}$/.test(leg.currency),
        ) &&
        first.accountId !== second.accountId &&
        Math.sign(first.amount) !== Math.sign(second.amount)
    );
}

/** Link proved existing movements without creating a new cash leg. */
export function useMarkTransfer() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: async (
            legs: readonly [ExistingTransferLeg, ExistingTransferLeg],
        ) => {
            if (!eligibleExistingTransferPair(legs))
                throw new Error(t("txPage.bulk.transferSelectionChanged"));
            await apiClient.markTransfer(legs[0].id, legs[1].id);
        },
        onSuccess: () => {
            invalidateTransactionData(queryClient);
            toast.success(t("txPage.bulk.markTransferSuccess"));
        },
        onError: (error: Error) => {
            toast.error(t("txPage.bulk.failed"), {
                description: apiErrorToMessage(error, t),
            });
        },
    });
}
