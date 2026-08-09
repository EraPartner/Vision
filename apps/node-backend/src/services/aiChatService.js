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
 * object, else `{}`. The non-streaming path emits `user_message`,
 * `tool_message`, `assistant_message` events only.
 *
 * Tool-call argument coercion lives in exactly one place: `dispatchTool`
 * (services/aiChat/tools/index.js). This module passes the model's raw
 * `function.arguments` through untouched and persists/streams the `args`
 * the dispatcher reports back.
 */

import { logger } from '../config/logger.js';
import settings from '../config/config.js';
import { AppError } from '../middleware/errorHandler.js';
import { aiChatRepository } from '../repositories/aiChatRepository.js';
import { getOllamaClient, OllamaError } from '../integrations/ollama/client.js';
import { buildChatMessages } from '../integrations/ollama/prompts.js';
import { dispatchTool, getToolSchemas, getToolNames } from './aiChat/tools/index.js';

/** @typedef {import('../types/rows.js').AiConversationRow} AiConversationRow */
/** @typedef {import('../types/rows.js').AiMessageRow} AiMessageRow */

/**
 * A message in the array sent to/received from the Ollama `/api/chat`
 * endpoint (see integrations/ollama/prompts.js `toOllamaMessage`). `tool_calls`
 * only appears on an assistant message that invoked a tool; `name` only
 * appears on a `role: 'tool'` result message.
 * @typedef {{ role: string, content: string, tool_calls?: any[], name?: string }} OllamaMessage
 */

const MAX_TOOL_ITERATIONS = 6;
const DEFAULT_CONVERSATION_TITLE = 'New conversation';

export class AiChatServiceError extends AppError {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, cause?: unknown }} [options]
   */
  constructor(message, { code, status, cause } = {}) {
    // Extend AppError so the central error middleware forwards our status/code
    // (e.g. 404/410/503) instead of collapsing to a generic 500. Defaults match
    // the previous plain-Error behaviour.
    super(message, { code: code || 'AI_CHAT_ERROR', status: status || 500, cause });
    this.name = 'AiChatServiceError';
  }
}

/**
 * Extract the tool name and the raw (uncoerced) `function.arguments` value
 * from an Ollama `tool_calls[]` entry. Coercion is deliberately NOT done
 * here — `dispatchTool` is the single coercion point and reports back the
 * args the tool actually saw.
 * @param {any} toolCall raw Ollama `tool_calls[]` entry.
 * @returns {{ name: string|undefined, rawArgs: unknown }}
 */
function normalizeToolCall(toolCall) {
  const fn = toolCall?.function || toolCall || {};
  const name = fn.name || toolCall?.name || undefined;
  const rawArgs = fn.arguments ?? toolCall?.arguments;
  return { name, rawArgs };
}

/**
 * True when `value` is a plain args record — the only shape the SSE
 * `tool_call` frame may carry (the frontend schema is `z.record(...)`).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isArgsRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string|null|undefined} text
 * @param {number} [maxLen]
 * @returns {string}
 */
