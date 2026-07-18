import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { TagCreate } from '@/types/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

export function useTags(params?: { is_active?: boolean }) {
    return useQuery({
        queryKey: ['tags', params ?? {}],
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
            queryClient.invalidateQueries({ queryKey: ['tags'] });
        },
        onError: (error: Error) => {
            toast.error(t('tags.createFailed'), { description: error.message });
        },
    });
}
