import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { invalidateTransactionData, recipientKeys } from "@/lib/queryKeys";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { Transaction } from "@/types/api";

export interface CreateTransferInput {
    transaction_date: string;
    from_account_id: number;
    from_account_name: string;
    to_account_id: number;
    to_account_name: string;
    /** Magnitude; the hook signs each leg. */
    amount: number;
    currency: string;
    memo?: string;
    comment?: string;
}

export interface CreateTransferResult {
    outflow: Transaction;
    inflow: Transaction;
}

/**
 * Records a move between two own accounts as the two rows the ledger needs
 * (ADR-083 has no single-call endpoint): the outflow leaves the sending
 * account, the inflow arrives on the receiving one, and the pair is then
 * linked with the manual transfer mark so cash-flow aggregates skip both.
 *
 * Each leg's recipient is the counterpart account, created on first use
 * (POST /api/recipients returns the existing row when the name is taken).
 * If the mark fails after both rows exist the rows are kept: the transfer
 * reconciliation pass links equal-and-opposite rows on its own, and either
 * leg can be marked by hand from Transactions.
 */
export function useCreateTransfer() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: async (input: CreateTransferInput): Promise<CreateTransferResult> => {
            const magnitude = Math.abs(input.amount);
            const [{ recipient: toRecipient }, { recipient: fromRecipient }] =
                await Promise.all([
                    apiClient.createRecipient({ name: input.to_account_name }),
                    apiClient.createRecipient({ name: input.from_account_name }),
                ]);
            const shared = {
                transaction_date: input.transaction_date,
                currency: input.currency,
                memo: input.memo,
                comment: input.comment,
            };
            const outflow = await apiClient.createTransaction({
                ...shared,
                account_id: input.from_account_id,
                recipient_id: toRecipient.id,
                amount: -magnitude,
            });
            const inflow = await apiClient.createTransaction({
                ...shared,
                account_id: input.to_account_id,
                recipient_id: fromRecipient.id,
                amount: magnitude,
            });
            await apiClient.markTransfer(outflow.id, inflow.id);
            return { outflow, inflow };
        },
        onError: (error: Error) => {
            toast.error(t("transactions.createFailedTitle"), {
                description: apiErrorToMessage(error, t),
            });
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: recipientKeys.all });
            invalidateTransactionData(queryClient);
        },
    });
}
