import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import type {RecipientCreate, RecipientUpdate} from '@/types/api';
import {toast} from 'sonner';

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

    return useMutation({
        mutationFn: (recipient: RecipientCreate) => apiClient.createRecipient(recipient),
        onSuccess: (data) => {
            queryClient.invalidateQueries({queryKey: ['recipients']});
            if (data.wasCreated) {
                toast.success('Recipient created successfully');
            } else {
                toast.info('Recipient already exists');
            }
        },
        onError: (error: Error) => {
            toast.error(`Failed to create recipient: ${error.message}`);
        },
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
            toast.success('Recipient deleted successfully');
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete recipient: ${error.message}`);
        },
    });
}
