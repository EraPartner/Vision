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
 * All JSON error responses use `{detail: string}` to match the rest of the API.
 */

import { Router } from 'express';

import { logger } from '../config/logger.js';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_TITLE_LENGTH = 200;

function parseConversationId(req) {
  const id = req.params.id;
  if (!id || !UUID_RE.test(id)) {
    return { error: 'Invalid conversation id' };
  }
  return { id };
}

function enforceAiChatEnabled(req, res, next) {
  if (!settings.aiChat.enabled) {
    return res.status(503).json({ detail: 'AI chat is disabled' });
  }
  return next();
}

function mapServiceError(err, res, fallbackDetail) {
  if (err instanceof AiChatServiceError) {
    logger.warn('[ai] service error', { code: err.code, status: err.status, message: err.message });
    return res.status(err.status).json({ detail: err.message, code: err.code });
  }
  logger.error(fallbackDetail, { error: err.message, stack: err.stack });
  return res.status(500).json({ detail: fallbackDetail });
}

const router = Router();
router.use(enforceAiChatEnabled);

// GET /api/ai/status
//
// Response shape is normalized for the frontend:
//   - `ok`         : boolean          — reachable flag
//   - `baseUrl`    : string           — actual URL used by the backend (may be
//                                       `host.docker.internal` when running in a
//                                       container; kept for debugging)
//   - `displayUrl` : string           — user-facing URL, always rewrites
//                                       `host.docker.internal` → `localhost`
//                                       so humans see something they can open
//   - `hint`       : string | null    — actionable guidance when the container
//                                       can't reach the host-side Ollama (the
//                                       most common failure mode)
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
  try {
    const client = getOllamaClient();
    const health = await client.healthCheck();
    res.json({
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
  } catch (err) {
    logger.error('Failed to query Ollama status', { error: err.message });
    res.status(500).json({ detail: 'Failed to query Ollama status' });
  }
});

// GET /api/ai/models
router.get('/models', async (req, res) => {
  try {
    const client = getOllamaClient();
    const models = await client.listModels();
    res.json({ models });
  } catch (err) {
    if (err instanceof OllamaError) {
      logger.warn('[ai] listModels failed', { code: err.code, message: err.message });
      return res.status(502).json({ detail: `Ollama not reachable: ${err.message}`, code: err.code });
    }
    logger.error('Failed to list Ollama models', { error: err.message });
    res.status(500).json({ detail: 'Failed to list Ollama models' });
  }
});

// GET /api/ai/conversations
router.get('/conversations', async (req, res) => {
  try {
    const rows = await listConversations();
    res.json(rows);
  } catch (err) {
    logger.error('Failed to list AI conversations', { error: err.message });
    res.status(500).json({ detail: 'Failed to list AI conversations' });
  }
});

// POST /api/ai/conversations
router.post('/conversations', async (req, res) => {
  try {
    const { title, model } = req.body || {};
    if (title !== undefined && (typeof title !== 'string' || title.length > MAX_TITLE_LENGTH)) {
      return res.status(400).json({ detail: `"title" must be a string up to ${MAX_TITLE_LENGTH} chars` });
    }
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
      return res.status(400).json({ detail: '"model" must be a non-empty string' });
    }

    const conversation = await createEmptyConversation({ title, model });
    res.status(201).json(conversation);
  } catch (err) {
    mapServiceError(err, res, 'Failed to create AI conversation');
  }
});

// GET /api/ai/conversations/:id
router.get('/conversations/:id', async (req, res) => {
  const parsed = parseConversationId(req);
  if (parsed.error) return res.status(400).json({ detail: parsed.error });

  try {
    const convo = await getConversationWithMessages(parsed.id);
    if (!convo) return res.status(404).json({ detail: 'Conversation not found' });
    res.json(convo);
  } catch (err) {
    logger.error('Failed to load AI conversation', { error: err.message, id: parsed.id });
    res.status(500).json({ detail: 'Failed to load AI conversation' });
  }
});

