import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';
import logger from '@/lib/logger';
import type {
    ChatDoneEvent,
    ChatMessage,
    ChatStreamEvent,
    ConversationDetail,
    CreateConversationBody,
    SendChatBody,
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

interface StreamingState {
    isStreaming: boolean;
    assistantDraft: string;
    toolMessages: ChatMessage[];
    userMessage: ChatMessage | null;
    error: string | null;
}

const INITIAL_STREAM: StreamingState = {
    isStreaming: false,
    assistantDraft: '',
    toolMessages: [],
    userMessage: null,
    error: null,
};

export function useSendChatMessage() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();
    const [state, setState] = useState<StreamingState>(INITIAL_STREAM);
    const abortRef = useRef<(() => void) | null>(null);
    const isStreamingRef = useRef<boolean>(false);

    useEffect(() => {
        return () => {
            if (abortRef.current && isStreamingRef.current) {
                logger.warn('[useSendChatMessage] unmount cleanup aborting in-flight stream');
                abortRef.current();
            }
        };
    }, []);

    const send = useCallback(
        async (body: SendChatBody): Promise<ChatDoneEvent | null> => {
            if (abortRef.current) {
                logger.warn('[useSendChatMessage] new send aborting prior in-flight stream');
                abortRef.current();
            }
            isStreamingRef.current = true;
            setState({ ...INITIAL_STREAM, isStreaming: true });

            const handleEvent = (event: ChatStreamEvent) => {
                setState((prev) => {
                    switch (event.type) {
                        case 'user_message':
                            return { ...prev, userMessage: event.message };
                        case 'token':
                            return { ...prev, assistantDraft: prev.assistantDraft + event.delta };
                        case 'tool_result':
                            return { ...prev, toolMessages: [...prev.toolMessages, event.message] };
                        case 'error':
                            return { ...prev, error: event.detail, isStreaming: false };
                        default:
                            return prev;
                    }
                });
            };

            const { abort, result } = apiClient.streamChat(body, handleEvent);
            abortRef.current = abort;

            try {
                const done = await result;
                setState((prev) => ({ ...prev, isStreaming: false }));
                queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
                queryClient.invalidateQueries({ queryKey: ['ai', 'conversations', done.payload.conversation.id] });
                return done.payload;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setState((prev) => ({ ...prev, isStreaming: false, error: message }));
                toast.error(t('aiChat.sendFailed'), { description: message });
                return null;
            } finally {
                abortRef.current = null;
                isStreamingRef.current = false;
            }
        },
        [queryClient, t],
    );

    const cancel = useCallback(() => {
        if (abortRef.current) {
            abortRef.current();
            abortRef.current = null;
        }
        isStreamingRef.current = false;
        setState((prev) => ({ ...prev, isStreaming: false }));
    }, []);

    const reset = useCallback(() => {
        if (abortRef.current) {
            abortRef.current();
            abortRef.current = null;
        }
        isStreamingRef.current = false;
        setState(INITIAL_STREAM);
    }, []);

    return { send, cancel, reset, ...state };
}
