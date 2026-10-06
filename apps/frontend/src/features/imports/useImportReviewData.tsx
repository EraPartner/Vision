import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { apiClient } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import {
    importKeys,
    invalidateAccountDerived,
    invalidateTransactionData,
    plannedKeys,
} from "@/lib/queryKeys";

export function useImportPreview(batchId: number) {
    return useQuery({
        queryKey: importKeys.preview(batchId),
        queryFn: () => apiClient.getImportPreview(batchId),
        enabled: Number.isFinite(batchId),
    });
}

/**
 * The date span of the staged rows, carried into the Import page's receipt so
 * it can link to the imported transactions (there is no per-batch filter on
 * the Transactions page; the span is the closest filter it reads).
 */
export interface ImportDateRange {
    dateFrom?: string;
    dateTo?: string;
}

export function useImportReviewMutations(
    batchId: number,
    newAccountCount: number,
) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const { t } = useLanguage();

    const overrideRecipient = useMutation({
        mutationFn: ({
            rowId,
            recipientId,
        }: {
            rowId: number;
            recipientId: number | null;
        }) => apiClient.overrideImportRow(batchId, rowId, recipientId),
        meta: { suppressErrorToast: true },
    });

    const overrideCategory = useMutation({
        mutationFn: ({
            rowId,
            categoryId,
        }: {
            rowId: number;
            categoryId: number | null;
        }) => apiClient.overrideImportRowCategory(batchId, rowId, categoryId),
        meta: { suppressErrorToast: true },
    });

    const persistDefault = useMutation({
        mutationFn: ({
            recipientId,
            categoryId,
        }: {
            recipientId: number;
            categoryId: number | null;
        }) =>
            apiClient.updateRecipient(recipientId, {
                default_category_id: categoryId,
            }),
        meta: { suppressErrorToast: true },
    });

    const commitMutation = useMutation({
        mutationFn: (_range: ImportDateRange) =>
            apiClient.commitImportBatch(batchId),
        onSuccess: (data, range) => {
            toast.success(
                t("importReview.toast.success", {
                    imported: data.imported,
                    duplicates: data.duplicates,
                    errors: data.errors,
                }),
                { icon: <CheckCircle2 className="h-4 w-4" /> },
            );
            if (data.auto_linked_count && data.auto_linked_count > 0) {
                toast.success(
                    t("importReview.toast.autoLinked", {
                        n: data.auto_linked_count,
                    }),
                );
                queryClient.invalidateQueries({
                    queryKey: plannedKeys.matchSuggestions,
                });
                queryClient.invalidateQueries({
                    queryKey: plannedKeys.upcomingAll,
                });
            }
            if (newAccountCount > 0) {
                invalidateAccountDerived(queryClient);
                toast.success(
                    t("importReview.toast.newAccounts", { n: newAccountCount }),
                    {
                        action: {
                            label: t("importReview.toast.reviewAccounts"),
                            onClick: () => navigate("/accounts"),
                        },
                        duration: 10000,
                    },
                );
            }
            queryClient.invalidateQueries({ queryKey: importKeys.batchesAll });
            invalidateTransactionData(queryClient);
            navigate("/import", {
                replace: true,
                state: {
                    importCommitReceipt: {
                        imported: data.imported,
                        duplicates: data.duplicates,
                        errors: data.errors,
                        dateFrom: range.dateFrom,
                        dateTo: range.dateTo,
                    },
                },
            });
        },
        onError: (err: Error) => {
            toast.error(t("importReview.toast.commitFailed"), {
                description: apiErrorToMessage(err, t),
            });
        },
    });

    // Discarding cancels the parked batch: DELETE /api/import/batches/:id rolls
    // back any batch that is not in progress, and an awaiting_review batch has
    // committed nothing, so this only clears the staging rows.
    const discardMutation = useMutation({
        mutationFn: () => apiClient.rollbackImportBatch(batchId),
        onSuccess: () => {
            toast.success(t("importReview.toast.discarded"));
            queryClient.invalidateQueries({ queryKey: importKeys.batchesAll });
            navigate("/import", { replace: true });
        },
        onError: (err: Error) => {
            toast.error(t("importReview.toast.discardFailed"), {
                description: apiErrorToMessage(err, t),
            });
        },
        meta: { suppressErrorToast: true },
    });

    return {
        overrideRows: async (rowIds: number[], recipientId: number | null) => {
            await Promise.all(
                rowIds.map((rowId) =>
                    overrideRecipient.mutateAsync({ rowId, recipientId }),
                ),
            );
            await queryClient.invalidateQueries({
                queryKey: importKeys.preview(batchId),
            });
        },
        overrideCategories: (rowIds: number[], categoryId: number | null) =>
            Promise.all(
                rowIds.map((rowId) =>
                    overrideCategory.mutateAsync({ rowId, categoryId }),
                ),
            ),
        persistDefaultCategory: (
            recipientId: number,
            categoryId: number | null,
        ) => persistDefault.mutateAsync({ recipientId, categoryId }),
        commit: (range: ImportDateRange = {}) => commitMutation.mutate(range),
        isCommitting: commitMutation.isPending,
        discard: () => discardMutation.mutate(),
        isDiscarding: discardMutation.isPending,
    };
}
