/**
 * AI chat routes.
 *
 * Mounted at /api/ai by main.js.
 *
 *   GET    /api/ai/status                   — Ollama reachability + baseUrl
 *   GET    /api/ai/models                   — installed models (pass-through)
 *   GET    /api/ai/conversations            — list (newest first)
 *   POST   /api/ai/conversations            — create empty (optional title/model)
 *   GET    /api/ai/conversations/:id        — conversation + messages
 *   PATCH  /api/ai/conversations/:id        — rename
 *   DELETE /api/ai/conversations/:id        — delete (cascades messages)
 *   POST   /api/ai/chat                     — send message, run tool loop, return turn (JSON)
 *   POST   /api/ai/chat/stream              — same, but streams SSE events
 *
 * SSE events on /chat/stream:
 *   - user_message       {message}         — user row persisted
 *   - token              "delta"           — content chunk (assistant text streaming)
 *   - tool_call          {name, args}      — model requested a tool (before dispatch)
 *   - tool_result        {message}         — tool row persisted (result in .tool_result)
 *   - done               {assistantMessage, usage, iterations, conversation}
 *   - error              {detail, code?}
 *
 * JSON responses use the unified envelope (ADR-026). The SSE stream keeps
 * the raw event protocol — headers are committed before the first handler
 * error can fire, so errors ride the `error` SSE frame instead.
 */

import { Router } from 'express';

import { logger } from '../config/logger.js';
import { createSseWriter } from '../lib/sse.js';
import settings from '../config/config.js';
import { getOllamaClient, OllamaError } from '../integrations/ollama/client.js';
import {
  AiChatServiceError,
  createEmptyConversation,
  deleteConversation,
  getConversationWithMessages,
  listConversations,
  renameConversation,
  runChatTurn,
} from '../services/aiChatService.js';
import { ApiErrorCode } from '@vision/types/errors';
import {
  AppError,
  NotFoundError,
  ValidationError,
} from '../middleware/errorHandler.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_TITLE_LENGTH = 200;

function requireConversationId(req) {
  const id = req.params.id;
  if (!id || !UUID_RE.test(id)) {
    throw new ValidationError('Invalid conversation id');
  }
  return id;
}

function enforceAiChatEnabled(req, res, next) {
  if (!settings.aiChat.enabled) {
    return next(new AppError('AI chat is disabled', {
      status: 503,
      code: ApiErrorCode.SERVICE_UNAVAILABLE,
    }));
  }
  return next();
}

/**
 * Convert a service-layer error into a typed AppError. Preserves the
 * AiChatServiceError status + code so the envelope surfaces them unchanged.
 */
function rethrowAsAppError(err, fallbackMessage) {
  if (err instanceof AiChatServiceError) {
    throw new AppError(err.message, {
      status: err.status,
      code: err.code,
      cause: err,
    });
  }
  throw new AppError(fallbackMessage, {
    status: 500,
    code: ApiErrorCode.INTERNAL_SERVER_ERROR,
    cause: err,
  });
}

const router = Router();
router.use(enforceAiChatEnabled);

// GET /api/ai/status
//
// Normalized for the frontend:
//   - `ok`         : boolean          — reachable flag
//   - `baseUrl`    : string           — actual URL used by the backend
//   - `displayUrl` : string           — rewrites `host.docker.internal` → `localhost`
//   - `hint`       : string | null    — guidance when the container can't reach host-side Ollama
//
// The health probe never throws — it returns `{reachable: false, error, code}`
// on failure — so this endpoint always emits a success envelope.
function toDisplayUrl(baseUrl) {
  if (!baseUrl) return baseUrl;
  return baseUrl.replace('host.docker.internal', 'localhost');
}

function buildConnectionHint(health) {
  if (health.reachable) return null;
  const usesContainerGateway = typeof health.baseUrl === 'string'
    && health.baseUrl.includes('host.docker.internal');
  if (!usesContainerGateway) return null;
  // Backend is containerized and tried the host gateway. The overwhelmingly
  // common cause of a NETWORK_ERROR here is that the user's Ollama binds to
  // 127.0.0.1 only — the host gateway IP the container uses is not loopback,
  // so Ollama rejects it. Point them at the fix.
  if (health.code === 'NETWORK_ERROR' || health.code === 'TIMEOUT') {
    return 'Ollama is running but only accepts connections from 127.0.0.1. '
      + 'Restart it with OLLAMA_HOST=0.0.0.0 (macOS: quit Ollama, then in a '
      + 'terminal run `OLLAMA_HOST=0.0.0.0 ollama serve`) so the Docker '
      + 'container can reach it.';
  }
  return null;
}

router.get('/status', async (req, res) => {
  const client = getOllamaClient();
  const health = await client.healthCheck();
  res.ok({
    ok: Boolean(health.reachable),
    baseUrl: health.baseUrl,
    displayUrl: toDisplayUrl(health.baseUrl),
    modelCount: health.modelCount ?? 0,
    error: health.error ?? null,
    code: health.code ?? null,
    hint: buildConnectionHint(health),
    defaultModel: settings.ollama.defaultModel,
    enabled: settings.aiChat.enabled,
  });
});

// GET /api/ai/models
router.get('/models', async (req, res) => {
  const client = getOllamaClient();
  try {
    const models = await client.listModels();
    res.ok({ models });
  } catch (err) {
    if (err instanceof OllamaError) {
      throw new AppError(`Ollama not reachable: ${err.message}`, {
        status: 502,
        code: ApiErrorCode.BAD_GATEWAY,
        details: { ollamaCode: err.code },
        cause: err,
      });
    }
    throw err;
  }
});

