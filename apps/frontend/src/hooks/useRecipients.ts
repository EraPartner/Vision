import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import type {RecipientCreate, RecipientUpdate} from '@/types/api';
import {toast} from 'sonner';
import {useLanguage} from '@/contexts/LanguageContext';

export function useRecipients(params?: {
    limit?: number;
    offset?: number;
    name?: string;
    default_category_id?: number;
    active?: boolean;
    search?: string;
}) {
    return useQuery({
        queryKey: ['recipients', params],
        queryFn: () => apiClient.getRecipients(params),
        staleTime: 2 * 60_000, // recipients rarely change - 2min stale
        placeholderData: (prev) => prev,
    });
}

export function useCreateRecipient() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (recipient: RecipientCreate) => apiClient.createRecipient(recipient),
        onSuccess: (data) => {
            queryClient.invalidateQueries({queryKey: ['recipients']});
            if (data.wasCreated) {
                toast.success(t('recipients.created'));
            } else {
                toast.info(t('recipients.exists'));
            }
        },
        onError: (error: Error) => {
            toast.error(t('recipients.createFailedTitle'), { description: error.message });
        },
    });
}

export function useUpdateRecipient() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({id, data}: { id: number; data: RecipientUpdate }) =>
            apiClient.updateRecipient(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['recipients']});
        },
        onError: (error: Error) => {
            toast.error(t('recipients.updateFailedTitle'), { description: error.message });
        },
    });
}

export function useDeleteRecipient() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteRecipient(id),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['recipients']});
            toast.success(t('recipients.deleted'));
        },
        onError: (error: Error) => {
            toast.error(t('recipients.deleteFailedTitle'), { description: error.message });
        },
    });
}

export function useMergeRecipients() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({primaryId, aliasIds}: { primaryId: number; aliasIds: number[] }) =>
            apiClient.mergeRecipients(primaryId, aliasIds),
        onSuccess: (data) => {
            queryClient.invalidateQueries({queryKey: ['recipients']});
            queryClient.invalidateQueries({queryKey: ['transactions']});
            toast.success(t('recipients.merged', { n: String(data.merged_ids.length), name: data.primary.name }));
            if (data.patternSuggestion) {
                const { patternSuggestion } = data;
                toast.info(t('recipients.createRuleSuggestion', { pattern: patternSuggestion.pattern, n: String(patternSuggestion.matchCount) }), {
                    action: {
                        label: t('recipients.createRule'),
                        onClick: () => {
                            apiClient.createRecipientPattern(data.primary.id, {
                                pattern: patternSuggestion.pattern,
                                pattern_kind: patternSuggestion.kind,
                            }).then(() => toast.success(t('recipientPatterns.toast.created')))
                              .catch(() => toast.error(t('recipientPatterns.toast.error')));
                        },
                    },
                    duration: 10_000,
                });
            }
        },
        onError: (error: Error) => {
            toast.error(t('recipients.mergeFailedTitle'), { description: error.message });
        },
    });
}

export function useUnmergeRecipient() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: number) => apiClient.unmergeRecipient(id),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['recipients']});
            queryClient.invalidateQueries({queryKey: ['transactions']});
            toast.success(t('recipients.unmerged'));
        },
        onError: (error: Error) => {
            toast.error(t('recipients.unmergeFailedTitle'), { description: error.message });
        },
    });
}
