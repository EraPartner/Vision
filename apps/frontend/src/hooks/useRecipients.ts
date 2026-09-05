import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import {
    aggregationKeys,
    recipientKeys,
    transactionKeys,
} from "@/lib/queryKeys";
import type { Recipient, RecipientCreate, RecipientUpdate } from "@/types/api";
import { toast } from "sonner";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useBackgroundQueryCue } from "@/components/shared/BackgroundQueryIndicator";

export function useRecipients(params?: {
    limit?: number;
    offset?: number;
    name?: string;
    default_category_id?: number;
    active?: boolean;
    search?: string;
}) {
    const query = useQuery({
        queryKey: recipientKeys.list(params),
        queryFn: () => apiClient.getRecipients(params),
        staleTime: 2 * 60_000, // recipients rarely change - 2min stale
        placeholderData: (prev) => prev,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}

export function useRecipient(id?: number | null) {
    return useQuery({
        queryKey: recipientKeys.detail(id),
        queryFn: () => {
            if (id == null) throw new Error("Recipient id is required");
            return apiClient.getRecipient(id);
        },
        enabled: id != null,
        staleTime: 2 * 60_000,
    });
}

export function useRecipientPatterns(recipientId: number, enabled: boolean) {
    return useQuery({
        queryKey: ["recipient-patterns", recipientId],
        enabled,
        queryFn: () => apiClient.listRecipientPatterns(recipientId),
        staleTime: 30_000,
    });
}

export function useAllRecipientsForMerge(enabled: boolean) {
    return useQuery({
        queryKey: recipientKeys.mergeAll,
        enabled,
        staleTime: 2 * 60_000,
        queryFn: async () => {
            const pageSize = 1000;
            let offset = 0;
            let total: number;
            const recipients: Recipient[] = [];
            do {
                const response = await apiClient.getRecipients({
                    limit: pageSize,
                    offset,
                    active: false,
                    sort_by: "name",
                    sort_dir: "asc",
                });
                recipients.push(...response.items);
                total = response.total ?? recipients.length;
                offset += response.items.length;
                if (response.items.length === 0) break;
            } while (offset < total);
            return recipients;
        },
    });
}

export function useVirtualRecipients(params: {
    active: boolean;
    search?: string;
    uncategorized: boolean;
    sortKey: string | null;
    sortDir: "asc" | "desc" | null;
    pageSize: number;
}) {
    const query = useQuery({
        queryKey: recipientKeys.virtualList(params),
        queryFn: () =>
            apiClient.getRecipients({
                limit: params.pageSize,
                offset: 0,
                active: params.active,
                search: params.search,
                uncategorized: params.uncategorized,
                sort_by: params.sortKey || undefined,
                sort_dir: params.sortDir ?? undefined,
            }),
        placeholderData: (previous) => previous,
        staleTime: 30_000,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}

export function useCreateRecipient() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (recipient: RecipientCreate) =>
            apiClient.createRecipient(recipient),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: recipientKeys.all });
            if (data.wasCreated) {
                toast.success(t("recipients.created"));
            } else {
                toast.info(t("recipients.exists"));
            }
        },
        onError: (error: Error) => {
            toast.error(t("recipients.createFailedTitle"), {
                description: apiErrorToMessage(error, t),
            });
        },
    });
}

export function useUpdateRecipient() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({ id, data }: { id: number; data: RecipientUpdate }) =>
            apiClient.updateRecipient(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: recipientKeys.all });
            toast.success(t("recipients.updated"));
        },
        onError: (error: Error) => {
            toast.error(t("recipients.updateFailedTitle"), {
                description: apiErrorToMessage(error, t),
            });
        },
    });
}

export function useDeleteRecipient() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteRecipient(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: recipientKeys.all });
            toast.success(t("recipients.deleted"));
        },
        onError: (error: Error) => {
            toast.error(t("recipients.deleteFailedTitle"), {
                description: apiErrorToMessage(error, t),
            });
        },
    });
}

export function useMergeRecipients() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({
            primaryId,
            aliasIds,
        }: {
            primaryId: number;
            aliasIds: number[];
        }) => apiClient.mergeRecipients(primaryId, aliasIds),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: recipientKeys.all });
            queryClient.invalidateQueries({ queryKey: transactionKeys.all });
            // Statistics' recipient breakdowns live under ['aggregations', …];
            // without this a merged/unmerged identity stays split in Top
            // Recipients until staleTime expires.
            queryClient.invalidateQueries({ queryKey: aggregationKeys.all });
            toast.success(
                t("recipients.merged", {
                    n: String(data.merged_ids.length),
                    name: data.primary.name,
                }),
            );
            if (data.patternSuggestion) {
                const { patternSuggestion } = data;
                toast.info(
                    t("recipients.createRuleSuggestion", {
                        pattern: patternSuggestion.pattern,
                        n: String(patternSuggestion.matchCount),
                    }),
                    {
                        action: {
                            label: t("recipients.createRule"),
                            onClick: () => {
                                apiClient
                                    .createRecipientPattern(data.primary.id, {
                                        pattern: patternSuggestion.pattern,
                                        pattern_kind: patternSuggestion.kind,
                                    })
                                    .then(() =>
                                        toast.success(
                                            t(
                                                "recipientPatterns.toast.created",
                                            ),
                                        ),
                                    )
                                    .catch(() =>
                                        toast.error(
                                            t("recipientPatterns.toast.error"),
                                        ),
                                    );
                            },
                        },
                        duration: 10_000,
                    },
                );
            }
        },
        onError: (error: Error) => {
            toast.error(t("recipients.mergeFailedTitle"), {
                description: apiErrorToMessage(error, t),
            });
        },
    });
}

export function useUnmergeRecipient() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: number) => apiClient.unmergeRecipient(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: recipientKeys.all });
            queryClient.invalidateQueries({ queryKey: transactionKeys.all });
            // See useMergeRecipients: keep Statistics' ['aggregations'] breakdowns
            // in sync with the recipient-identity change.
            queryClient.invalidateQueries({ queryKey: aggregationKeys.all });
            toast.success(t("recipients.unmerged"));
        },
        onError: (error: Error) => {
            toast.error(t("recipients.unmergeFailedTitle"), {
                description: apiErrorToMessage(error, t),
            });
        },
    });
}