// GET /api/ai/conversations
router.get('/conversations', async (req, res) => {
  const rows = await listConversations();
  res.ok(rows);
});

// POST /api/ai/conversations
router.post('/conversations', async (req, res) => {
  const { title, model } = req.body || {};
  if (title !== undefined && (typeof title !== 'string' || title.length > MAX_TITLE_LENGTH)) {
    throw new ValidationError(`"title" must be a string up to ${MAX_TITLE_LENGTH} chars`);
  }
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
    throw new ValidationError('"model" must be a non-empty string');
  }

  try {
    const conversation = await createEmptyConversation({ title, model });
    res.status(201);
    res.ok(conversation);
  } catch (err) {
    rethrowAsAppError(err, 'Failed to create AI conversation');
  }
});

// GET /api/ai/conversations/:id
router.get('/conversations/:id', async (req, res) => {
  const id = requireConversationId(req);
  const convo = await getConversationWithMessages(id);
  if (!convo) throw new NotFoundError('Conversation not found');
  res.ok(convo);
});

// PATCH /api/ai/conversations/:id
router.patch('/conversations/:id', async (req, res) => {
  const id = requireConversationId(req);
  const { title } = req.body || {};
  if (typeof title !== 'string' || !title.trim()) {
    throw new ValidationError('"title" is required');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`"title" must be <= ${MAX_TITLE_LENGTH} chars`);
  }

  const updated = await renameConversation(id, title);
  if (!updated) throw new NotFoundError('Conversation not found');
  res.ok(updated);
});

// DELETE /api/ai/conversations/:id
router.delete('/conversations/:id', async (req, res) => {
  const id = requireConversationId(req);
  const deleted = await deleteConversation(id);
  if (!deleted) throw new NotFoundError('Conversation not found');
  res.status(204).send();
});

// POST /api/ai/chat
router.post('/chat', async (req, res) => {
  const parsed = validateChatBody(req.body);

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const turn = await runChatTurn({
      conversationId: parsed.conversationId,
      message: parsed.message,
      model: parsed.model,
      useTools: parsed.useTools,
      signal: abortController.signal,
    });
    res.ok({
      conversation: turn.conversation,
      userMessage: turn.userMessage,
      toolMessages: turn.toolMessages,
      assistantMessage: turn.assistantMessage,
      usage: turn.usage,
      iterations: turn.iterations,
    });
  } catch (err) {
    rethrowAsAppError(err, 'Failed to process AI chat message');
  }
});

function validateChatBody(body) {
  const { conversationId, message, model, useTools } = body || {};

  if (conversationId !== undefined && conversationId !== null) {
    if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
      throw new ValidationError('"conversationId" must be a UUID');
    }
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new ValidationError('"message" is required');
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`"message" must be <= ${MAX_MESSAGE_LENGTH} chars`);
  }
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || !model.trim()) {
      throw new ValidationError('"model" must be a non-empty string');
    }
  }
  if (useTools !== undefined && typeof useTools !== 'boolean') {
    throw new ValidationError('"useTools" must be a boolean');
  }
  return {
    conversationId: conversationId || null,
    message,
    model: model || null,
    useTools: useTools !== false,
  };
}

// POST /api/ai/chat/stream — SSE-streamed chat turn.
//
// Validation throws happen before headers are written, so they travel
// through the global error handler as envelope responses. After headers
// commit, errors ride the SSE `error` frame.
router.post('/chat/stream', async (req, res) => {
  const parsed = validateChatBody(req.body);
  logger.info('[ai] chat/stream start', {
    requestId: req.id,
    conversationId: parsed.conversationId,
    model: parsed.model,
    useTools: parsed.useTools,
    messageLen: parsed.message.length,
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const writer = createSseWriter(req, res);
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const turn = await runChatTurn({
      conversationId: parsed.conversationId,
      message: parsed.message,
      model: parsed.model,
      useTools: parsed.useTools,
      signal: abortController.signal,
      streaming: true,
      onEvent: async (evt) => {
        switch (evt.type) {
          case 'user_message':
            await writer.write('user_message', { message: evt.data });
            break;
          case 'token':
            await writer.write('token', evt.data);
            break;
          case 'tool_call':
            await writer.write('tool_call', evt.data);
            break;
          case 'tool_message':
            await writer.write('tool_result', { message: evt.data });
            break;
          case 'assistant_message':
            // terminal `done` event is emitted after runChatTurn resolves
            break;
          default:
            break;
        }
      },
    });

    if (!writer.closed) {
      await writer.write('done', {
        conversation: turn.conversation,
        assistantMessage: turn.assistantMessage,
        usage: turn.usage,
        iterations: turn.iterations,
      });
      writer.end();
    }
  } catch (err) {
    if (writer.closed) return;
    if (err instanceof AiChatServiceError) {
      logger.warn('[ai] stream service error', { code: err.code, status: err.status, message: err.message });
      await writer.write('error', { detail: err.message, code: err.code });
    } else {
      logger.error('Failed to stream AI chat message', { error: err.message, stack: err.stack });
      await writer.write('error', { detail: 'Failed to stream AI chat message' });
    }
    writer.end();
  }
});

export default router;
