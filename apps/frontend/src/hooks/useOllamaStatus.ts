import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { aiKeys } from '@/lib/queryKeys';

export function useOllamaStatus() {
    return useQuery({
        queryKey: aiKeys.ollamaStatus,
        queryFn: () => apiClient.getOllamaStatus(),
        staleTime: 15_000,
        refetchInterval: 30_000,
        refetchOnWindowFocus: false,
        retry: 0,
        placeholderData: (prev) => prev,
    });
}

export function useOllamaModels(enabled = true) {
    return useQuery({
        queryKey: aiKeys.ollamaModels,
        queryFn: () => apiClient.getOllamaModels(),
        enabled,
        staleTime: 60_000,
        retry: 0,
        placeholderData: (prev) => prev,
    });
}
