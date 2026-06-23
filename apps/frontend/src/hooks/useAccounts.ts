import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { AccountCreate, AccountUpdate } from '@/types/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

export function useAccounts(params?: { active?: 'true' | 'false' | 'all' }) {
    return useQuery({
        queryKey: ['accounts', params],
        queryFn: () => apiClient.getAccounts(params),
        staleTime: 2 * 60_000, // accounts rarely change - 2min stale
        placeholderData: (prev) => prev,
    });
}

export function useCreateAccount() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (account: AccountCreate) => apiClient.createAccount(account),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['accounts'] });
            toast.success(t('accounts.created'));
        },
        onError: (error: Error) => {
            toast.error(t('accounts.createFailedTitle'), { description: error.message });
        },
    });
}

export function useUpdateAccount() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({ id, data }: { id: number; data: AccountUpdate }) =>
            apiClient.updateAccount(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['accounts'] });
        },
        onError: (error: Error) => {
            toast.error(t('accounts.updateFailedTitle'), { description: error.message });
        },
    });
}

export function useMergeAccounts() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({ targetId, sourceIds }: { targetId: number; sourceIds: number[] }) =>
            apiClient.mergeAccounts(targetId, sourceIds),
        onSuccess: () => {
            // A merge repoints transactions / planned / holdings / funding across accounts, so it
            // touches nearly every server-derived view — invalidate everything for consistency.
            queryClient.invalidateQueries();
            toast.success(t('accounts.merged'));
        },
        onError: (error: Error) => {
            toast.error(t('accounts.mergeFailedTitle'), { description: error.message });
        },
    });
}

export function useDeleteAccount() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteAccount(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['accounts'] });
            toast.success(t('accounts.deleted'));
        },
        onError: (error: Error) => {
            // 409 = account still has transactions → archive instead
            toast.error(t('accounts.deleteFailedTitle'), { description: error.message });
        },
    });
}
