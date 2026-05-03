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
 * Also emits `tool_call` events before dispatch. The non-streaming path
 * emits `user_message`, `tool_message`, `assistant_message` events only.
 */

import { logger } from '../config/logger.js';
import settings from '../config/config.js';
import { aiChatRepository } from '../repositories/aiChatRepository.js';
import { getOllamaClient, OllamaError } from '../integrations/ollama/client.js';
import { buildChatMessages } from '../integrations/ollama/prompts.js';
import { dispatchTool, getToolSchemas, getToolNames } from './aiChat/tools/index.js';

const MAX_TOOL_ITERATIONS = 6;
const DEFAULT_CONVERSATION_TITLE = 'New conversation';

export class AiChatServiceError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message);
    this.name = 'AiChatServiceError';
    this.code = code || 'AI_CHAT_ERROR';
    this.status = status || 500;
    if (cause) this.cause = cause;
  }
}

function parseToolCallArguments(rawArgs) {
  if (rawArgs == null) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return rawArgs;
    }
  }
  return rawArgs;
}

function normalizeToolCall(toolCall) {
  const fn = toolCall?.function || toolCall || {};
  const name = fn.name || toolCall?.name || null;
  const args = parseToolCallArguments(fn.arguments ?? toolCall?.arguments);
  return { name, args };
}

function truncateTitle(text, maxLen = 60) {
  const trimmed = (text || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return DEFAULT_CONVERSATION_TITLE;
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

/**
 * Ensure a conversation exists. If `conversationId` is provided, validate it;
 * otherwise create a new one titled from the first user message.
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
 * @param {object} args
 * @param {string} [args.conversationId] - existing conversation UUID, or null to create a new one
 * @param {string} args.message          - the new user message text
 * @param {string} [args.model]          - override the model (else conversation/default)
 * @param {AbortSignal} [args.signal]    - propagate cancellation
 * @param {boolean} [args.streaming=false] - when true, use `ollamaClient.chatStream`
 *   and emit per-chunk `token` events via `onEvent`.
 * @param {(event: {type: string, data: any}) => void | Promise<void>} [args.onEvent]
 *   Optional hook called for each persisted message, tool call/result,
 *   and (in streaming mode) each content delta. May be async — awaited at each call site.
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

async function runChatTurnInner({
  conversationId,
  message,
  model,
  useTools,
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
  const baseMessages = buildChatMessages({
    toolNames,
    history,
    userInput: message,
    maxHistoryMessages: settings.aiChat.maxHistoryMessages,
  });

  const toolMessages = [];
  let iterations = 0;
  let lastUsage = { evalCount: null, promptEvalCount: null, totalDurationMs: null };

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
          onToken: async (delta) => {
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
      const { name, args } = normalizeToolCall(rawCall);
      if (!name) {
        logger.warn('[aiChat] tool call missing name', { rawCall });
        continue;
      }

      await onEvent?.({ type: 'tool_call', data: { name, args } });
      const result = await dispatchTool(name, args, { conversationId: conversation.id });
      const toolRow = await aiChatRepository.appendMessage({
        conversationId: conversation.id,
        role: 'tool',
        toolName: name,
        toolArgs: args,
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

export async function getConversationWithMessages(id) {
  const conversation = await aiChatRepository.getConversation(id);
  if (!conversation) return null;
  const messages = await aiChatRepository.getMessages(id);
  return { conversation, messages };
}

export async function createEmptyConversation({ title, model }) {
  const conversation = await aiChatRepository.createConversation({
    title: truncateTitle(title) || DEFAULT_CONVERSATION_TITLE,
    model: model || settings.ollama.defaultModel,
  });
  return { conversation, messages: [] };
}

export async function renameConversation(id, title) {
  return aiChatRepository.renameConversation(id, truncateTitle(title));
}

export async function deleteConversation(id) {
  return aiChatRepository.deleteConversation(id);
}

export const __constants = Object.freeze({
  MAX_TOOL_ITERATIONS,
  DEFAULT_CONVERSATION_TITLE,
});
