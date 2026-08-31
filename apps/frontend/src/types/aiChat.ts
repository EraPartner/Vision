import type {
    AiChatDonePayload,
    AiChatStreamEvent as SharedAiChatStreamEvent,
    AiChatToolResultEnvelope,
    AiChatToolResultMeta,
    ToolRenderAs as SharedToolRenderAs,
} from "@vision/types/aiChat";

export type ChatRole = "user" | "assistant" | "tool" | "system";

export type ToolRenderAs = SharedToolRenderAs;

/** ai_messages.status — CHECK constraint in migration 0001. */
export type ChatMessageStatus = "complete" | "streaming" | "aborted" | "error";

export interface ChatMessage {
    id: string;
    conversationId?: string;
    role: ChatRole;
    content: string | null;
    toolName?: string | null;
    toolArgs?: Record<string, unknown> | null;
    toolResult?: ToolResultPayload | null;
    /**
     * Always selected by aiChatRepository's MESSAGE_COLUMNS; optional here only
     * because the UI synthesizes placeholder messages while a turn streams.
     */
    status?: ChatMessageStatus;
    createdAt: string;
}

/**
 * A row from GET /api/ai/conversations. The list query selects exactly
 * aiChatRepository's CONVERSATION_COLUMNS — there is no message count in the
 * payload, so this no longer claims one.
 */
export interface ConversationSummary {
    id: string;
    title: string;
    model: string;
    createdAt: string;
    updatedAt: string;
}

export interface Conversation {
    id: string;
    title: string;
    model: string;
    createdAt?: string;
    updatedAt: string;
}

export interface ConversationDetail {
    conversation: Conversation;
    messages: ChatMessage[];
}

export interface ToolErrorDetail {
    code?: string;
    field?: string;
    message?: string;
    [key: string]: unknown;
}

export interface ToolResultMeta extends AiChatToolResultMeta {
    columns?: string[];
    xKey?: string;
    yKeys?: string[];
    total?: number;
}

export type ToolResultPayload = AiChatToolResultEnvelope<
    unknown,
    string | ToolErrorDetail,
    ToolResultMeta
>;

/**
 * Usage counters as forwarded from the Ollama generate/chat response by
 * aiChatService's `lastUsage`. Every field is null until the first model
 * response lands (and stays null for providers that omit the counter).
 */
export interface TokenUsage {
    evalCount: number | null;
    promptEvalCount: number | null;
    totalDurationMs: number | null;
}

export interface ChatTurnResponse {
    conversation: Conversation;
    userMessage: ChatMessage;
    toolMessages: ChatMessage[];
    assistantMessage: ChatMessage;
    usage: TokenUsage;
    iterations: number;
}

export type ChatDoneEvent = AiChatDonePayload<
    ChatMessage,
    Conversation,
    TokenUsage
>;

export type ChatStreamEvent = SharedAiChatStreamEvent<
    ChatMessage,
    Conversation,
    TokenUsage
>;

/**
 * `data` of GET /api/ai/status — exactly what routes/ai.js emits. There is no
 * `latencyMs`: the backend never measured or sent one (removed as phantom;
 * contract-guard now pins these keys to the OllamaStatus schema).
 */
export interface OllamaStatus {
    ok: boolean;
    baseUrl: string;
    displayUrl?: string;
    modelCount?: number;
    defaultModel: string;
    enabled: boolean;
    error?: string | null;
    code?: string | null;
    hint?: string | null;
}

/**
 * One entry from GET /api/ai/models. The backend does not pass Ollama's
 * /api/tags rows through verbatim — `ollama/client.js::listModels` projects
 * them onto exactly these fields, nulling anything the daemon omits.
 */
export interface OllamaModel {
    name: string;
    size: number | null;
    family: string | null;
    parameterSize: string | null;
    quantization: string | null;
    modifiedAt: string | null;
}

/** Canonical `{items, total}` collection body of GET /api/ai/models. */
export interface OllamaModelsResponse {
    items: OllamaModel[];
    total: number;
}

export interface CreateConversationBody {
    title?: string;
    model?: string;
}

export interface SendChatBody {
    conversationId: string | null;
    message: string;
    model?: string;
    useTools?: boolean;
    insightsPreCall?: boolean;
    /** Regenerate the latest incomplete turn without persisting the user row again. */
    retryLastTurn?: boolean;
}
