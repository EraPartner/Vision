import { useCallback, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';
import { aiChatStreamStore, type SendBody } from '@/lib/aiChatStreamStore';
import type {
    ChatDoneEvent,
    ConversationDetail,
    CreateConversationBody,
} from '@/types/aiChat';

const CONVERSATIONS_KEY = ['ai', 'conversations'] as const;

export function useConversations() {
    return useQuery({
        queryKey: CONVERSATIONS_KEY,
        queryFn: () => apiClient.getConversations(),
        staleTime: 30_000,
        placeholderData: (prev) => prev,
    });
}

export function useConversation(id: string | null) {
    return useQuery({
        queryKey: ['ai', 'conversations', id],
        queryFn: () => (id ? apiClient.getConversation(id) : Promise.resolve(null)),
        enabled: Boolean(id),
        staleTime: 10_000,
        placeholderData: (prev) => prev,
    });
}

export function useCreateConversation() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (body: CreateConversationBody = {}) => apiClient.createConversation(body),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
            queryClient.setQueryData(['ai', 'conversations', data.conversation.id], data);
        },
        onError: (error: Error) => {
            toast.error(t('aiChat.createFailed'), { description: error.message });
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
            queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
            queryClient.setQueryData<ConversationDetail | undefined>(
                ['ai', 'conversations', updated.id],
                (prev) => (prev ? { ...prev, conversation: { ...prev.conversation, ...updated } } : prev),
            );
        },
        onError: (error: Error) => {
            toast.error(t('aiChat.renameFailed'), { description: error.message });
        },
    });
}

export function useDeleteConversation() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: string) => apiClient.deleteConversation(id),
        onSuccess: (_void, id) => {
            queryClient.removeQueries({ queryKey: ['ai', 'conversations', id] });
            queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY, exact: true });
            toast.success(t('aiChat.deleted'));
        },
        onError: (error: Error) => {
            toast.error(t('aiChat.deleteFailed'), { description: error.message });
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

    const subscribe = useCallback((listener: () => void) => aiChatStreamStore.subscribe(listener), []);
    const getSnapshot = useCallback(() => aiChatStreamStore.getState(conversationId), [conversationId]);
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const send = useCallback(
        (body: SendBody): Promise<ChatDoneEvent | null> => {
            return aiChatStreamStore.send(body, queryClient, (message) => {
                toast.error(t('aiChat.sendFailed'), { description: message });
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
    const subscribe = useCallback((listener: () => void) => aiChatStreamStore.subscribe(listener), []);
    const getSnapshot = useCallback(() => aiChatStreamStore.getActiveConversationIds(), []);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