// PATCH /api/ai/conversations/:id
router.patch('/conversations/:id', async (req, res) => {
  const parsed = parseConversationId(req);
  if (parsed.error) return res.status(400).json({ detail: parsed.error });

  const { title } = req.body || {};
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ detail: '"title" is required' });
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return res.status(400).json({ detail: `"title" must be <= ${MAX_TITLE_LENGTH} chars` });
  }

  try {
    const updated = await renameConversation(parsed.id, title);
    if (!updated) return res.status(404).json({ detail: 'Conversation not found' });
    res.json(updated);
  } catch (err) {
    logger.error('Failed to rename AI conversation', { error: err.message, id: parsed.id });
    res.status(500).json({ detail: 'Failed to rename AI conversation' });
  }
});

// DELETE /api/ai/conversations/:id
router.delete('/conversations/:id', async (req, res) => {
  const parsed = parseConversationId(req);
  if (parsed.error) return res.status(400).json({ detail: parsed.error });

  try {
    const deleted = await deleteConversation(parsed.id);
    if (!deleted) return res.status(404).json({ detail: 'Conversation not found' });
    res.status(204).send();
  } catch (err) {
    logger.error('Failed to delete AI conversation', { error: err.message, id: parsed.id });
    res.status(500).json({ detail: 'Failed to delete AI conversation' });
  }
});

// POST /api/ai/chat
router.post('/chat', async (req, res) => {
  const parsed = validateChatBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ detail: parsed.error });
  }

  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const turn = await runChatTurn({
      conversationId: parsed.conversationId,
      message: parsed.message,
      model: parsed.model,
      signal: abortController.signal,
    });
    res.json({
      conversation: turn.conversation,
      userMessage: turn.userMessage,
      toolMessages: turn.toolMessages,
      assistantMessage: turn.assistantMessage,
      usage: turn.usage,
      iterations: turn.iterations,
    });
  } catch (err) {
    mapServiceError(err, res, 'Failed to process AI chat message');
  }
});

function validateChatBody(body) {
  const { conversationId, message, model } = body || {};

  if (conversationId !== undefined && conversationId !== null) {
    if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
      return { error: '"conversationId" must be a UUID' };
    }
  }
  if (typeof message !== 'string' || !message.trim()) {
    return { error: '"message" is required' };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { error: `"message" must be <= ${MAX_MESSAGE_LENGTH} chars` };
  }
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || !model.trim()) {
      return { error: '"model" must be a non-empty string' };
    }
  }
  return {
    conversationId: conversationId || null,
    message,
    model: model || null,
  };
}

// POST /api/ai/chat/stream — SSE-streamed chat turn
router.post('/chat/stream', async (req, res) => {
  const parsed = validateChatBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ detail: parsed.error });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const sendEvent = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const abortController = new AbortController();
  req.on('close', () => {
    closed = true;
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const turn = await runChatTurn({
      conversationId: parsed.conversationId,
      message: parsed.message,
      model: parsed.model,
      signal: abortController.signal,
      streaming: true,
      onEvent: (evt) => {
        if (closed) return;
        switch (evt.type) {
          case 'user_message':
            sendEvent('user_message', { message: evt.data });
            break;
          case 'token':
            sendEvent('token', evt.data);
            break;
          case 'tool_call':
            sendEvent('tool_call', evt.data);
            break;
          case 'tool_message':
            sendEvent('tool_result', { message: evt.data });
            break;
          case 'assistant_message':
            // terminal `done` event is emitted after runChatTurn resolves
            break;
          default:
            break;
        }
      },
    });

    if (!closed) {
      sendEvent('done', {
        conversation: turn.conversation,
        assistantMessage: turn.assistantMessage,
        usage: turn.usage,
        iterations: turn.iterations,
      });
      res.end();
    }
  } catch (err) {
    if (closed) return;
    if (err instanceof AiChatServiceError) {
      logger.warn('[ai] stream service error', { code: err.code, status: err.status, message: err.message });
      sendEvent('error', { detail: err.message, code: err.code });
    } else {
      logger.error('Failed to stream AI chat message', { error: err.message, stack: err.stack });
      sendEvent('error', { detail: 'Failed to stream AI chat message' });
    }
    res.end();
  }
});

export default router;
