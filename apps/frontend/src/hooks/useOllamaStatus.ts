import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

const STATUS_KEY = ['ai', 'ollama', 'status'] as const;
const MODELS_KEY = ['ai', 'ollama', 'models'] as const;

export function useOllamaStatus() {
    return useQuery({
        queryKey: STATUS_KEY,
        queryFn: () => apiClient.getOllamaStatus(),
        staleTime: 15_000,
        refetchInterval: 30_000,
        refetchOnWindowFocus: true,
        retry: 0,
        placeholderData: (prev) => prev,
    });
}

export function useOllamaModels(enabled = true) {
    return useQuery({
        queryKey: MODELS_KEY,
        queryFn: () => apiClient.getOllamaModels(),
        enabled,
        staleTime: 60_000,
        retry: 0,
        placeholderData: (prev) => prev,
    });
}
