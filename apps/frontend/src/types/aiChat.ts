export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export type ToolRenderAs = 'table' | 'line' | 'bar' | 'pie';

export interface ChatMessage {
  id: string;
  conversationId?: string;
  role: ChatRole;
  content: string | null;
  toolName?: string | null;
  toolArgs?: Record<string, unknown> | null;
  toolResult?: ToolResultPayload | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
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

export interface ToolResultPayload {
  ok: boolean;
  data?: unknown;
  meta?: {
    renderAs?: ToolRenderAs;
    columns?: string[];
    xKey?: string;
    yKeys?: string[];
    total?: number;
    [key: string]: unknown;
  };
  error?: string | ToolErrorDetail;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatTurnResponse {
  conversation: Conversation;
  userMessage: ChatMessage;
  toolMessages: ChatMessage[];
  assistantMessage: ChatMessage;
  usage: TokenUsage;
  iterations: number;
}

export interface ChatDoneEvent {
  conversation: Conversation;
  assistantMessage: ChatMessage;
  usage: TokenUsage;
  iterations: number;
}

export type ChatStreamEvent =
  | { type: 'user_message'; message: ChatMessage }
  | { type: 'token'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; message: ChatMessage }
  | { type: 'done'; payload: ChatDoneEvent }
  | { type: 'error'; detail: string; code?: string };

export interface OllamaStatus {
  ok: boolean;
  baseUrl: string;
  displayUrl?: string;
  modelCount?: number;
  latencyMs?: number;
  defaultModel: string;
  enabled: boolean;
  error?: string | null;
  code?: string | null;
  hint?: string | null;
}

export interface OllamaModel {
  name: string;
  size?: number;
  modified?: string;
  digest?: string;
}

export interface OllamaModelsResponse {
  models: OllamaModel[];
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
}
