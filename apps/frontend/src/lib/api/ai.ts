import { z } from 'zod';
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
} from '@/types/aiChat';
import { API_BASE_URL, apiRequest, generateRequestId, parseEnvelopeError } from '@/lib/api/client';
import { readSseFrames } from '@/lib/api/sse';
import logger from '@/lib/logger';

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
        detail: z.string().catch('AI chat error'),
        code: z.string().optional().catch(undefined),
    })
    .catch({ detail: 'AI chat error', code: undefined });

export function getOllamaStatus(): Promise<OllamaStatus> {
    return apiRequest('/api/ai/status');
}

/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function getOllamaModels(): Promise<OllamaModel[]> {
    const response = await apiRequest<OllamaModelsResponse>('/api/ai/models');
    return response.items ?? [];
}

/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function getConversations(): Promise<ConversationSummary[]> {
    const { items } = await apiRequest<{ items: ConversationSummary[]; total: number }>('/api/ai/conversations');
    return items;
}

export function getConversation(id: string): Promise<ConversationDetail> {
    return apiRequest(`/api/ai/conversations/${encodeURIComponent(id)}`);
}

export function createConversation(body: CreateConversationBody = {}): Promise<ConversationDetail> {
    return apiRequest('/api/ai/conversations', { method: 'POST', body: JSON.stringify(body) });
}

export function renameConversation(id: string, title: string): Promise<Conversation> {
    return apiRequest(`/api/ai/conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
    });
}

export async function deleteConversation(id: string): Promise<void> {
    await apiRequest(`/api/ai/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function streamChat(
    body: SendChatBody,
    onEvent: (event: ChatStreamEvent) => void,
): { abort: () => void; result: Promise<ChatStreamEvent & { type: 'done' }> } {
    const controller = new AbortController();
    const url = `${API_BASE_URL}/api/ai/chat/stream`;

    const decodeEvent = (eventName: string, dataRaw: string): ChatStreamEvent | undefined => {
        if (eventName === 'token') {
            let delta: string;
            try {
                delta = JSON.parse(dataRaw);
            } catch {
                delta = dataRaw;
            }
            return { type: 'token', delta: typeof delta === 'string' ? delta : String(delta) };
        }
        let payload: unknown;
        try {
            payload = JSON.parse(dataRaw);
        } catch {
            return undefined;
        }
        switch (eventName) {
            case 'user_message': {
                const parsed = chatMessageEventSchema.safeParse(payload);
                if (!parsed.success) return undefined;
                return { type: 'user_message', message: parsed.data.message as unknown as ChatMessage };
            }
            case 'tool_call': {
                const parsed = toolCallEventSchema.safeParse(payload);
                if (!parsed.success) return undefined;
                return { type: 'tool_call', name: parsed.data.name, args: (parsed.data.args as Record<string, unknown> | undefined) ?? {} };
            }
            case 'tool_result': {
                const parsed = chatMessageEventSchema.safeParse(payload);
                if (!parsed.success) return undefined;
                return { type: 'tool_result', message: parsed.data.message as unknown as ChatMessage };
            }
            case 'done': {
                const parsed = doneEventSchema.safeParse(payload);
                if (!parsed.success) return undefined;
                return { type: 'done', payload: parsed.data as unknown as ChatDoneEvent };
            }
            case 'error': {
                // `.catch(...)` at both levels: this parse never throws, so a
                // malformed error payload still surfaces as a terminal error.
                const parsed = errorEventSchema.parse(payload);
                return { type: 'error', detail: parsed.detail, code: parsed.code };
            }
            default:
                return undefined;
        }
    };

    const result = (async (): Promise<ChatStreamEvent & { type: 'done' }> => {
        const start = Date.now();
        logger.debug('[ai] streamChat start', { conversationId: body.conversationId, model: body.model, useTools: body.useTools, msgLen: body.message.length });
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Request-Id': generateRequestId(),
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            logger.debug('[ai] streamChat response', { status: response.status, ms: Date.now() - start });

            if (!response.ok) {
                throw await parseEnvelopeError(response, 'Chat stream failed');
            }

            let terminal: (ChatStreamEvent & { type: 'done' }) | null = null;
            let terminalError: { detail: string; code?: string } | null = null;

            for await (const frame of readSseFrames(response)) {
                const event = decodeEvent(frame.eventName, frame.dataRaw);
                if (!event) continue;
                logger.debug('[ai] streamChat event', { type: event.type, ms: Date.now() - start });
                onEvent(event);
                if (event.type === 'done') terminal = event;
                if (event.type === 'error') terminalError = { detail: event.detail, code: event.code };
            }

            if (terminalError) {
                const te = terminalError as { detail: string; code?: string };
                throw Object.assign(new Error(te.detail), { code: te.code });
            }
            if (!terminal) throw new Error('Stream ended without terminal event');
            return terminal;
        } catch (err) {
            if ((err as Error).name === 'AbortError') {
                throw new Error('Chat cancelled', { cause: err });
            }
            throw err;
        }
    })();

    return {
        abort: () => {
            logger.warn('[ai] streamChat abort() called', new Error('abort stack').stack);
            controller.abort();
        },
        result,
    };
}
