import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import {categoryKeys} from '@/lib/queryKeys';
import type {CategoryCreate, CategoryUpdate} from '@/types/api';
import {toast} from 'sonner';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import {useLanguage} from '@/contexts/LanguageContext';

export function useCategories(params?: {
    limit?: number;
    offset?: number;
    general?: string;
    detail?: string;
    active?: boolean;
    search?: string;
}) {
    return useQuery({
        queryKey: categoryKeys.list(params),
        queryFn: () => apiClient.getCategories(params),
        staleTime: 2 * 60_000, // categories rarely change - 2min stale
        placeholderData: (prev) => prev,
    });
}

export function useCreateCategory() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (category: CategoryCreate) => apiClient.createCategory(category),
        onSuccess: (data) => {
            queryClient.invalidateQueries({queryKey: categoryKeys.all});
            if (data.wasCreated) {
                toast.success(t('categories.created'));
            } else {
                toast.info(t('categories.exists'));
            }
        },
        onError: (error: Error) => {
            toast.error(t('categories.createFailedTitle'), { description: apiErrorToMessage(error, t) });
        },
    });
}

export function useUpdateCategory() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({id, data}: { id: number; data: CategoryUpdate }) =>
            apiClient.updateCategory(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: categoryKeys.all});
        },
        onError: (error: Error) => {
            toast.error(t('categories.updateFailedTitle'), { description: apiErrorToMessage(error, t) });
        },
    });
}

export function useDeleteCategory() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteCategory(id),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: categoryKeys.all});
        },
        onError: (error: Error) => {
            toast.error(t('categories.deleteFailedTitle'), { description: apiErrorToMessage(error, t) });
        },
    });
}
