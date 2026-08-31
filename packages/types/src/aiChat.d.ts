export declare const AI_CHAT_STREAM_EVENT: Readonly<{
  USER_MESSAGE: "user_message";
  TOKEN: "token";
  TOOL_CALL: "tool_call";
  TOOL_RESULT: "tool_result";
  COMPLETE: "complete";
  /** @deprecated Compatibility alias for AI clients predating the shared terminal event name. */
  DONE: "done";
  ERROR: "error";
}>;

export declare const AI_CHAT_STREAM_EVENT_NAMES: readonly AiChatStreamEventName[];

export type AiChatStreamEventName =
  (typeof AI_CHAT_STREAM_EVENT)[keyof typeof AI_CHAT_STREAM_EVENT];

export type ToolRenderAs = "table" | "line" | "bar" | "pie";

export interface AiChatToolResultMeta {
  renderAs?: ToolRenderAs;
  [key: string]: unknown;
}

export interface AiChatToolResultEnvelope<
  TData = unknown,
  TError = unknown,
  TMeta extends AiChatToolResultMeta = AiChatToolResultMeta,
> {
  ok: boolean;
  data?: TData;
  meta?: TMeta;
  error?: TError;
}

export interface AiChatWireMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  [key: string]: unknown;
}

export interface AiChatWireConversation {
  id: string;
  title: string;
  model: string;
  [key: string]: unknown;
}

export interface AiChatWireUsage {
  evalCount: number | null;
  promptEvalCount: number | null;
  totalDurationMs: number | null;
}

export interface AiChatDonePayload<
  TMessage = AiChatWireMessage,
  TConversation = AiChatWireConversation,
  TUsage = AiChatWireUsage,
> {
  conversation: TConversation;
  assistantMessage: TMessage;
  usage: TUsage;
  iterations: number;
}

/** Events emitted by aiChatService; every `data` value is ready for the SSE writer. */
export type AiChatServiceEvent<TMessage = AiChatWireMessage> =
  | { type: "user_message"; data: { message: TMessage } }
  | { type: "token"; data: string }
  | { type: "tool_call"; data: { name: string; args: Record<string, unknown> } }
  | { type: "tool_result"; data: { message: TMessage } };

/** Decoded stream events consumed by the frontend. */
export type AiChatStreamEvent<
  TMessage = AiChatWireMessage,
  TConversation = AiChatWireConversation,
  TUsage = AiChatWireUsage,
> =
  | { type: "user_message"; message: TMessage }
  | { type: "token"; delta: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; message: TMessage }
  | {
      type: "done";
      payload: AiChatDonePayload<TMessage, TConversation, TUsage>;
    }
  | { type: "error"; detail: string; code?: string };
