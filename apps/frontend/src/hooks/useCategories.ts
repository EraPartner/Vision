import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import type {CategoryCreate, CategoryUpdate} from '@/types/api';
import {toast} from 'sonner';

export function useCategories(params?: {
    limit?: number;
    offset?: number;
    general?: string;
    detail?: string;
    active?: boolean;
    search?: string;
}) {
    return useQuery({
        queryKey: ['categories', params],
        queryFn: () => apiClient.getCategories(params),
        staleTime: 2 * 60_000, // categories rarely change - 2min stale
        placeholderData: (prev) => prev,
    });
}

export function useCreateCategory() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (category: CategoryCreate) => apiClient.createCategory(category),
        onSuccess: (data) => {
            queryClient.invalidateQueries({queryKey: ['categories']});
            if (data.wasCreated) {
                toast.success('Category created successfully');
            } else {
                toast.info('Category already exists');
            }
        },
        onError: (error: Error) => {
            toast.error(`Failed to create category: ${error.message}`);
        },
    });
}

export function useUpdateCategory() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({id, data}: { id: number; data: CategoryUpdate }) =>
            apiClient.updateCategory(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['categories']});
        },
        onError: (error: Error) => {
            toast.error(`Failed to update category: ${error.message}`);
        },
    });
}

export function useDeleteCategory() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteCategory(id),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['categories']});
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete category: ${error.message}`);
        },
    });
}
