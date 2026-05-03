/**
 * Module-level store for AI chat streams.
 *
 * Streams live outside the React tree so navigating away from the chat page
 * does not abort the in-flight fetch. When the user returns, the component
 * resubscribes and rehydrates the streaming preview.
 *
 * Each stream is keyed by its conversation id. Brand-new conversations are
 * pre-created via the conversations endpoint before sending, so we always
 * have a real id at stream start — no PENDING bookkeeping required.
 */

import type { QueryClient } from '@tanstack/react-query';

import { apiClient } from '@/lib/api';
import logger from '@/lib/logger';
import type {
    ChatDoneEvent,
    ChatMessage,
    ChatStreamEvent,
    ConversationDetail,
    SendChatBody,
} from '@/types/aiChat';

const CONVERSATIONS_KEY = ['ai', 'conversations'] as const;
export const OPTIMISTIC_USER_ID_PREFIX = '__optimistic_user__';

export function isOptimisticUserId(id: string): boolean {
    return id.startsWith(OPTIMISTIC_USER_ID_PREFIX);
}

function mergeMessageIntoConversationCache(
    queryClient: QueryClient,
    conversationId: string,
    message: ChatMessage,
): void {
    queryClient.setQueryData<ConversationDetail | null>(
        ['ai', 'conversations', conversationId],
        (prev) => {
            if (!prev) return prev;
            if (prev.messages.some((m) => m.id === message.id)) return prev;
            return {
                ...prev,
                messages: [...prev.messages, message],
            };
        },
    );
}

function buildOptimisticUserMessage(content: string): ChatMessage {
    return {
        id: `${OPTIMISTIC_USER_ID_PREFIX}${Date.now()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
    };
}

export interface StreamState {
    isStreaming: boolean;
    assistantDraft: string;
    toolMessages: ChatMessage[];
    userMessage: ChatMessage | null;
    error: string | null;
}

export const INITIAL_STREAM_STATE: StreamState = Object.freeze({
    isStreaming: false,
    assistantDraft: '',
    toolMessages: [],
    userMessage: null,
    error: null,
});

const EMPTY_ACTIVE_IDS: readonly string[] = Object.freeze([]);

type Listener = () => void;

export type SendBody = Omit<SendChatBody, 'conversationId'> & { conversationId: string };

class AiChatStreamStore {
    private streams = new Map<string, StreamState>();
    private aborts = new Map<string, () => void>();
    private listeners = new Set<Listener>();
    private activeIdsCache: readonly string[] = EMPTY_ACTIVE_IDS;
    private activeIdsDirty = false;

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit(): void {
        this.activeIdsDirty = true;
        for (const listener of this.listeners) listener();
    }

    getState(conversationId: string | null): StreamState {
        if (conversationId == null) return INITIAL_STREAM_STATE;
        return this.streams.get(conversationId) ?? INITIAL_STREAM_STATE;
    }

    getActiveConversationIds(): readonly string[] {
        if (!this.activeIdsDirty) return this.activeIdsCache;
        const ids: string[] = [];
        for (const [id, state] of this.streams) {
            if (state.isStreaming) ids.push(id);
        }
        this.activeIdsCache = ids.length === 0 ? EMPTY_ACTIVE_IDS : Object.freeze(ids);
        this.activeIdsDirty = false;
        return this.activeIdsCache;
    }

    cancel(conversationId: string): void {
        const abort = this.aborts.get(conversationId);
        if (abort) {
            abort();
            this.aborts.delete(conversationId);
        }
        const current = this.streams.get(conversationId);
        if (current && current.isStreaming) {
            this.streams.set(conversationId, { ...current, isStreaming: false });
            this.emit();
        }
    }

    clear(conversationId: string): void {
        this.aborts.delete(conversationId);
        if (this.streams.has(conversationId)) {
            this.streams.delete(conversationId);
            this.emit();
        }
    }

    async send(
        body: SendBody,
        queryClient: QueryClient,
        onError: (message: string) => void,
    ): Promise<ChatDoneEvent | null> {
        const id = body.conversationId;

        const prior = this.aborts.get(id);
        if (prior) {
            logger.warn('[aiChatStreamStore] new send aborts prior stream', { id });
            prior();
        }

        this.streams.set(id, {
            ...INITIAL_STREAM_STATE,
            isStreaming: true,
            userMessage: buildOptimisticUserMessage(body.message),
        });
        this.emit();

        const handleEvent = (event: ChatStreamEvent): void => {
            const current = this.streams.get(id) ?? INITIAL_STREAM_STATE;
            let next: StreamState;
            switch (event.type) {
                case 'user_message':
                    next = { ...current, userMessage: event.message };
                    mergeMessageIntoConversationCache(queryClient, id, event.message);
                    break;
                case 'token':
                    next = { ...current, assistantDraft: current.assistantDraft + event.delta };
                    break;
                case 'tool_result':
                    next = { ...current, toolMessages: [...current.toolMessages, event.message] };
                    mergeMessageIntoConversationCache(queryClient, id, event.message);
                    break;
                case 'error':
                    next = { ...current, error: event.detail, isStreaming: false };
                    break;
                default:
                    return;
            }
            this.streams.set(id, next);
            this.emit();
        };

        const { abort, result } = apiClient.streamChat(body, handleEvent);
        this.aborts.set(id, abort);

        try {
            const done = await result;
            this.aborts.delete(id);
            const current = this.streams.get(id) ?? INITIAL_STREAM_STATE;

            // Merge the just-finished turn directly into the conversation
            // detail cache so the assistant message is visible the instant the
            // stream ends, even before the safety refetch lands. The `done`
            // SSE payload only carries the assistant message + conversation
            // metadata, so we splice in the streaming user/tool messages we
            // already accumulated.
            queryClient.setQueryData<ConversationDetail | null>(
                ['ai', 'conversations', id],
                (prev) => {
                    if (!prev) return prev;
                    const existing = prev.messages;
                    const seen = new Set(existing.map((m) => m.id));
                    const additions: ChatMessage[] = [];

                    if (
                        current.userMessage
                        && !isOptimisticUserId(current.userMessage.id)
                        && !seen.has(current.userMessage.id)
                    ) {
                        additions.push(current.userMessage);
                        seen.add(current.userMessage.id);
                    }
                    for (const toolMsg of current.toolMessages) {
                        if (!seen.has(toolMsg.id)) {
                            additions.push(toolMsg);
                            seen.add(toolMsg.id);
                        }
                    }
                    if (
                        done.payload.assistantMessage
                        && !seen.has(done.payload.assistantMessage.id)
                    ) {
                        additions.push(done.payload.assistantMessage);
                    }

                    return {
                        conversation: done.payload.conversation,
                        messages: [...existing, ...additions],
                    };
                },
            );

            // Drop the preview now — the cache has the real rows. Marking
            // isStreaming=false in the same batch as the delete avoids a
            // single-frame gap between draft and final message.
            this.streams.delete(id);
            this.emit();

            queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
            queryClient.invalidateQueries({ queryKey: ['ai', 'conversations', id] });

            return done.payload;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const current = this.streams.get(id) ?? INITIAL_STREAM_STATE;
            this.streams.set(id, { ...current, isStreaming: false, error: message });
            this.aborts.delete(id);
            this.emit();
            onError(message);
            return null;
        }
    }
}

export const aiChatStreamStore = new AiChatStreamStore();
