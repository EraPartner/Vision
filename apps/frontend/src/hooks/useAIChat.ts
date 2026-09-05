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
import { aiChatStreamStore, type SendBody } from "@/lib/aiChatStreamStore";
import type {
    ChatDoneEvent,
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
        staleTime: 30_000,
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
        placeholderData: (prev) => prev,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}

export function useCreateConversation() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (body: CreateConversationBody = {}) =>
            apiClient.createConversation(body),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: aiKeys.conversations });
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
            queryClient.invalidateQueries({ queryKey: aiKeys.conversations });
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
            queryClient.invalidateQueries({
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

/**
 * Streaming chat hook backed by a module-level store. The stream survives the
 * component unmounting — the user can navigate away and the request keeps
 * running. When they return, the hook resubscribes and rehydrates the preview
 * from the store.
 */
export function useSendChatMessage(conversationId: string | null) {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    const subscribe = useCallback(
        (listener: () => void) => aiChatStreamStore.subscribe(listener),
        [],
    );
    const getSnapshot = useCallback(
        () => aiChatStreamStore.getState(conversationId),
        [conversationId],
    );
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const send = useCallback(
        (body: SendBody): Promise<ChatDoneEvent | null> => {
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

    return { send, cancel, ...state };
}

/**
 * Subscribes to the set of conversation ids currently streaming. Used by the
 * sidebar to surface live activity while the user is on another page.
 */
export function useStreamingConversationIds(): readonly string[] {
    const subscribe = useCallback(
        (listener: () => void) => aiChatStreamStore.subscribe(listener),
        [],
    );
    const getSnapshot = useCallback(
        () => aiChatStreamStore.getActiveConversationIds(),
        [],
    );
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
