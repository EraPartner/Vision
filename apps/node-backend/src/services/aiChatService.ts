/**
 * AI chat orchestrator.
 *
 * Responsibilities:
 *   - Load conversation history from the repo.
 *   - Persist the new user message.
 *   - Run the tool-call loop: call Ollama with `tools`, if the model emits
 *     `tool_calls`, dispatch each, persist the tool result row, and re-call
 *     until the model returns a pure assistant message (or the iteration
 *     cap is hit).
 *   - Persist the final assistant message and return the turn.
 *
 * Streaming mode: when `streaming: true`, uses `ollamaClient.chatStream`
 * and emits `token` events (content deltas) via `onEvent` for each chunk.
 * Also emits a `tool_call` event before each dispatch (progress affordance
 * for slow tools) carrying the model's args when they are already a plain
 * object, else `{}`. Every service event already uses the public SSE name and
 * payload; the terminal assistant row is carried only by the route's `complete` frame.
 *
 * Tool-call argument coercion lives in exactly one place: `dispatchTool`
 * (services/aiChat/tools/index.js). This module passes the model's raw
 * `function.arguments` through untouched and persists/streams the `args`
 * the dispatcher reports back.
 */

import { logger } from "../config/logger.ts";
import settings from "../config/config.ts";
import { AppError } from "../middleware/errorHandler.ts";
import { aiChatRepository } from "../repositories/aiChatRepository.ts";
import { getOllamaClient } from "../integrations/ollama/client.ts";
import {
  buildChatMessages,
  serializeToolResultForPrompt,
} from "../integrations/ollama/prompts.ts";
import type { OllamaToolCall } from "../integrations/ollama/prompts.ts";
import { AI_CHAT_STREAM_EVENT } from "@vision/types/aiChat";
import type { AiChatServiceEvent } from "@vision/types/aiChat";
import type { ToolCache } from "./aiChat/toolCache.ts";
import {
  dispatchTool,
  getToolSchemas,
  getToolNames,
} from "./aiChat/tools/index.ts";

import type { AiConversationRow, AiMessageRow } from "../types/rows.ts";

export type { AiConversationRow, AiMessageRow };

/**
 * A message in the array sent to/received from the Ollama `/api/chat`
 * endpoint (see integrations/ollama/prompts.ts `toOllamaMessage`). `tool_calls`
 * only appears on an assistant message that invoked a tool; `name` only
 * appears on a `role: 'tool'` result message.
 */
export type OllamaMessage = {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
  name?: string;
};

type OllamaClient = ReturnType<typeof getOllamaClient>;

/** The injectable chat client: `chat` is required, `chatStream` optional. */
export type AiChatClient = Pick<OllamaClient, "chat"> &
  Partial<Pick<OllamaClient, "chatStream">>;

export type AiChatEventHandler = (
  event: AiChatServiceEvent<AiMessageRow>,
) => void | Promise<void>;

export interface ChatTurnUsage {
  evalCount: number | null;
  promptEvalCount: number | null;
  totalDurationMs: number | null;
}

export interface ChatTurnResult {
  conversation: AiConversationRow;
  userMessage: AiMessageRow;
  toolMessages: AiMessageRow[];
  assistantMessage: AiMessageRow;
  usage: ChatTurnUsage;
  iterations: number;
}

export interface RunChatTurnArgs {
  /** existing conversation UUID, or null to create a new one */
  conversationId?: string | null;
  /** the new user message text */
  message?: string;
  /** override the model (else conversation/default) */
  model?: string | null;
  useTools?: boolean;
  retryLastTurn?: boolean;
  /**
   * tool name to execute server-side BEFORE the model turn (ADR-110 §4). Its
   * result is injected into the model's context so the model only narrates
   * the already-fetched findings instead of deciding whether to call the tool.
   */
  preCallTool?: string | null;
  /** propagate cancellation */
  signal?: AbortSignal;
  /**
   * when true, use `ollamaClient.chatStream` and emit per-chunk `token`
   * events via `onEvent`.
   */
  streaming?: boolean;
  /**
   * Optional hook called for each persisted message, tool call/result, and
   * (in streaming mode) each content delta. May be async — awaited at each
   * call site.
   */
  onEvent?: AiChatEventHandler;
  ollamaClient?: AiChatClient;
}

interface ChatTurnInnerArgs {
  conversationId: string | null;
  message: string;
  model: string | null;
  useTools: boolean;
  preCallTool: string | null;
  retryLastTurn: boolean;
  signal: AbortSignal | undefined;
  streaming: boolean;
  onEvent: AiChatEventHandler | undefined;
  ollamaClient: AiChatClient;
}

