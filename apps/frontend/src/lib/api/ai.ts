import { z } from "zod";
import { AI_CHAT_STREAM_EVENT } from "@vision/types/aiChat";
import type {
    ChatDoneEvent,
    ChatMessage,
    ChatStreamEvent,
    Conversation,
    ConversationDetail,
    ConversationSummary,
    CreateConversationBody,
    OllamaModel,
    OllamaModelsResponse,
    OllamaStatus,
    SendChatBody,
} from "@/types/aiChat";
import {
    API_BASE_URL,
    apiRequest,
    generateRequestId,
    parseEnvelopeError,
} from "@/lib/api/client";
import { readSseFrames } from "@/lib/api/sse";
import logger from "@/lib/logger";

export const CHAT_STREAM_STALL_TIMEOUT_MS = 120_000;

/**
 * Runtime guards for the chat SSE stream payloads (ZOD-10). Loose objects
 * because the backend may add fields; TypeScript shapes stay sourced from
 * `@/types/aiChat` — after a successful parse the payload is cast to the
 * existing types. A payload that fails its schema is ignored exactly like a
 * payload that fails JSON.parse today (the stream tolerates bad frames), with
 * two exceptions: `token` keeps its raw-string fallback, and `error` always
 * surfaces (malformed fields fall back to the generic detail instead of
 * dropping the terminal error).
 */
const chatMessageEventSchema = z.looseObject({
    message: z.looseObject({
        role: z.string(),
        content: z.string().nullable().optional(),
    }),
});

const toolCallEventSchema = z.looseObject({
    name: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
});

// Terminal `done` payloads are deliberately only object-gated: consumers
// (and existing tests) accept sparse payloads here.
const doneEventSchema = z.looseObject({});

const errorEventSchema = z
    .looseObject({
        detail: z.string().catch("AI chat error"),
        code: z.string().optional().catch(undefined),
    })
    .catch({ detail: "AI chat error", code: undefined });

export function getOllamaStatus(): Promise<OllamaStatus> {
    return apiRequest("/api/ai/status");
}

/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function getOllamaModels(): Promise<OllamaModel[]> {
    const response = await apiRequest<OllamaModelsResponse>("/api/ai/models");
    return response.items ?? [];
}

export interface ConversationPage {
    items: ConversationSummary[];
    total: number;
    limit: number;
    offset: number;
}

/** The shipped client opts into bounded pages; unpaged compatibility stays server-side. */
export async function getConversations({
    limit = 50,
    offset = 0,
}: {
    limit?: number;
    offset?: number;
} = {}): Promise<ConversationPage> {
    return apiRequest<ConversationPage>(
        `/api/ai/conversations?limit=${limit}&offset=${offset}`,
    );
}

export function getConversation(id: string): Promise<ConversationDetail> {
    return apiRequest(`/api/ai/conversations/${encodeURIComponent(id)}`);
}

export function createConversation(
    body: CreateConversationBody = {},
): Promise<ConversationDetail> {
    return apiRequest("/api/ai/conversations", {
        method: "POST",
        body: JSON.stringify(body),
    });
}

