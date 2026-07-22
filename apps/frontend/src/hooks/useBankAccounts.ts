import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { bankAccountKeys } from '@/lib/queryKeys';

export function useBankAccounts() {
    return useQuery({
        queryKey: bankAccountKeys.all,
        queryFn: () => apiClient.getDistinctBankAccounts(),
        staleTime: 2 * 60_000,
        placeholderData: (prev) => prev,
    });
}
