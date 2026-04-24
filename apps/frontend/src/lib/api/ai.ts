import type {
    ChatStreamEvent,
    ChatTurnResponse,
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

export function getOllamaStatus(): Promise<OllamaStatus> {
    return apiRequest('/api/ai/status');
}

export async function getOllamaModels(): Promise<OllamaModel[]> {
    const response = await apiRequest<OllamaModelsResponse>('/api/ai/models');
    return response.models ?? [];
}

export function getConversations(): Promise<ConversationSummary[]> {
    return apiRequest('/api/ai/conversations');
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

export function sendChatMessage(body: SendChatBody): Promise<ChatTurnResponse> {
    return apiRequest('/api/ai/chat', { method: 'POST', body: JSON.stringify(body) });
}

export function streamChat(
    body: SendChatBody,
    onEvent: (event: ChatStreamEvent) => void,
): { abort: () => void; result: Promise<ChatStreamEvent & { type: 'done' }> } {
    const controller = new AbortController();
    const url = `${API_BASE_URL}/api/ai/chat/stream`;

    const parseSseBlock = (block: string): { eventName: string; dataRaw: string } | undefined => {
        let eventName = 'message';
        const dataLines: string[] = [];
        for (const rawLine of block.split(/\r?\n/)) {
            if (!rawLine || rawLine.startsWith(':')) continue;
            if (rawLine.startsWith('event:')) {
                eventName = rawLine.slice('event:'.length).trim() || 'message';
                continue;
            }
            if (rawLine.startsWith('data:')) {
                dataLines.push(rawLine.slice('data:'.length).trimStart());
            }
        }
        if (dataLines.length === 0) return undefined;
        return { eventName, dataRaw: dataLines.join('\n') };
    };

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
        const p = payload as Record<string, unknown>;
        switch (eventName) {
            case 'user_message':
                return { type: 'user_message', message: p.message as string };
            case 'tool_call':
                return { type: 'tool_call', name: p.name as string, args: (p.args as Record<string, unknown>) ?? {} };
            case 'tool_result':
                return { type: 'tool_result', message: p.message as string };
            case 'done':
                return { type: 'done', payload: p };
            case 'error':
                return { type: 'error', detail: (p.detail as string) ?? 'AI chat error', code: p.code as string | undefined };
            default:
                return undefined;
        }
    };

    const result = (async (): Promise<ChatStreamEvent & { type: 'done' }> => {
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

            if (!response.ok) {
                throw await parseEnvelopeError(response, 'Chat stream failed');
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No response body');

            const decoder = new TextDecoder();
            let buffer = '';
            let terminal: (ChatStreamEvent & { type: 'done' }) | null = null;
            let terminalError: { detail: string; code?: string } | null = null;

            const processEventBlock = (block: string) => {
                const parsed = parseSseBlock(block);
                if (!parsed) return;
                const event = decodeEvent(parsed.eventName, parsed.dataRaw);
                if (!event) return;
                onEvent(event);
                if (event.type === 'done') terminal = event;
                if (event.type === 'error') terminalError = { detail: event.detail, code: event.code };
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let match = buffer.match(/\r?\n\r?\n/);
                while (match) {
                    const index = match.index ?? -1;
                    if (index < 0) break;
                    const block = buffer.slice(0, index);
                    buffer = buffer.slice(index + match[0].length);
                    processEventBlock(block);
                    match = buffer.match(/\r?\n\r?\n/);
                }
            }

            const trailing = decoder.decode();
            if (trailing) buffer += trailing;
            if (buffer.trim()) processEventBlock(buffer.trimEnd());

            if (terminalError) {
                throw Object.assign(new Error(terminalError.detail), { code: terminalError.code });
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

    return { abort: () => controller.abort(), result };
}