export function renameConversation(
    id: string,
    title: string,
): Promise<Conversation> {
    return apiRequest(`/api/ai/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
    });
}

export async function deleteConversation(id: string): Promise<void> {
    await apiRequest(`/api/ai/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
}

export function streamChat(
    body: SendChatBody,
    onEvent: (event: ChatStreamEvent) => void,
): { abort: () => void; result: Promise<ChatStreamEvent & { type: "done" }> } {
    const controller = new AbortController();
    const url = `${API_BASE_URL}/api/ai/chat/stream`;

    const decodeEvent = (
        eventName: string,
        dataRaw: string,
    ): ChatStreamEvent | undefined => {
        if (eventName === AI_CHAT_STREAM_EVENT.TOKEN) {
            let delta: string;
            try {
                delta = JSON.parse(dataRaw);
            } catch {
                delta = dataRaw;
            }
            return {
                type: AI_CHAT_STREAM_EVENT.TOKEN,
                delta: typeof delta === "string" ? delta : String(delta),
            };
        }
        let payload: unknown;
        try {
            payload = JSON.parse(dataRaw);
        } catch {
            return undefined;
        }
        switch (eventName) {
            case AI_CHAT_STREAM_EVENT.USER_MESSAGE: {
                const parsed = chatMessageEventSchema.safeParse(payload);
                if (!parsed.success) return undefined;
                return {
                    type: AI_CHAT_STREAM_EVENT.USER_MESSAGE,
                    message: parsed.data.message as unknown as ChatMessage,
                };
            }
            case AI_CHAT_STREAM_EVENT.TOOL_CALL: {
                const parsed = toolCallEventSchema.safeParse(payload);
                if (!parsed.success) return undefined;
                return {
                    type: AI_CHAT_STREAM_EVENT.TOOL_CALL,
                    name: parsed.data.name,
                    args:
                        (parsed.data.args as
                            Record<string, unknown> | undefined) ?? {},
                };
            }
            case AI_CHAT_STREAM_EVENT.TOOL_RESULT: {
                const parsed = chatMessageEventSchema.safeParse(payload);
                if (!parsed.success) return undefined;
                return {
                    type: AI_CHAT_STREAM_EVENT.TOOL_RESULT,
                    message: parsed.data.message as unknown as ChatMessage,
                };
            }
            case AI_CHAT_STREAM_EVENT.COMPLETE:
            case AI_CHAT_STREAM_EVENT.DONE: {
                const parsed = doneEventSchema.safeParse(payload);
                if (!parsed.success) return undefined;
                return {
                    type: AI_CHAT_STREAM_EVENT.DONE,
                    payload: parsed.data as unknown as ChatDoneEvent,
                };
            }
            case AI_CHAT_STREAM_EVENT.ERROR: {
                // `.catch(...)` at both levels: this parse never throws, so a
                // malformed error payload still surfaces as a terminal error.
                const parsed = errorEventSchema.parse(payload);
                return {
                    type: AI_CHAT_STREAM_EVENT.ERROR,
                    detail: parsed.detail,
                    code: parsed.code,
                };
            }
            default:
                return undefined;
        }
    };

    const result = (async (): Promise<ChatStreamEvent & { type: "done" }> => {
        const start = Date.now();
        let timedOut = false;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const armWatchdog = () => {
            if (watchdog) clearTimeout(watchdog);
            watchdog = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, CHAT_STREAM_STALL_TIMEOUT_MS);
        };
        armWatchdog();
        logger.debug("[ai] streamChat start", {
            conversationId: body.conversationId,
            model: body.model,
            useTools: body.useTools,
            msgLen: body.message.length,
        });
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Request-Id": generateRequestId(),
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            logger.debug("[ai] streamChat response", {
                status: response.status,
                ms: Date.now() - start,
            });

            if (!response.ok) {
                throw await parseEnvelopeError(response, "Chat stream failed");
            }

            let terminal: (ChatStreamEvent & { type: "done" }) | null = null;
            let terminalError: { detail: string; code?: string } | null = null;

            for await (const frame of readSseFrames(response)) {
                armWatchdog();
                const event = decodeEvent(frame.eventName, frame.dataRaw);
                if (!event) continue;
                if (event.type === "done" && terminal) continue;
                logger.debug("[ai] streamChat event", {
                    type: event.type,
                    ms: Date.now() - start,
                });
                onEvent(event);
                if (event.type === "done") terminal = event;
                if (event.type === "error")
                    terminalError = { detail: event.detail, code: event.code };
            }

            if (terminalError) {
                const te = terminalError as { detail: string; code?: string };
                throw Object.assign(new Error(te.detail), { code: te.code });
            }
            if (!terminal)
                throw new Error("Stream ended without terminal event");
            return terminal;
        } catch (err) {
            if ((err as Error).name === "AbortError") {
                if (timedOut)
                    throw new Error("Chat stream timed out", { cause: err });
                throw new Error("Chat cancelled", { cause: err });
            }
            throw err;
        } finally {
            if (watchdog) clearTimeout(watchdog);
        }
    })();

    return {
        abort: () => {
            logger.warn(
                "[ai] streamChat abort() called",
                new Error("abort stack").stack,
            );
            controller.abort();
        },
        result,
    };
}
