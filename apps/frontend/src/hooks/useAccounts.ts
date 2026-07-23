import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { AccountCreate, AccountUpdate } from '@/types/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { accountKeys, invalidateAccountDerived, invalidateAccountRepoint } from '@/lib/queryKeys';

export function useAccounts(params?: { active?: 'true' | 'false' | 'all' }) {
    return useQuery({
        queryKey: accountKeys.list(params),
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
            invalidateAccountDerived(queryClient);
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
            invalidateAccountDerived(queryClient);
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
        onSuccess: (result) => {
            // A merge repoints transactions / planned / holdings / funding across accounts, so it
            // touches every account-derived view plus the transaction, planned and portfolio trees.
            // Invalidate exactly those (not the whole cache) — see invalidateAccountRepoint.
            invalidateAccountRepoint(queryClient);
            // Receipt with the REAL repointed counts from the merge result (§3 F9).
            toast.success(t('accounts.merged'), {
                description: t('accounts.mergedReceipt', {
                    transactions: result.reassigned.transactions,
                    planned: result.reassigned.planned,
                }),
            });
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
            invalidateAccountDerived(queryClient);
            toast.success(t('accounts.deleted'));
        },
        onError: (error: Error) => {
            // 409 = account still referenced → the caller routes to the close
            // flow (lifecycle D5); no dead-end error toast for that case.
            if ((error as { status?: number }).status === 409) return;
            toast.error(t('accounts.deleteFailedTitle'), { description: error.message });
        },
    });
}
