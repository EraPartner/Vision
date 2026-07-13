import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { AccountCreate, AccountUpdate } from '@/types/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { invalidateTransactionLists } from '@/hooks/useTransactions';
import {
    INVESTMENTS_QUERY_KEY,
    PORTFOLIO_TRANSACTIONS_QUERY_KEY_PREFIX,
    PORTFOLIO_SUMMARY_QUERY_KEY_PREFIX,
    PORTFOLIO_PERFORMANCE_QUERY_KEY_PREFIX,
} from '@/hooks/portfolio/useInvestments';

// Account CRUD changes balances/in_net_worth flags, so the net-worth views must
// refetch too — NetWorthPage keeps both queries at a 2-minute staleTime, so a
// missed invalidation shows a stale total for up to 2 minutes.
function invalidateAccountDerived(queryClient: QueryClient) {
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    queryClient.invalidateQueries({ queryKey: ['net-worth'] });
    queryClient.invalidateQueries({ queryKey: ['net-worth-by-account'] });
}

// A merge or close repoints transactions / planned / holdings / funding from one
// account onto another, so it touches more than the account-derived views: the
// transaction lists, planned-payment surfaces and the portfolio trees all restate.
// This is the targeted replacement for a blanket `queryClient.invalidateQueries()`
// — it refetches exactly those trees and leaves unrelated caches (categories,
// recipients, market data, exchange rates, …) untouched so a merge/close no longer
// triggers a whole-app refetch storm.
export function invalidateAccountRepoint(queryClient: QueryClient) {
    invalidateAccountDerived(queryClient);
    invalidateTransactionLists(queryClient);
    // Planned payments can reference the merged/closed account.
    queryClient.invalidateQueries({ queryKey: ['upcomingPlannedPayments'] });
    queryClient.invalidateQueries({ queryKey: ['plannedTransactions'] });
    queryClient.invalidateQueries({ queryKey: ['plannedMatchSuggestions'] });
    // Holdings move across accounts (in-specie), so the portfolio trees restate.
    queryClient.invalidateQueries({ queryKey: INVESTMENTS_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: [PORTFOLIO_TRANSACTIONS_QUERY_KEY_PREFIX] });
    queryClient.invalidateQueries({ queryKey: [PORTFOLIO_SUMMARY_QUERY_KEY_PREFIX] });
    queryClient.invalidateQueries({ queryKey: [PORTFOLIO_PERFORMANCE_QUERY_KEY_PREFIX] });
}

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
        onSuccess: () => {
            // A merge repoints transactions / planned / holdings / funding across accounts, so it
            // touches every account-derived view plus the transaction, planned and portfolio trees.
            // Invalidate exactly those (not the whole cache) — see invalidateAccountRepoint.
            invalidateAccountRepoint(queryClient);
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
