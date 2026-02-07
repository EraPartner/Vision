import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import type {RecipientUpdate} from '@/types/api';
import {toast} from 'sonner';

export function useRecipients(params?: {
    limit?: number;
    offset?: number;
    name?: string;
    account_number?: string;
    default_category_id?: number;
    active?: boolean;
}) {
    return useQuery({
        queryKey: ['recipients', params],
        queryFn: () => apiClient.getRecipients(params),
    });
}

export function useUpdateRecipient() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({id, data}: { id: number; data: RecipientUpdate }) =>
            apiClient.updateRecipient(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['recipients']});
        },
        onError: (error: Error) => {
            toast.error(`Failed to update recipient: ${error.message}`);
        },
    });
}

export function useDeleteRecipient() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteRecipient(id),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['recipients']});
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete recipient: ${error.message}`);
        },
    });
}
