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
import { z } from 'zod';

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

/* ── Zod schemas ─────────────────────────────────────────────────────────────
 * schema → safeParse → ValidationError, the idiom from settings.js/reports.js.
 * UUIDs keep the existing case-insensitive UUID_RE (zod's .uuid() is stricter
 * about variant/version bits, and ids are passed through in their original
 * case), so the accepted id set is unchanged. */

// Case-insensitive UUID; any-case input is forwarded unchanged.
const conversationIdSchema = z.string().regex(UUID_RE);

const uuidField = (message) => z.string({ error: message }).regex(UUID_RE, message);

const nonBlankString = (message) => z.string({ error: message })
  .refine((s) => s.trim().length > 0, message);

const chatBodySchema = z.object({
  conversationId: uuidField('"conversationId" must be a UUID').nullish(),
  message: nonBlankString('"message" is required')
    .refine((s) => s.length <= MAX_MESSAGE_LENGTH, `"message" must be <= ${MAX_MESSAGE_LENGTH} chars`),
  model: nonBlankString('"model" must be a non-empty string').nullish(),
  useTools: z.boolean({ error: '"useTools" must be a boolean' }).optional(),
  // ADR-110 §4: when true, the backend executes `insightsDigest` server-side
  // before the model turn so the model only narrates the injected findings.
  insightsPreCall: z.boolean({ error: '"insightsPreCall" must be a boolean' }).optional(),
}).transform((body) => ({
  conversationId: body.conversationId ?? null,
  message: body.message,
  model: body.model ?? null,
  useTools: body.useTools !== false,
  insightsPreCall: body.insightsPreCall === true,
}));

const createConversationSchema = z.object({
  // An empty title is allowed (only type and length are checked); model must
  // be a non-blank string when provided — null is NOT treated as absent here.
  title: z.string({ error: `"title" must be a string up to ${MAX_TITLE_LENGTH} chars` })
    .max(MAX_TITLE_LENGTH, `"title" must be a string up to ${MAX_TITLE_LENGTH} chars`)
    .optional(),
  model: nonBlankString('"model" must be a non-empty string').optional(),
});

const renameConversationSchema = z.object({
  title: nonBlankString('"title" is required')
    .refine((s) => s.length <= MAX_TITLE_LENGTH, `"title" must be <= ${MAX_TITLE_LENGTH} chars`),
});

function parseAiBody(schema, body) {
  const result = schema.safeParse(body || {});
  if (!result.success) {
    const msg = result.error.issues
      .map((issue) => issue.message)
      .join('; ');
    throw new ValidationError(msg);
  }
  return result.data;
}

function requireConversationId(req) {
  const result = conversationIdSchema.safeParse(req.params.id);
  if (!result.success) throw new ValidationError('Invalid conversation id');
  return result.data;
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
//
// Canonical collection shape `{items, total}`; unpaginated, so `total` is the
// row count (present so pagination can land without breaking the shape).
router.get('/models', async (req, res) => {
  const client = getOllamaClient();
  try {
    const models = await client.listModels();
    res.ok({ items: models, total: models.length });
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
//
// Canonical collection shape `{items, total}`; unpaginated, so `total` is the
// row count (present so pagination can land without breaking the shape).
router.get('/conversations', async (req, res) => {
  const rows = await listConversations();
  res.ok({ items: rows, total: rows.length });
});

// POST /api/ai/conversations
router.post('/conversations', async (req, res) => {
  const { title, model } = parseAiBody(createConversationSchema, req.body);

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
  const { title } = parseAiBody(renameConversationSchema, req.body);

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
  const parsed = parseAiBody(chatBodySchema, req.body);

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
      preCallTool: parsed.insightsPreCall ? 'insightsDigest' : null,
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

// POST /api/ai/chat/stream — SSE-streamed chat turn.
//
// Validation throws happen before headers are written, so they travel
// through the global error handler as envelope responses. After headers
// commit, errors ride the SSE `error` frame.
router.post('/chat/stream', async (req, res) => {
  const parsed = parseAiBody(chatBodySchema, req.body);
  logger.info('[ai] chat/stream start', {
    requestId: req.id,
    conversationId: parsed.conversationId,
    model: parsed.model,
    useTools: parsed.useTools,
    messageLen: parsed.message.length,
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
      preCallTool: parsed.insightsPreCall ? 'insightsDigest' : null,
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
