import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { tagKeys } from '@/lib/queryKeys';
import type { TagCreate } from '@/types/api';
import { toast } from 'sonner';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import { useLanguage } from '@/contexts/LanguageContext';

export function useTags(params?: { is_active?: boolean }) {
    return useQuery({
        queryKey: tagKeys.list(params ?? {}),
        queryFn: () => apiClient.getTags(params),
        staleTime: 60_000,
    });
}

export function useCreateTag() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (tag: TagCreate) => apiClient.createTag(tag),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: tagKeys.all });
        },
        onError: (error: Error) => {
            toast.error(t('tags.createFailed'), { description: apiErrorToMessage(error, t) });
        },
    });
}
