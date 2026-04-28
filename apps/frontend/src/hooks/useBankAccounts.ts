import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

export function useBankAccounts() {
    return useQuery({
        queryKey: ['bankAccounts'],
        queryFn: () => apiClient.getDistinctBankAccounts(),
        staleTime: 2 * 60_000,
        placeholderData: (prev) => prev,
    });
}
