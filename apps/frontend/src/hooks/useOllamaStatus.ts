import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { aiKeys } from '@/lib/queryKeys';
import type { OllamaStatus } from '@/types/aiChat';
import { useBackgroundQueryCue } from '@/components/shared/BackgroundQueryIndicator';

/** Reachable Ollama: unchanged cadence, so a model/URL change is noticed as fast as before. */
const HEALTHY_POLL_MS = 30_000;
/**
 * Unreachable Ollama (or a failing status request): keep watching, but at a
 * quarter of the rate. The chat and settings surfaces stay mounted for as long
 * as the user reads them, and every poll against a down/absent Ollama costs a
 * backend request plus an upstream connect attempt that is going to time out.
 */
const DOWN_POLL_MS = 120_000;

/**
 * Poll cadence for the next status check, from the query's last outcome.
 *
 *  - `enabled: false` — AI chat is off in the backend's own settings
 *    (env-backed, see routes/ai.js). That flag cannot flip without a backend
 *    restart, so polling it forever is pure waste; stop, and let a remount of
 *    the chat/settings surface or the status banner's Retry (which invalidates
 *    `aiKeys.ollamaAll`) pick the change up.
 *  - unreachable / errored — back off to DOWN_POLL_MS. Recovery is still
 *    noticed automatically, and immediately via Retry.
 *  - healthy — HEALTHY_POLL_MS, exactly the pre-backoff cadence.
 *
 * `data` survives an errored refetch (React Query keeps the last success), so
 * the disabled check runs first: a disabled integration must not fall through
 * to the "keep watching" branch just because one request also failed.
 */
export function nextOllamaPollInterval(state: {
    status: 'pending' | 'error' | 'success';
    data: OllamaStatus | undefined;
}): number | false {
    if (state.data && !state.data.enabled) return false;
    if (state.status === 'error' || (state.data && !state.data.ok)) return DOWN_POLL_MS;
    return HEALTHY_POLL_MS;
}

/** Ollama health for the chat + settings surfaces (adaptive poll, see above). */
export function useOllamaStatus() {
    const query = useQuery({
        queryKey: aiKeys.ollamaStatus,
        queryFn: () => apiClient.getOllamaStatus(),
        staleTime: 15_000,
        refetchInterval: (query) => nextOllamaPollInterval(query.state),
        refetchOnWindowFocus: false,
        retry: 0,
        placeholderData: (prev) => prev,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}

export function useOllamaModels(enabled = true) {
    const query = useQuery({
        queryKey: aiKeys.ollamaModels,
        queryFn: () => apiClient.getOllamaModels(),
        enabled,
        staleTime: 60_000,
        retry: 0,
        placeholderData: (prev) => prev,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}
