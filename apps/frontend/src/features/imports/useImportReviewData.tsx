import { useRef, useState } from "react";
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
import type { CategoryId, RecipientId } from "@vision/types/brands";

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
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
}

export function useImportReviewMutations(
    batchId: number,
    newAccountCount: number,
) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const { t } = useLanguage();
    const committing = useRef(false);
    const queue = useRef<Promise<void>>(Promise.resolve());
    const failures = useRef(new Set<string>());
    const [pendingEdits, setPendingEdits] = useState(0);
    const [hasEditErrors, setHasEditErrors] = useState(false);
    function edit(key: string, work: () => Promise<unknown>) {
        if (committing.current)
            return Promise.reject(new Error(t("importReview.savingEdits")));
        setPendingEdits((count) => count + 1);
        const operation = queue.current.then(async () => {
            try {
                await work();
                failures.current.delete(key);
            } catch (error) {
                failures.current.add(key);
                throw error;
            } finally {
                setHasEditErrors(failures.current.size > 0);
                setPendingEdits((count) => count - 1);
            }
        });
        queue.current = operation.catch(() => undefined);
        return operation;
    }
    async function updateRows(work: Promise<unknown>[]) {
        const settled = await Promise.allSettled(work);
        await queryClient.invalidateQueries({
            queryKey: importKeys.preview(batchId),
        });
        const failure = settled.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
    }

    const overrideRecipient = useMutation({
        mutationFn: ({
            rowId,
            recipientId,
        }: {
            rowId: string;
            recipientId: RecipientId | null;
        }) => apiClient.overrideImportRow(batchId, rowId, recipientId),
        meta: { suppressErrorToast: true },
    });

    const overrideCategory = useMutation({
        mutationFn: ({
            rowId,
            categoryId,
        }: {
            rowId: string;
            categoryId: CategoryId | null;
        }) => apiClient.overrideImportRowCategory(batchId, rowId, categoryId),
        meta: { suppressErrorToast: true },
    });

    const persistDefault = useMutation({
        mutationFn: ({
            recipientId,
            categoryId,
        }: {
            recipientId: RecipientId;
            categoryId: CategoryId | null;
        }) =>
            apiClient.updateRecipient(recipientId, {
                default_category_id: categoryId,
            }),
        meta: { suppressErrorToast: true },
    });

    const commitMutation = useMutation({
        onSettled: () => {
            committing.current = false;
        },
        mutationFn: async (_range: ImportDateRange) => {
            await queue.current;
            if (failures.current.size > 0)
                throw new Error(t("importReview.editsFailed"));
            return apiClient.commitImportBatch(batchId);
        },
        onSuccess: (data, range) => {
            toast.success(
                t("importReview.toast.success", {
                    imported: data.imported,
                    duplicates: data.duplicates,
                    errors: data.errors,
                }),
                { icon: <CheckCircle2 className="h-4 w-4" /> },
            );
            if (
                data.auto_linked_count !== undefined &&
                data.auto_linked_count > 0
            ) {
                toast.success(
                    t("importReview.toast.autoLinked", {
                        n: data.auto_linked_count,
                    }),
                );
                void queryClient.invalidateQueries({
                    queryKey: plannedKeys.matchSuggestions,
                });
                void queryClient.invalidateQueries({
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
                            onClick: () => void navigate("/accounts"),
                        },
                        duration: 10000,
                    },
                );
            }
            void queryClient.invalidateQueries({
                queryKey: importKeys.batchesAll,
            });
            invalidateTransactionData(queryClient);
            void navigate("/import", {
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
            void queryClient.invalidateQueries({
                queryKey: importKeys.batchesAll,
            });
            void navigate("/import", { replace: true });
        },
        onError: (err: Error) => {
            toast.error(t("importReview.toast.discardFailed"), {
                description: apiErrorToMessage(err, t),
            });
        },
        meta: { suppressErrorToast: true },
    });

    return {
        overrideRows: (rowIds: string[], recipientId: RecipientId | null) =>
            edit(`recipient:${rowIds.join(",")}`, () =>
                updateRows(
                    rowIds.map((rowId) =>
                        overrideRecipient.mutateAsync({ rowId, recipientId }),
                    ),
                ),
            ),
        overrideCategories: (rowIds: string[], categoryId: CategoryId | null) =>
            edit(`category:${rowIds.join(",")}`, () =>
                updateRows(
                    rowIds.map((rowId) =>
                        overrideCategory.mutateAsync({ rowId, categoryId }),
                    ),
                ),
            ),
        persistDefaultCategory: (
            recipientId: RecipientId,
            categoryId: CategoryId | null,
        ) =>
            edit(`default:${recipientId}`, () =>
                persistDefault.mutateAsync({ recipientId, categoryId }),
            ),
        isSavingEdits: pendingEdits > 0,
        hasEditErrors,
        reviewSavedEdits: async () => {
            await queue.current;
            await queryClient.query({
                queryKey: importKeys.preview(batchId),
                queryFn: () => apiClient.getImportPreview(batchId),
                staleTime: 0,
            });
            failures.current.clear();
            setHasEditErrors(false);
        },
        commit: (range: ImportDateRange = {}) => {
            if (committing.current) return;
            committing.current = true;
            commitMutation.mutate(range);
        },
        isCommitting: commitMutation.isPending,
        discard: () => discardMutation.mutate(),
        isDiscarding: discardMutation.isPending,
    };
}
