import { QUERY_GC_TIME_MS, QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { useCallback, useSyncExternalStore } from "react";
import {
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import { aiKeys } from "@/lib/queryKeys";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    aiChatStreamStore,
    type SendBody,
    type StreamState,
} from "@/lib/aiChatStreamStore";
import type {
    ChatCompleteEvent,
    ConversationDetail,
    CreateConversationBody,
} from "@/types/aiChat";
import { useBackgroundQueryCue } from "@/components/shared/BackgroundQueryIndicator";

export function useConversations() {
    const query = useInfiniteQuery({
        queryKey: aiKeys.conversations,
        queryFn: ({ pageParam }) =>
            apiClient.getConversations({ limit: 50, offset: pageParam }),
        initialPageParam: 0,
        getNextPageParam: (lastPage) => {
            if (lastPage.items.length === 0) return undefined;
            const next = lastPage.offset + lastPage.items.length;
            return next < lastPage.total ? next : undefined;
        },
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
        gcTime: QUERY_GC_TIME_MS.LARGE_LIST,
    });
    useBackgroundQueryCue(query.isFetching && !query.isFetchingNextPage);
    return query;
}

export function useConversation(id: string | null) {
    const query = useQuery({
        queryKey: aiKeys.conversation(id),
        queryFn: () =>
            id ? apiClient.getConversation(id) : Promise.resolve(null),
        enabled: Boolean(id),
        staleTime: 10_000,
        gcTime: QUERY_GC_TIME_MS.LARGE_LIST,
        placeholderData: (prev) => prev,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}

export function useCreateConversation() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (body: CreateConversationBody) =>
            apiClient.createConversation(body),
        onSuccess: (data) => {
            void queryClient.invalidateQueries({
                queryKey: aiKeys.conversations,
            });
            queryClient.setQueryData(
                aiKeys.conversation(data.conversation.id),
                data,
            );
        },
        onError: (error: Error) => {
            toast.error(t("aiChat.createFailed"), {
                description: apiErrorToMessage(error, t),
            });
        },
    });
}

export function useRenameConversation() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({ id, title }: { id: string; title: string }) =>
            apiClient.renameConversation(id, title),
        onSuccess: (updated) => {
            void queryClient.invalidateQueries({
                queryKey: aiKeys.conversations,
            });
            queryClient.setQueryData<ConversationDetail | undefined>(
                aiKeys.conversation(updated.id),
                (prev) =>
                    prev
                        ? {
                              ...prev,
                              conversation: {
                                  ...prev.conversation,
                                  ...updated,
                              },
                          }
                        : prev,
            );
        },
        onError: (error: Error) => {
            toast.error(t("aiChat.renameFailed"), {
                description: apiErrorToMessage(error, t),
            });
        },
    });
}

export function useDeleteConversation() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: string) => apiClient.deleteConversation(id),
        onSuccess: (_void, id) => {
            queryClient.removeQueries({ queryKey: aiKeys.conversation(id) });
            void queryClient.invalidateQueries({
                queryKey: aiKeys.conversations,
                exact: true,
            });
            toast.success(t("aiChat.deleted"));
        },
        onError: (error: Error) => {
            toast.error(t("aiChat.deleteFailed"), {
                description: apiErrorToMessage(error, t),
            });
        },
    });
}

function subscribeToStreams(listener: () => void): () => void {
    return aiChatStreamStore.subscribe(listener);
}

/**
 * Full live stream state for one conversation. Re-renders on every coalesced
 * token frame, so only the transcript should call it — see
 * `useSendChatMessage` for the narrow page-level subscription.
 */
export function useChatStream(conversationId: string | null): StreamState {
    const getSnapshot = useCallback(
        () => aiChatStreamStore.getState(conversationId),
        [conversationId],
    );
    return useSyncExternalStore(subscribeToStreams, getSnapshot, getSnapshot);
}

/**
 * Streaming chat hook backed by a module-level store. The stream survives the
 * component unmounting — the user can navigate away and the request keeps
 * running. When they return, the hook resubscribes and rehydrates the preview
 * from the store.
 *
 * Deliberately exposes only `isStreaming` and `lastRequest`: both keep their
 * value across token events, so `useSyncExternalStore` bails out and the
 * calling page does not re-render per streamed token.
 */
export function useSendChatMessage(conversationId: string | null) {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    const getIsStreaming = useCallback(
        () => aiChatStreamStore.getState(conversationId).isStreaming,
        [conversationId],
    );
    const getLastRequest = useCallback(
        () => aiChatStreamStore.getState(conversationId).lastRequest,
        [conversationId],
    );
    const isStreaming = useSyncExternalStore(
        subscribeToStreams,
        getIsStreaming,
        getIsStreaming,
    );
    const lastRequest = useSyncExternalStore(
        subscribeToStreams,
        getLastRequest,
        getLastRequest,
    );

    const send = useCallback(
        (body: SendBody): Promise<ChatCompleteEvent | null> => {
            return aiChatStreamStore.send(body, queryClient, (error) => {
                toast.error(t("aiChat.sendFailed"), {
                    description: apiErrorToMessage(error, t),
                });
            });
        },
        [queryClient, t],
    );

    const cancel = useCallback(() => {
        if (conversationId) aiChatStreamStore.cancel(conversationId);
    }, [conversationId]);

    return { send, cancel, isStreaming, lastRequest };
}

/**
 * Subscribes to the set of conversation ids currently streaming. Used by the
 * sidebar to surface live activity while the user is on another page.
 */
export function useStreamingConversationIds(): readonly string[] {
    const getSnapshot = useCallback(
        () => aiChatStreamStore.getActiveConversationIds(),
        [],
    );
    return useSyncExternalStore(subscribeToStreams, getSnapshot, getSnapshot);
}
