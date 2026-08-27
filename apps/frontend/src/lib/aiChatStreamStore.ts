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

import type { QueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import { aiKeys } from "@/lib/queryKeys";
import logger from "@/lib/logger";
import type {
    ChatDoneEvent,
    ChatMessage,
    ChatStreamEvent,
    ConversationDetail,
    SendChatBody,
} from "@/types/aiChat";

export const OPTIMISTIC_USER_ID_PREFIX = "__optimistic_user__";

export function isOptimisticUserId(id: string): boolean {
    return id.startsWith(OPTIMISTIC_USER_ID_PREFIX);
}

function mergeMessageIntoConversationCache(
    queryClient: QueryClient,
    conversationId: string,
    message: ChatMessage,
): void {
    queryClient.setQueryData<ConversationDetail | null>(
        aiKeys.conversation(conversationId),
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

function mergeDoneIntoConversationCache(
    queryClient: QueryClient,
    conversationId: string,
    done: ChatDoneEvent,
    current: StreamState,
): void {
    queryClient.setQueryData<ConversationDetail | null>(
        aiKeys.conversation(conversationId),
        (prev) => {
            if (!prev) return prev;
            const existing = prev.messages;
            const seen = new Set(existing.map((m) => m.id));
            const additions: ChatMessage[] = [];

            if (
                current.userMessage &&
                !isOptimisticUserId(current.userMessage.id) &&
                !seen.has(current.userMessage.id)
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
            if (done.assistantMessage && !seen.has(done.assistantMessage.id)) {
                additions.push(done.assistantMessage);
            }

            return {
                conversation: done.conversation,
                messages: [...existing, ...additions],
            };
        },
    );
}

function buildOptimisticUserMessage(content: string): ChatMessage {
    return {
        id: `${OPTIMISTIC_USER_ID_PREFIX}${Date.now()}`,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
    };
}

export interface StreamState {
    isStreaming: boolean;
    status: "idle" | "streaming" | "stopped" | "interrupted" | "timed_out";
    assistantDraft: string;
    toolMessages: ChatMessage[];
    userMessage: ChatMessage | null;
    error: string | null;
    lastRequest: SendBody | null;
}

export const INITIAL_STREAM_STATE: StreamState = Object.freeze({
    isStreaming: false,
    status: "idle",
    assistantDraft: "",
    toolMessages: [],
    userMessage: null,
    error: null,
    lastRequest: null,
});

const EMPTY_ACTIVE_IDS: readonly string[] = Object.freeze([]);

type Listener = () => void;

export type SendBody = Omit<SendChatBody, "conversationId"> & {
    conversationId: string;
};

class AiChatStreamStore {
    private streams = new Map<string, StreamState>();
    private aborts = new Map<string, () => void>();
    private listeners = new Set<Listener>();
    private activeIdsCache: readonly string[] = EMPTY_ACTIVE_IDS;
    private activeIdsDirty = false;
    private generations = new Map<string, number>();

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
        this.activeIdsDirty = false;
        // Compare-before-swap: token deltas dirty the cache on every event, but
        // the *active set* changes only when a stream starts/stops. Keeping the
        // previous array reference when membership is unchanged means
        // `useSyncExternalStore` consumers (ChatConversationList) don't re-render
        // per streamed token.
        const prev = this.activeIdsCache;
        if (
            ids.length === prev.length &&
            ids.every((id, i) => id === prev[i])
        ) {
            return prev;
        }
        this.activeIdsCache =
            ids.length === 0 ? EMPTY_ACTIVE_IDS : Object.freeze(ids);
        return this.activeIdsCache;
    }

    cancel(conversationId: string): void {
        this.generations.set(
            conversationId,
            (this.generations.get(conversationId) ?? 0) + 1,
        );
        const abort = this.aborts.get(conversationId);
        if (abort) {
            abort();
            this.aborts.delete(conversationId);
        }
        const current = this.streams.get(conversationId);
        if (current && current.isStreaming) {
            this.streams.set(conversationId, {
                ...current,
                isStreaming: false,
                status: "stopped",
                error: null,
            });
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
        // Handed the raw thrown value, not a string: the caller has `t` in scope
        // and routes it through `apiErrorToMessage` so a dead backend shows human
        // copy instead of "Failed to fetch". The raw text is still kept on the
        // stream state for logs/devtools.
        onError: (error: unknown) => void,
    ): Promise<ChatDoneEvent | null> {
        const id = body.conversationId;
        const generation = (this.generations.get(id) ?? 0) + 1;
        this.generations.set(id, generation);

        const prior = this.aborts.get(id);
        if (prior) {
            logger.warn("[aiChatStreamStore] new send aborts prior stream", {
                id,
            });
            prior();
        }

        this.streams.set(id, {
            ...INITIAL_STREAM_STATE,
            isStreaming: true,
            status: "streaming",
            userMessage: buildOptimisticUserMessage(body.message),
            lastRequest: body,
        });
        this.emit();

        const handleEvent = (event: ChatStreamEvent): void => {
            if (this.generations.get(id) !== generation) return;
            const current = this.streams.get(id) ?? INITIAL_STREAM_STATE;
            let next: StreamState;
            switch (event.type) {
                case "user_message":
                    next = { ...current, userMessage: event.message };
                    try {
                        mergeMessageIntoConversationCache(
                            queryClient,
                            id,
                            event.message,
                        );
                    } catch (cacheErr) {
                        logger.warn("[aiChatStreamStore] cache merge failed", {
                            cacheErr,
                        });
                    }
                    break;
                case "token":
                    next = {
                        ...current,
                        assistantDraft: current.assistantDraft + event.delta,
                    };
                    break;
                case "tool_result":
                    next = {
                        ...current,
                        toolMessages: [...current.toolMessages, event.message],
                    };
                    try {
                        mergeMessageIntoConversationCache(
                            queryClient,
                            id,
                            event.message,
                        );
                    } catch (cacheErr) {
                        logger.warn("[aiChatStreamStore] cache merge failed", {
                            cacheErr,
                        });
                    }
                    break;
                case "done":
                    // Fast-path cleanup. Tied to the SSE event so the UI flips
                    // out of streaming the instant the terminal frame lands —
                    // we do not wait for the post-await path which can race
                    // against a refetch that has already populated the cache.
                    try {
                        mergeDoneIntoConversationCache(
                            queryClient,
                            id,
                            event.payload,
                            current,
                        );
                    } catch (cacheErr) {
                        logger.warn("[aiChatStreamStore] done merge failed", {
                            cacheErr,
                        });
                    }
                    this.streams.delete(id);
                    this.aborts.delete(id);
                    this.emit();
                    queryClient.invalidateQueries({
                        queryKey: aiKeys.conversations,
                    });
                    queryClient.invalidateQueries({
                        queryKey: aiKeys.conversation(id),
                    });
                    return;
                case "error":
                    next = {
                        ...current,
                        error: event.detail,
                        isStreaming: false,
                        status: "interrupted",
                    };
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
            // Cleanup already happened inside handleEvent on the 'done' SSE
            // event. Defensive: if for any reason the entry survived (e.g.
            // event arrived corrupt), make sure it is gone now.
            if (this.streams.has(id)) {
                this.streams.delete(id);
                this.emit();
            }
            this.aborts.delete(id);
            return done.payload;
        } catch (err) {
            if (this.generations.get(id) !== generation) return null;
            if (
                err instanceof Error &&
                "code" in err &&
                err.code === "TURN_ALREADY_COMPLETE"
            ) {
                this.streams.delete(id);
                this.aborts.delete(id);
                this.emit();
                try {
                    const completed = await apiClient.getConversation(id);
                    if (this.generations.get(id) !== generation) return null;
                    queryClient.setQueryData(
                        aiKeys.conversation(id),
                        completed,
                    );
                } catch (refreshError) {
                    logger.warn(
                        "[aiChatStreamStore] completed-turn refresh failed",
                        { id, refreshError },
                    );
                    queryClient.invalidateQueries({
                        queryKey: aiKeys.conversation(id),
                    });
                }
                queryClient.invalidateQueries({
                    queryKey: aiKeys.conversations,
                });
                return null;
            }
            const message = err instanceof Error ? err.message : String(err);
            const current = this.streams.get(id) ?? INITIAL_STREAM_STATE;
            this.streams.set(id, {
                ...current,
                isStreaming: false,
                status:
                    message === "Chat stream timed out"
                        ? "timed_out"
                        : "interrupted",
                error: message,
            });
            this.aborts.delete(id);
            this.emit();
            onError(err);
            return null;
        }
    }
}

export const aiChatStreamStore = new AiChatStreamStore();