/** Reads `err?.[key]` from a caught value without assuming its shape. */
function errorProperty(err: unknown, key: "code" | "message"): unknown {
  return typeof err === "object" && err !== null
    ? Reflect.get(err, key)
    : undefined;
}

const MAX_TOOL_ITERATIONS = 6;
const DEFAULT_CONVERSATION_TITLE = "New conversation";
const conversationTurnTails = new Map<string, Promise<void>>();

/**
 * Serialize model turns for one conversation. A retry can arrive while the
 * original request is still completing; making both requests pass through the
 * same queue ensures the retry re-reads history after the original append.
 */
async function withConversationTurnLock<T>(
  conversationId: string,
  task: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const previous =
    conversationTurnTails.get(conversationId) ?? Promise.resolve();
  // Replaced synchronously by the Promise executor below.
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = () => resolve(undefined);
  });
  conversationTurnTails.set(conversationId, current);
  let removeAbortListener = () => {};
  const aborted = new Promise<boolean>((resolve) => {
    if (!signal) return;
    const handleAbort = () => resolve(true);
    signal.addEventListener("abort", handleAbort, { once: true });
    removeAbortListener = () =>
      signal.removeEventListener("abort", handleAbort);
  });
  const wasAborted = signal?.aborted
    ? true
    : await Promise.race([previous.then(() => false), aborted]);
  removeAbortListener();
  if (wasAborted || signal?.aborted) {
    void previous.finally(() => {
      release();
      if (conversationTurnTails.get(conversationId) === current) {
        conversationTurnTails.delete(conversationId);
      }
    });
    throw new AiChatServiceError("Chat request was cancelled", {
      code: "ABORTED",
      status: 499,
    });
  }
  try {
    return await task();
  } finally {
    release();
    if (conversationTurnTails.get(conversationId) === current) {
      conversationTurnTails.delete(conversationId);
    }
  }
}

export class AiChatServiceError extends AppError {
  constructor(
    message: string,
    {
      code,
      status,
      cause,
    }: { code?: string; status?: number; cause?: unknown } = {},
  ) {
    // Extend AppError so the central error middleware forwards our status/code
    // (e.g. 404/410/503) instead of collapsing to a generic 500. Defaults match
    // the previous plain-Error behaviour.
    super(message, {
      code: code || "AI_CHAT_ERROR",
      status: status || 500,
      cause,
    });
    this.name = "AiChatServiceError";
  }
}

/**
 * Extract the tool name and the raw (uncoerced) `function.arguments` value
 * from an Ollama `tool_calls[]` entry. Coercion is deliberately NOT done
 * here — `dispatchTool` is the single coercion point and reports back the
 * args the tool actually saw.
 * @param toolCall raw Ollama `tool_calls[]` entry (or a legacy flat
 *   `{ name, arguments }` entry).
 */
function normalizeToolCall(
  toolCall:
    | (OllamaToolCall & { name?: string; arguments?: unknown })
    | null
    | undefined,
): { name: string | undefined; rawArgs: unknown } {
  const fn: { name?: string; arguments?: unknown } =
    toolCall?.function || toolCall || {};
  const name = fn.name || toolCall?.name || undefined;
  const rawArgs = fn.arguments ?? toolCall?.arguments;
  return { name, rawArgs };
}

/**
 * True when `value` is a plain args record — the only shape the SSE
 * `tool_call` frame may carry (the frontend schema is `z.record(...)`).
 */
function isArgsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The injectable chat client contract identifies provider failures by code,
 * not by one provider's concrete Error subclass.
 */
function isCodedProviderError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof err.code === "string" &&
    err.code.length > 0
  );
}

