import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { bankAccountKeys } from '@/lib/queryKeys';
import { useBackgroundQueryCue } from '@/components/shared/BackgroundQueryIndicator';

export function useBankAccounts() {
    const query = useQuery({
        queryKey: bankAccountKeys.all,
        queryFn: () => apiClient.getDistinctBankAccounts(),
        staleTime: 2 * 60_000,
        placeholderData: (prev) => prev,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}