function truncateTitle(text, maxLen = 60) {
  const trimmed = (text || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return DEFAULT_CONVERSATION_TITLE;
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

/**
 * Ensure a conversation exists. If `conversationId` is provided, validate it;
 * otherwise create a new one titled from the first user message.
 *
 * @param {{ conversationId?: string|null, model?: string|null, firstUserMessage?: string }} args
 * @returns {Promise<AiConversationRow>}
 */
async function ensureConversation({ conversationId, model, firstUserMessage }) {
  if (conversationId) {
    const existing = await aiChatRepository.getConversation(conversationId);
    if (!existing) {
      throw new AiChatServiceError(`Conversation ${conversationId} not found`, {
        code: 'CONVERSATION_NOT_FOUND',
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
        const renamed = await aiChatRepository.renameConversation(conversationId, newTitle);
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
 *
 * @param {object} [args]
 * @param {string|null} [args.conversationId] - existing conversation UUID, or null to create a new one
 * @param {string} [args.message]          - the new user message text
 * @param {string|null} [args.model]          - override the model (else conversation/default)
 * @param {boolean} [args.useTools=true]
 * @param {string|null} [args.preCallTool=null] - tool name to execute
 *   server-side BEFORE the model turn (ADR-110 §4). Its result is injected
 *   into the model's context so the model only narrates the already-fetched
 *   findings instead of deciding whether to call the tool.
 * @param {AbortSignal} [args.signal]    - propagate cancellation
 * @param {boolean} [args.streaming=false] - when true, use `ollamaClient.chatStream`
 *   and emit per-chunk `token` events via `onEvent`.
 * @param {(event: {type: string, data: any}) => void | Promise<void>} [args.onEvent]
 *   Optional hook called for each persisted message, tool call/result,
 *   and (in streaming mode) each content delta. May be async — awaited at each call site.
 * @param {any} [args.ollamaClient]
 *
 * @returns {Promise<{
 *   conversation: object,
 *   userMessage: object,
 *   toolMessages: object[],
 *   assistantMessage: object,
 *   usage: { evalCount: number|null, promptEvalCount: number|null, totalDurationMs: number|null },
 *   iterations: number,
 * }>}
 */
export async function runChatTurn({
  conversationId = null,
  message,
  model = null,
  useTools = true,
  preCallTool = null,
  signal,
  streaming = false,
  onEvent,
  ollamaClient = getOllamaClient(),
} = {}) {
  if (!settings.aiChat.enabled) {
    throw new AiChatServiceError('AI chat is disabled', {
      code: 'AI_CHAT_DISABLED',
      status: 503,
    });
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new AiChatServiceError('message is required', {
      code: 'INVALID_INPUT',
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
    if (err && err.code === 'CONVERSATION_DELETED') {
      logger.info('[aiChat] turn aborted: conversation deleted mid-stream', {
        conversationId: err.conversationId,
      });
      throw new AiChatServiceError(err.message, {
        code: 'CONVERSATION_DELETED',
        status: 410,
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * @param {{ conversationId: any, message: any, model: any, useTools: any, preCallTool: any, signal: any, streaming: any, onEvent: any, ollamaClient: any }} args
 */
async function runChatTurnInner({
  conversationId,
  message,
  model,
  useTools,
  preCallTool,
  signal,
  streaming,
  onEvent,
  ollamaClient,
}) {
  const conversation = await ensureConversation({
    conversationId,
    model,
    firstUserMessage: message,
  });
  const activeModel = model || conversation.model || settings.ollama.defaultModel;

  const history = await aiChatRepository.getMessages(conversation.id);

  const userMessage = await aiChatRepository.appendMessage({
    conversationId: conversation.id,
    role: 'user',
    content: message,
  });
  await onEvent?.({ type: 'user_message', data: userMessage });

  const toolSchemas = useTools ? getToolSchemas() : [];
  const toolNames = useTools ? getToolNames() : [];
  /** @type {OllamaMessage[]} */
  const baseMessages = buildChatMessages({
    toolNames,
    history,
    userInput: message,
    maxHistoryMessages: settings.aiChat.maxHistoryMessages,
  });

  /** @type {AiMessageRow[]} */
  const toolMessages = [];
  let iterations = 0;
  /** @type {{ evalCount: number|null, promptEvalCount: number|null, totalDurationMs: number|null }} */
  let lastUsage = { evalCount: null, promptEvalCount: null, totalDurationMs: null };

  // Request-scoped cache shared across every tool call in this chat turn so
  // tools that fetch the same heavy investment/transaction sets reuse one query.
  const toolCache = new Map();

  // ADR-110 §4: server-side pre-call. Execute the tool BEFORE the model turn
  // and inject its result into context so the model only narrates the
  // already-fetched findings — it never decides whether to fetch. Mirrors the
  // persist/emit/inject sequence the loop performs after a real tool_call.
  // Tool schemas stay enabled for the ensuing turn. A pre-call failure must
  // not kill the turn — log and fall through to the normal loop.
  if (preCallTool) {
    try {
      await onEvent?.({ type: 'tool_call', data: { name: preCallTool, args: {} } });
      const { args: preCallArgs, result } = await dispatchTool(preCallTool, {}, { conversationId: conversation.id, cache: toolCache });
      const toolRow = await aiChatRepository.appendMessage({
        conversationId: conversation.id,
        role: 'tool',
        toolName: preCallTool,
        toolArgs: preCallArgs ?? {},
        toolResult: result,
      });
      toolMessages.push(toolRow);
      await onEvent?.({ type: 'tool_message', data: toolRow });

      baseMessages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: preCallTool, arguments: '{}' } }],
      });
      baseMessages.push({
        role: 'tool',
        name: preCallTool,
        content: JSON.stringify(result),
      });
    } catch (err) {
      logger.warn('[aiChat] server-side pre-call failed — continuing turn without injected result', {
        conversationId: conversation.id,
        tool: preCallTool,
        code: err?.code,
        message: err?.message,
      });
    }
  }

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations += 1;
    const iterStart = Date.now();
    logger.debug('[aiChat] iteration start', {
      conversationId: conversation.id,
      iteration: iterations,
      model: activeModel,
      messageCount: baseMessages.length,
      useTools,
      toolCount: toolSchemas.length,
    });
    let response;
    try {
      if (streaming && typeof ollamaClient.chatStream === 'function') {
        response = await ollamaClient.chatStream({
          model: activeModel,
          messages: baseMessages,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          signal,
          onToken: async (/** @type {string} */ delta) => {
            if (delta) await onEvent?.({ type: 'token', data: delta });
          },
        });
      } else {
        response = await ollamaClient.chat({
          model: activeModel,
          messages: baseMessages,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          signal,
        });
      }
      logger.debug('[aiChat] iteration ollama returned', {
        conversationId: conversation.id,
        iteration: iterations,
        ms: Date.now() - iterStart,
        toolCalls: response.toolCalls?.length ?? 0,
        contentLen: response.content?.length ?? 0,
      });
    } catch (err) {
      logger.warn('[aiChat] iteration ollama failed', {
        conversationId: conversation.id,
        iteration: iterations,
        ms: Date.now() - iterStart,
        code: err?.code,
        message: err?.message,
      });
      if (err instanceof OllamaError) {
        throw new AiChatServiceError(`Ollama call failed: ${err.message}`, {
          code: err.code || 'OLLAMA_ERROR',
          status: err.code === 'ABORTED' ? 499 : 502,
          cause: err,
        });
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
        role: 'assistant',
        content: response.content || '',
      });
      await onEvent?.({ type: 'assistant_message', data: assistantMessage });

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
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.toolCalls,
    });

    for (const rawCall of response.toolCalls) {
      const { name, rawArgs } = normalizeToolCall(rawCall);
      if (!name) {
        logger.warn('[aiChat] tool call missing name', { rawCall });
        continue;
      }

      // The tool_call frame fires BEFORE dispatch so a slow tool still shows
      // a "calling tool" progress affordance. It carries rawArgs when the
      // model already emitted a plain object (the common case), else `{}` —
      // the frontend frame schema requires a record and would drop the frame.
      // Fidelity nuance: for string-JSON arguments this frame shows `{}`
      // while the persisted row stores the dispatcher-coerced object.
      await onEvent?.({ type: 'tool_call', data: { name, args: isArgsRecord(rawArgs) ? rawArgs : {} } });

      // dispatchTool owns argument coercion and reports back what the tool
      // actually saw. The persisted row carries that record: the coerced
      // object on success; on a coercion failure `args` is the raw
      // model-emitted value, persisted verbatim next to the error result.
      const { args, result } = await dispatchTool(name, rawArgs, { conversationId: conversation.id, cache: toolCache });
      const toolRow = await aiChatRepository.appendMessage({
        conversationId: conversation.id,
        role: 'tool',
        toolName: name,
        toolArgs: args ?? {},
        toolResult: result,
      });
      toolMessages.push(toolRow);
      await onEvent?.({ type: 'tool_message', data: toolRow });

      baseMessages.push({
        role: 'tool',
        name,
        content: JSON.stringify(result),
      });
    }
  }

  logger.warn('[aiChat] tool loop hit iteration cap', {
    conversationId: conversation.id,
    cap: MAX_TOOL_ITERATIONS,
  });
  const fallbackMessage = await aiChatRepository.appendMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content:
      'I wasn\'t able to finish answering — I hit the tool-call iteration limit. Try rephrasing your question.',
    status: 'error',
  });
  await onEvent?.({ type: 'assistant_message', data: fallbackMessage });

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
export async function listConversations() {
  return aiChatRepository.listConversations();
}

/**
 * @param {string} id UUID.
 * @returns {Promise<{ conversation: AiConversationRow, messages: AiMessageRow[] }|null>}
 */
export async function getConversationWithMessages(id) {
  const conversation = await aiChatRepository.getConversation(id);
  if (!conversation) return null;
  const messages = await aiChatRepository.getMessages(id);
  return { conversation, messages };
}

/**
 * @param {{ title?: string|null, model?: string|null }} args
 * @returns {Promise<{ conversation: AiConversationRow, messages: AiMessageRow[] }>}
 */
export async function createEmptyConversation({ title, model }) {
  const conversation = await aiChatRepository.createConversation({
    title: truncateTitle(title) || DEFAULT_CONVERSATION_TITLE,
    model: model || settings.ollama.defaultModel,
  });
  return { conversation, messages: [] };
}

/**
 * @param {string} id UUID.
 * @param {string} title
 * @returns {Promise<AiConversationRow|null>}
 */
export async function renameConversation(id, title) {
  return aiChatRepository.renameConversation(id, truncateTitle(title));
}

/**
 * @param {string} id UUID.
 * @returns {Promise<boolean>}
 */
export async function deleteConversation(id) {
  return aiChatRepository.deleteConversation(id);
}

export const __constants = Object.freeze({
  MAX_TOOL_ITERATIONS,
  DEFAULT_CONVERSATION_TITLE,
});