function truncateTitle(text: string | null | undefined, maxLen = 60): string {
  const trimmed = (text || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return DEFAULT_CONVERSATION_TITLE;
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

/**
 * Ensure a conversation exists. If `conversationId` is provided, validate it;
 * otherwise create a new one titled from the first user message.
 */
async function ensureConversation({
  conversationId,
  model,
  firstUserMessage,
}: {
  conversationId?: string | null;
  model?: string | null;
  firstUserMessage?: string;
}): Promise<AiConversationRow> {
  if (conversationId) {
    const existing = await aiChatRepository.getConversation(conversationId);
    if (!existing) {
      throw new AiChatServiceError(`Conversation ${conversationId} not found`, {
        code: "CONVERSATION_NOT_FOUND",
        status: 404,
      });
    }
    if (model && existing.model !== model) {
      await aiChatRepository.updateConversationModel(conversationId, model);
      existing.model = model;
    }
    if (existing.title === DEFAULT_CONVERSATION_TITLE && firstUserMessage) {
      const newTitle = truncateTitle(firstUserMessage);
      if (newTitle && newTitle !== DEFAULT_CONVERSATION_TITLE) {
        const renamed = await aiChatRepository.renameConversation(
          conversationId,
          newTitle,
        );
        if (renamed) existing.title = renamed.title;
      }
    }
    return existing;
  }

  const title = truncateTitle(firstUserMessage);
  return aiChatRepository.createConversation({
    title,
    model: model || settings.ollama.defaultModel,
  });
}

/**
 * Run a single chat turn.
 */
export async function runChatTurn({
  conversationId = null,
  message,
  model = null,
  useTools = true,
  preCallTool = null,
  retryLastTurn = false,
  signal,
  streaming = false,
  onEvent,
  ollamaClient = getOllamaClient(),
}: RunChatTurnArgs = {}): Promise<ChatTurnResult> {
  if (!settings.aiChat.enabled) {
    throw new AiChatServiceError("AI chat is disabled", {
      code: "AI_CHAT_DISABLED",
      status: 503,
    });
  }
  if (typeof message !== "string" || !message.trim()) {
    throw new AiChatServiceError("message is required", {
      code: "INVALID_INPUT",
      status: 400,
    });
  }

  try {
    return await runChatTurnInner({
      conversationId,
      message,
      model,
      useTools,
      preCallTool,
      retryLastTurn,
      signal,
      streaming,
      onEvent,
      ollamaClient,
    });
  } catch (err) {
    // The repository throws ConversationDeletedError (code: 'CONVERSATION_DELETED')
    // when an appendMessage hits the FK constraint — i.e. the user deleted
    // the conversation while a stream was in flight. Surface as a clean
    // service-level error so the route emits an SSE error frame instead of
    // a 500 stack.
    if (
      err instanceof Error &&
      "code" in err &&
      err.code === "CONVERSATION_DELETED"
    ) {
      logger.info("[aiChat] turn aborted: conversation deleted mid-stream", {
        conversationId:
          "conversationId" in err ? err.conversationId : undefined,
      });
      throw new AiChatServiceError(err.message, {
        code: "CONVERSATION_DELETED",
        status: 410,
        cause: err,
      });
    }
    throw err;
  }
}

async function runChatTurnInner({
  conversationId,
  message,
  model,
  useTools,
  preCallTool,
  retryLastTurn,
  signal,
  streaming,
  onEvent,
  ollamaClient,
}: ChatTurnInnerArgs): Promise<ChatTurnResult> {
  if (retryLastTurn && !conversationId) {
    throw new AiChatServiceError("conversationId is required to retry a turn", {
      code: "INVALID_INPUT",
      status: 400,
    });
  }
  const conversation = await ensureConversation({
    conversationId,
    model,
    firstUserMessage: message,
  });
  return withConversationTurnLock(
    conversation.id,
    () =>
      runChatTurnLocked({
        conversation,
        message,
        model,
        useTools,
        preCallTool,
        retryLastTurn,
        signal,
        streaming,
        onEvent,
        ollamaClient,
      }),
    signal,
  );
}

/**
 * Execute a turn while holding the conversation-scoped serialization lock.
 */
async function runChatTurnLocked({
  conversation,
  message,
  model,
  useTools,
  preCallTool,
  retryLastTurn,
  signal,
  streaming,
  onEvent,
  ollamaClient,
}: Omit<ChatTurnInnerArgs, "conversationId"> & {
  conversation: AiConversationRow;
}): Promise<ChatTurnResult> {
  const activeModel =
    model || conversation.model || settings.ollama.defaultModel;

  const history = await aiChatRepository.getMessages(conversation.id);
  let historyBeforeTurn = history;
  let effectiveMessage = message;
  let userMessage: AiMessageRow;

  if (retryLastTurn) {
    const lastUserIndex = history.findLastIndex((row) => row.role === "user");
    const lastUser = history[lastUserIndex];
    if (!lastUser) {
      throw new AiChatServiceError("No user turn is available to retry", {
        code: "TURN_NOT_RETRYABLE",
        status: 409,
      });
    }
    if (
      history.slice(lastUserIndex + 1).some((row) => row.role === "assistant")
    ) {
      throw new AiChatServiceError("The latest turn is already complete", {
        code: "TURN_ALREADY_COMPLETE",
        status: 409,
      });
    }
    userMessage = lastUser;
    // buildChatMessages treats a null and an empty user input alike.
    effectiveMessage = userMessage.content ?? "";
    // Tool rows from an interrupted attempt may trail the user row. Regenerate
    // from the state before that turn so the model neither sees the prompt
    // twice nor consumes an incomplete tool-call sequence.
    historyBeforeTurn = history.slice(0, lastUserIndex);
  } else {
    userMessage = await aiChatRepository.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: message,
    });
    await onEvent?.({
      type: AI_CHAT_STREAM_EVENT.USER_MESSAGE,
      data: { message: userMessage },
    });
  }

  const toolSchemas = useTools ? getToolSchemas() : [];
  const toolNames = useTools ? getToolNames() : [];
  const baseMessages: OllamaMessage[] = buildChatMessages({
    toolNames,
    history: historyBeforeTurn,
    userInput: effectiveMessage,
    maxHistoryMessages: settings.aiChat.maxHistoryMessages,
    contextBudgetChars: settings.aiChat.contextBudgetChars,
    maxToolResultChars: settings.aiChat.maxToolResultChars,
  });
  const ollamaOptions = { num_ctx: settings.ollama.numCtx };

  const toolMessages: AiMessageRow[] = [];
  let iterations = 0;
  let lastUsage: ChatTurnUsage = {
    evalCount: null,
    promptEvalCount: null,
    totalDurationMs: null,
  };

  // Request-scoped cache shared across every tool call in this chat turn so
  // tools that fetch the same heavy investment/transaction sets reuse one query.
  const toolCache: ToolCache = new Map();
  const toolContext = {
    cache: toolCache,
    maxRows: settings.aiChat.maxToolRows,
  };

  // ADR-110 §4: server-side pre-call. Execute the tool BEFORE the model turn
  // and inject its result into context so the model only narrates the
  // already-fetched findings — it never decides whether to fetch. Mirrors the
  // persist/emit/inject sequence the loop performs after a real tool_call.
  // Tool schemas stay enabled for the ensuing turn. A pre-call failure must
  // not kill the turn — log and fall through to the normal loop.
  if (preCallTool) {
    try {
      await onEvent?.({
        type: AI_CHAT_STREAM_EVENT.TOOL_CALL,
        data: { name: preCallTool, args: {} },
      });
      const { args: preCallArgs, result } = await dispatchTool(
        preCallTool,
        {},
        toolContext,
      );
      const toolRow = await aiChatRepository.appendMessage({
        conversationId: conversation.id,
        role: "tool",
        toolName: preCallTool,
        toolArgs: preCallArgs ?? {},
        toolResult: result,
      });
      toolMessages.push(toolRow);
      await onEvent?.({
        type: AI_CHAT_STREAM_EVENT.TOOL_RESULT,
        data: { message: toolRow },
      });

      baseMessages.push({
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: preCallTool, arguments: "{}" } }],
      });
      baseMessages.push({
        role: "tool",
        name: preCallTool,
        content: serializeToolResultForPrompt(
          result,
          settings.aiChat.maxToolResultChars,
        ),
      });
    } catch (err) {
      logger.warn(
        "[aiChat] server-side pre-call failed — continuing turn without injected result",
        {
          conversationId: conversation.id,
          tool: preCallTool,
          code: errorProperty(err, "code"),
          message: errorProperty(err, "message"),
        },
      );
    }
  }

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations += 1;
    const iterStart = Date.now();
    logger.debug("[aiChat] iteration start", {
      conversationId: conversation.id,
      iteration: iterations,
      model: activeModel,
      messageCount: baseMessages.length,
      useTools,
      toolCount: toolSchemas.length,
    });
    let response;
    try {
      if (streaming && typeof ollamaClient.chatStream === "function") {
        response = await ollamaClient.chatStream({
          model: activeModel,
          messages: baseMessages,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          options: ollamaOptions,
          signal,
          onToken: async (delta: string) => {
            if (delta) {
              await onEvent?.({
                type: AI_CHAT_STREAM_EVENT.TOKEN,
                data: delta,
              });
            }
          },
        });
      } else {
        response = await ollamaClient.chat({
          model: activeModel,
          messages: baseMessages,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          options: ollamaOptions,
          signal,
        });
      }
      logger.debug("[aiChat] iteration ollama returned", {
        conversationId: conversation.id,
        iteration: iterations,
        ms: Date.now() - iterStart,
        toolCalls: response.toolCalls?.length ?? 0,
        contentLen: response.content?.length ?? 0,
      });
    } catch (err) {
      logger.warn("[aiChat] iteration ollama failed", {
        conversationId: conversation.id,
        iteration: iterations,
        ms: Date.now() - iterStart,
        code: errorProperty(err, "code"),
        message: errorProperty(err, "message"),
      });
      if (isCodedProviderError(err)) {
        throw new AiChatServiceError(
          `AI provider call failed: ${err.message}`,
          {
            code: err.code || "OLLAMA_ERROR",
            status: err.code === "ABORTED" ? 499 : 502,
            cause: err,
          },
        );
      }
      throw err;
    }

    lastUsage = {
      evalCount: response.evalCount,
      promptEvalCount: response.promptEvalCount,
      totalDurationMs: response.totalDurationMs,
    };

    if (!response.toolCalls || response.toolCalls.length === 0) {
      const assistantMessage = await aiChatRepository.appendMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: response.content || "",
      });
      return {
        conversation,
        userMessage,
        toolMessages,
        assistantMessage,
        usage: lastUsage,
        iterations,
      };
    }

    baseMessages.push({
      role: "assistant",
      content: response.content || "",
      tool_calls: response.toolCalls,
    });

    for (const rawCall of response.toolCalls) {
      const { name, rawArgs } = normalizeToolCall(rawCall);
      if (!name) {
        logger.warn("[aiChat] tool call missing name", { rawCall });
        continue;
      }

      // The tool_call frame fires BEFORE dispatch so a slow tool still shows
      // a "calling tool" progress affordance. It carries rawArgs when the
      // model already emitted a plain object (the common case), else `{}` —
      // the frontend frame schema requires a record and would drop the frame.
      // Fidelity nuance: for string-JSON arguments this frame shows `{}`
      // while the persisted row stores the dispatcher-coerced object.
      await onEvent?.({
        type: AI_CHAT_STREAM_EVENT.TOOL_CALL,
        data: { name, args: isArgsRecord(rawArgs) ? rawArgs : {} },
      });

      // dispatchTool owns argument coercion and reports back what the tool
      // actually saw. The persisted row carries that record: the coerced
      // object on success; on a coercion failure `args` is the raw
      // model-emitted value, persisted verbatim next to the error result.
      const { args, result } = await dispatchTool(name, rawArgs, toolContext);
      const toolRow = await aiChatRepository.appendMessage({
        conversationId: conversation.id,
        role: "tool",
        toolName: name,
        toolArgs: args ?? {},
        toolResult: result,
      });
      toolMessages.push(toolRow);
      await onEvent?.({
        type: AI_CHAT_STREAM_EVENT.TOOL_RESULT,
        data: { message: toolRow },
      });

      baseMessages.push({
        role: "tool",
        name,
        content: serializeToolResultForPrompt(
          result,
          settings.aiChat.maxToolResultChars,
        ),
      });
    }
  }

  logger.warn("[aiChat] tool loop hit iteration cap", {
    conversationId: conversation.id,
    cap: MAX_TOOL_ITERATIONS,
  });
  const fallbackMessage = await aiChatRepository.appendMessage({
    conversationId: conversation.id,
    role: "assistant",
    content:
      "I wasn't able to finish answering — I hit the tool-call iteration limit. Try rephrasing your question.",
    status: "error",
  });
  return {
    conversation,
    userMessage,
    toolMessages,
    assistantMessage: fallbackMessage,
    usage: lastUsage,
    iterations,
  };
}

/**
 * Thin wrappers around the repository for route handlers.
 */
export async function listConversations(page: {
  limit: number;
  offset: number;
}) {
  return aiChatRepository.listConversations(page);
}

/**
 * @param id UUID.
 */
export async function getConversationWithMessages(id: string): Promise<{
  conversation: AiConversationRow;
  messages: AiMessageRow[];
} | null> {
  const conversation = await aiChatRepository.getConversation(id);
  if (!conversation) return null;
  const messages = await aiChatRepository.getMessages(id);
  return { conversation, messages };
}

export async function createEmptyConversation({
  title,
  model,
}: {
  title?: string | null;
  model?: string | null;
}): Promise<{ conversation: AiConversationRow; messages: AiMessageRow[] }> {
  const conversation = await aiChatRepository.createConversation({
    title: truncateTitle(title) || DEFAULT_CONVERSATION_TITLE,
    model: model || settings.ollama.defaultModel,
  });
  return { conversation, messages: [] };
}

/**
 * @param id UUID.
 */
export async function renameConversation(
  id: string,
  title: string,
): Promise<AiConversationRow | null> {
  return aiChatRepository.renameConversation(id, truncateTitle(title));
}

/**
 * @param id UUID.
 */
export async function deleteConversation(id: string): Promise<boolean> {
  return aiChatRepository.deleteConversation(id);
}

export const __constants = Object.freeze({
  MAX_TOOL_ITERATIONS,
  DEFAULT_CONVERSATION_TITLE,
});
