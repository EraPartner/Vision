/**
 * AI chat route tests.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js). `router.use(enforceAiChatEnabled)` (ai.js:~120)
 * was never reachable under the old mock-router harness — `router.use()` was
 * recorded but never invoked, so `/chat` and `/chat/stream` validation errors
 * were being asserted as rejected promises from a handler called directly,
 * bypassing Express entirely. They now travel through the real error handler
 * and come back as ADR-026 envelopes.
 *
 * SSE stream ('/chat/stream'): the harness's real HTTP server means
 * `res.writeHead`/`res.write`/`res.end` are the genuine Node response methods,
 * not stubs. supertest buffers a `text/event-stream` body (matches its
 * `text/*` buffering rule) into `res.text`, so SSE frames are asserted by
 * parsing that raw string instead of inspecting `res.write.mock.calls`.
 *
 * Per the routeApp.js fidelity map, the app-level `/api/ai/chat` rate limiter
 * (main.js:342-348, only mounted when `settings.aiChat.enabled`) is a
 * module-scoped per-IP counter and is deliberately NOT reproduced here — it
 * would 429 this suite's own many `/chat` requests. It is a real gap this
 * suite cannot see; not exercised in either the old or new harness.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, okEnvelope, errEnvelope } from '../helpers/routeApp.js';

vi.mock('../../src/services/aiChatService.js', async () => {
  // Mirror the real class's hierarchy: AiChatServiceError extends AppError, so
  // the route's `err instanceof AppError` passthrough (no translation shim)
  // behaves the same here as against the real service module.
  const { AppError } = await import('../../src/middleware/errorHandler.js');
  class AiChatServiceError extends AppError {
    constructor(message, { code, status, cause } = {}) {
      super(message, { code: code || 'AI_CHAT_ERROR', status: status || 500, cause });
      this.name = 'AiChatServiceError';
    }
  }
  return {
    AiChatServiceError,
    createEmptyConversation: vi.fn(),
    deleteConversation: vi.fn(),
    getConversationWithMessages: vi.fn(),
    listConversations: vi.fn(),
    renameConversation: vi.fn(),
    runChatTurn: vi.fn(),
  };
});

vi.mock('../../src/integrations/ollama/client.js', () => {
  class OllamaError extends Error {
    constructor(message, { code } = {}) {
      super(message);
      this.code = code || 'OLLAMA_ERROR';
    }
  }
  return {
    OllamaError,
    getOllamaClient: vi.fn(() => ({
      healthCheck: vi.fn(),
      listModels: vi.fn(),
    })),
  };
});

vi.mock('../../src/config/config.js', () => ({
  default: {
    aiChat: { enabled: true, maxHistoryMessages: 20 },
    ollama: { defaultModel: 'llama3.2:3b', baseUrl: 'http://localhost:11434' },
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import {
  AiChatServiceError,
  createEmptyConversation,
  deleteConversation,
  getConversationWithMessages,
  listConversations,
  renameConversation,
  runChatTurn,
} from '../../src/services/aiChatService.js';
import settings from '../../src/config/config.js';

const { default: aiRouter } = await import('../../src/routes/ai.js');

const api = routeAgent(aiRouter, { mountPath: '/api/ai' });
const BASE = '/api/ai';

const UUID = '11111111-2222-4333-8444-555555555555';

/**
 * Split a buffered `text/event-stream` body into `{ name, data }` frames,
 * skipping the leading padding comment (a `:`-prefixed line, ignored by the
 * SSE spec — used to flush the browser's buffering threshold) and any
 * heartbeat comments.
 */
function parseSseFrames(rawText) {
  return rawText
    .split('\n\n')
    .filter((frame) => frame.startsWith('event:'))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split('\n');
      return {
        name: eventLine.replace(/^event: /, ''),
        data: JSON.parse(dataLine.replace(/^data: /, '')),
      };
    });
}

// ──────────────────────────────────────────
// POST /chat/stream (SSE)
// ──────────────────────────────────────────
describe('POST /api/ai/chat/stream', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers a 400 VALIDATION_ERROR envelope when message missing (before SSE headers)', async () => {
    const res = await api.post(`${BASE}/chat/stream`).send({ conversationId: UUID }).expect(400);

    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    expect(res.headers['content-type']).toMatch(/json/);
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it('answers a 400 VALIDATION_ERROR envelope when conversationId is not a UUID', async () => {
    const res = await api.post(`${BASE}/chat/stream`).send({ conversationId: 'not-a-uuid', message: 'hi' }).expect(400);

    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('answers a 400 VALIDATION_ERROR envelope when message exceeds max length', async () => {
    const res = await api.post(`${BASE}/chat/stream`).send({ message: 'x'.repeat(8001) }).expect(400);

    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('streams SSE events in order: user_message → token → tool_call → tool_result → done', async () => {
    const userMsg = { id: 'u1', role: 'user', content: 'hi' };
    const toolMsg = { id: 't1', role: 'tool', tool_name: 'getSpendByCategory', tool_result: { ok: true } };
    const assistantMsg = { id: 'a1', role: 'assistant', content: 'Your top category was food.' };
    const conversation = { id: UUID, title: 'hi', model: 'llama3.2:3b' };

    runChatTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'user_message', data: userMsg });
      onEvent({ type: 'token', data: 'Your ' });
      onEvent({ type: 'token', data: 'top ' });
      onEvent({ type: 'token', data: 'category.' });
      onEvent({ type: 'tool_call', data: { name: 'getSpendByCategory', args: { from: '2025-01-01', to: '2025-12-31' } } });
      onEvent({ type: 'tool_message', data: toolMsg });
      onEvent({ type: 'assistant_message', data: assistantMsg });
      return {
        conversation,
        userMessage: userMsg,
        toolMessages: [toolMsg],
        assistantMessage: assistantMsg,
        usage: { evalCount: 10, promptEvalCount: 5, totalDurationMs: 120 },
        iterations: 2,
      };
    });

    const res = await api.post(`${BASE}/chat/stream`).send({ message: 'hi', conversationId: UUID }).expect(200);

    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.connection).toBe('keep-alive');
    expect(res.headers['x-accel-buffering']).toBe('no');

    const frames = parseSseFrames(res.text);
    const eventNames = frames.map((f) => f.name);
    expect(eventNames).toEqual([
      'user_message',
      'token',
      'token',
      'token',
      'tool_call',
      'tool_result',
      'done',
    ]);

    expect(frames[0].data).toEqual({ message: userMsg });
    expect(frames[1].data).toBe('Your ');

    expect(frames[4].data.name).toBe('getSpendByCategory');
    expect(frames[4].data.args.from).toBe('2025-01-01');

    expect(frames[5].data).toEqual({ message: toolMsg });

    const donePayload = frames[6].data;
    expect(donePayload.conversation).toEqual(conversation);
    expect(donePayload.assistantMessage).toEqual(assistantMsg);
    expect(donePayload.usage.evalCount).toBe(10);
    expect(donePayload.iterations).toBe(2);
  });

  it('passes AbortSignal to runChatTurn and streams with streaming:true', async () => {
    runChatTurn.mockResolvedValue({
      conversation: { id: UUID },
      userMessage: { id: 'u1' },
      toolMessages: [],
      assistantMessage: { id: 'a1', content: 'ok' },
      usage: {},
      iterations: 1,
    });

    await api.post(`${BASE}/chat/stream`).send({ message: 'hi' }).expect(200);

    expect(runChatTurn).toHaveBeenCalledTimes(1);
    const callArgs = runChatTurn.mock.calls[0][0];
    expect(callArgs.streaming).toBe(true);
    expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    expect(typeof callArgs.onEvent).toBe('function');
    expect(callArgs.message).toBe('hi');
  });

  it('emits error SSE event on AiChatServiceError and ends response', async () => {
    runChatTurn.mockRejectedValue(new AiChatServiceError('Model unavailable', {
      code: 'OLLAMA_UNREACHABLE',
      status: 503,
    }));

    const res = await api.post(`${BASE}/chat/stream`).send({ message: 'hi' }).expect(200);

    const frames = parseSseFrames(res.text);
    const errFrame = frames.find((f) => f.name === 'error');
    expect(errFrame.data).toEqual({ detail: 'Model unavailable', code: 'OLLAMA_UNREACHABLE' });
    expect(frames.some((f) => f.name === 'done')).toBe(false);
  });

  it('emits generic error SSE event on unexpected failure', async () => {
    runChatTurn.mockRejectedValue(new Error('db exploded'));

    const res = await api.post(`${BASE}/chat/stream`).send({ message: 'hi' }).expect(200);

    const frames = parseSseFrames(res.text);
    const errFrame = frames.find((f) => f.name === 'error');
    expect(errFrame).toBeDefined();
    expect(errFrame.data).toEqual({ detail: 'Failed to stream AI chat message' });
    expect(JSON.stringify(errFrame.data)).not.toContain('db exploded');
  });

  it('aborts runChatTurn and stops writing on client disconnect', async () => {
    let capturedSignal;
    let releaseTurn;
    const released = new Promise((resolve) => { releaseTurn = resolve; });

    runChatTurn.mockImplementation(async ({ signal, onEvent }) => {
      capturedSignal = signal;
      onEvent({ type: 'user_message', data: { id: 'u1' } });
      onEvent({ type: 'token', data: 'hello' });
      // Stay pending until the client abort has actually landed server-side
      // (mirrors production, where the abort can race the in-flight tool loop)
      // rather than resolving before res 'close' has had a chance to fire.
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      releaseTurn();
      return {
        conversation: { id: UUID },
        userMessage: { id: 'u1' },
        toolMessages: [],
        assistantMessage: { id: 'a1', content: 'hello' },
        usage: {},
        iterations: 1,
      };
    });

    const test = api.post(`${BASE}/chat/stream`).send({ message: 'hi' });
    test.end(() => {}); // fire-and-forget: an aborted request rejects, and we assert server-side state instead
    // Give the request time to reach the handler and commit the SSE headers.
    await new Promise((resolve) => setTimeout(resolve, 30));
    test.abort();

    await released;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('skips writes for unknown onEvent types', async () => {
    runChatTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'unknown_event', data: { foo: 'bar' } });
      onEvent({ type: 'assistant_message', data: { id: 'a1' } });
      return {
        conversation: { id: UUID },
        userMessage: { id: 'u1' },
        toolMessages: [],
        assistantMessage: { id: 'a1', content: 'ok' },
        usage: {},
        iterations: 1,
      };
    });

    const res = await api.post(`${BASE}/chat/stream`).send({ message: 'hi' }).expect(200);

    const eventNames = parseSseFrames(res.text).map((f) => f.name);
    expect(eventNames).not.toContain('unknown_event');
    expect(eventNames).not.toContain('assistant_message');
    expect(eventNames).toContain('done');
  });
});

// ──────────────────────────────────────────
// POST /chat (non-streaming) — smoke test for shared validator
// ──────────────────────────────────────────
describe('POST /api/ai/chat', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers a 400 VALIDATION_ERROR envelope when message missing', async () => {
    const res = await api.post(`${BASE}/chat`).send({}).expect(400);

    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it('answers a 400 VALIDATION_ERROR envelope when model is an empty string', async () => {
    const res = await api.post(`${BASE}/chat`).send({ message: 'hi', model: '  ' }).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
  });

  it('returns 200 with turn payload on success', async () => {
    const turn = {
      conversation: { id: UUID, title: 'hi' },
      userMessage: { id: 'u1', content: 'hi' },
      toolMessages: [{ id: 't1' }],
      assistantMessage: { id: 'a1', content: 'hello' },
      usage: { evalCount: 5 },
      iterations: 1,
    };
    runChatTurn.mockResolvedValue(turn);

    const res = await api.post(`${BASE}/chat`).send({ message: 'hi' }).expect(200);

    expect(runChatTurn).toHaveBeenCalledTimes(1);
    const callArgs = runChatTurn.mock.calls[0][0];
    expect(callArgs.streaming).toBeUndefined();
    expect(callArgs.message).toBe('hi');
    expect(res.body).toEqual(okEnvelope({
      conversation: turn.conversation,
      userMessage: turn.userMessage,
      toolMessages: turn.toolMessages,
      assistantMessage: turn.assistantMessage,
      usage: turn.usage,
      iterations: turn.iterations,
    }));
  });

  it('answers with the AiChatServiceError status/code when the service rejects', async () => {
    runChatTurn.mockRejectedValue(new AiChatServiceError('bad', { code: 'INVALID_INPUT', status: 400 }));

    const res = await api.post(`${BASE}/chat`).send({ message: 'hi' }).expect(400);
    // Exact wire shape the deleted per-route translation shim used to produce:
    // { ok: false, error: { code, message } , meta } — no details key.
    expect(res.body).toEqual(errEnvelope({ code: 'INVALID_INPUT', message: 'bad' }));
  });

  it('passes a 5xx AiChatServiceError through the generic handler untranslated (same wire shape as the old shim)', async () => {
    runChatTurn.mockRejectedValue(new AiChatServiceError('Ollama call failed: connect ECONNREFUSED', {
      code: 'OLLAMA_ERROR',
      status: 502,
    }));

    const res = await api.post(`${BASE}/chat`).send({ message: 'hi' }).expect(502);
    // Dev-mode harness (isProduction: false), so the 5xx message is verbatim —
    // exactly what the old `new AppError(err.message, { status, code })` re-wrap produced.
    expect(res.body).toEqual(errEnvelope({ code: 'OLLAMA_ERROR', message: 'Ollama call failed: connect ECONNREFUSED' }));
  });

  it('answers a sanitized 500 on a generic service error', async () => {
    runChatTurn.mockRejectedValue(new Error('internal'));

    const res = await api.post(`${BASE}/chat`).send({ message: 'hi' }).expect(500);
    expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to process AI chat message' }));
  });
});

// ──────────────────────────────────────────
// Newly on-path: enforceAiChatEnabled (router.use, never reachable under the
// old mock-router harness — `router.use()` calls were recorded but never
// invoked).
// ──────────────────────────────────────────
describe('AI chat disabled gate (router.use(enforceAiChatEnabled))', () => {
  const originalEnabled = settings.aiChat.enabled;

  afterEach(() => {
    settings.aiChat.enabled = originalEnabled;
  });

  it('answers 503 SERVICE_UNAVAILABLE for any /api/ai/* route when disabled', async () => {
    settings.aiChat.enabled = false;

    const res = await api.get(`${BASE}/status`).expect(503);
    expect(res.body).toEqual(errEnvelope({ code: 'SERVICE_UNAVAILABLE', message: 'AI chat is disabled' }));
  });
});

// ──────────────────────────────────────────
// validateChatBody pins (exact accept/reject + coercion semantics)
// ──────────────────────────────────────────
describe('POST /api/ai/chat body validation', () => {
  beforeEach(() => vi.clearAllMocks());

  const okTurn = {
    conversation: { id: UUID }, userMessage: { id: 'u1' }, toolMessages: [],
    assistantMessage: { id: 'a1' }, usage: {}, iterations: 1,
  };

  it('accepts an UPPERCASE conversation UUID (regex is case-insensitive) and forwards it unchanged', async () => {
    runChatTurn.mockResolvedValue(okTurn);
    const upper = UUID.toUpperCase();

    await api.post(`${BASE}/chat`).send({ message: 'hi', conversationId: upper }).expect(200);

    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ conversationId: upper }));
  });

  it('maps a null conversationId to null (new conversation)', async () => {
    runChatTurn.mockResolvedValue(okTurn);

    await api.post(`${BASE}/chat`).send({ message: 'hi', conversationId: null }).expect(200);

    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ conversationId: null }));
  });

  it('rejects a non-string conversationId', async () => {
    const res = await api.post(`${BASE}/chat`).send({ message: 'hi', conversationId: 42 }).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it('accepts a message of exactly 4000 chars and rejects 4001', async () => {
    runChatTurn.mockResolvedValue(okTurn);

    await api.post(`${BASE}/chat`).send({ message: 'x'.repeat(4000) }).expect(200);
    expect(runChatTurn).toHaveBeenCalledTimes(1);

    await api.post(`${BASE}/chat`).send({ message: 'x'.repeat(4001) }).expect(400);
  });

  it('rejects a whitespace-only message', async () => {
    await api.post(`${BASE}/chat`).send({ message: '   ' }).expect(400);
  });

  it('rejects a non-string message', async () => {
    await api.post(`${BASE}/chat`).send({ message: 123 }).expect(400);
  });

  it('maps a null model to null and rejects a non-string model', async () => {
    runChatTurn.mockResolvedValue(okTurn);

    await api.post(`${BASE}/chat`).send({ message: 'hi', model: null }).expect(200);
    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ model: null }));

    await api.post(`${BASE}/chat`).send({ message: 'hi', model: 7 }).expect(400);
  });

  it('defaults useTools to true when omitted and honours an explicit false', async () => {
    runChatTurn.mockResolvedValue(okTurn);

    await api.post(`${BASE}/chat`).send({ message: 'hi' }).expect(200);
    expect(runChatTurn).toHaveBeenLastCalledWith(expect.objectContaining({ useTools: true }));

    await api.post(`${BASE}/chat`).send({ message: 'hi', useTools: false }).expect(200);
    expect(runChatTurn).toHaveBeenLastCalledWith(expect.objectContaining({ useTools: false }));
  });

  it('rejects a non-boolean useTools', async () => {
    await api.post(`${BASE}/chat`).send({ message: 'hi', useTools: 'yes' }).expect(400);
  });
});

// ──────────────────────────────────────────
// Conversation CRUD validation pins
// ──────────────────────────────────────────
describe('AI conversation routes validation', () => {
  beforeEach(() => vi.clearAllMocks());

  // Used to answer with a bare array as `data`; now the canonical `{ items,
  // total }` collection body (unpaginated, so `total` is the row count).
  describe('GET /conversations', () => {
    it('returns { items, total }', async () => {
      const rows = [{ id: UUID, title: 'One' }, { id: UUID, title: 'Two' }];
      listConversations.mockResolvedValue(rows);

      const res = await api.get(`${BASE}/conversations`).expect(200);
      expect(res.body).toEqual(okEnvelope({ items: rows, total: 2 }));
    });

    it('reports total 0 for an empty list', async () => {
      listConversations.mockResolvedValue([]);

      const res = await api.get(`${BASE}/conversations`).expect(200);
      expect(res.body).toEqual(okEnvelope({ items: [], total: 0 }));
    });
  });

  describe('POST /conversations', () => {
    it('creates with optional title/model absent (even without a body)', async () => {
      createEmptyConversation.mockResolvedValue({ id: UUID });

      await api.post(`${BASE}/conversations`).expect(201);

      expect(createEmptyConversation).toHaveBeenCalledWith({ title: undefined, model: undefined });
    });

    it('accepts an empty-string title (only type and length are checked)', async () => {
      createEmptyConversation.mockResolvedValue({ id: UUID });

      await api.post(`${BASE}/conversations`).send({ title: '' }).expect(201);

      expect(createEmptyConversation).toHaveBeenCalledWith({ title: '', model: undefined });
    });

    it('accepts a title of exactly 200 chars and rejects 201', async () => {
      createEmptyConversation.mockResolvedValue({ id: UUID });

      await api.post(`${BASE}/conversations`).send({ title: 't'.repeat(200) }).expect(201);
      expect(createEmptyConversation).toHaveBeenCalledTimes(1);

      await api.post(`${BASE}/conversations`).send({ title: 't'.repeat(201) }).expect(400);
    });

    it('rejects a non-string title', async () => {
      const res = await api.post(`${BASE}/conversations`).send({ title: 5 }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(createEmptyConversation).not.toHaveBeenCalled();
    });

    it('rejects a blank or null model (null is NOT treated as absent here)', async () => {
      await api.post(`${BASE}/conversations`).send({ model: '  ' }).expect(400);
      await api.post(`${BASE}/conversations`).send({ model: null }).expect(400);
    });
  });

  describe('PATCH /conversations/:id', () => {
    it('renames with the exact (untrimmed) title', async () => {
      renameConversation.mockResolvedValue({ id: UUID, title: ' Hi ' });

      await api.patch(`${BASE}/conversations/${UUID}`).send({ title: ' Hi ' }).expect(200);

      expect(renameConversation).toHaveBeenCalledWith(UUID, ' Hi ');
    });

    it('rejects a missing, blank, or non-string title', async () => {
      for (const body of [{}, { title: '   ' }, { title: 9 }]) {
        await api.patch(`${BASE}/conversations/${UUID}`).send(body).expect(400);
      }
      expect(renameConversation).not.toHaveBeenCalled();
    });

    it('accepts a title of exactly 200 chars and rejects 201', async () => {
      renameConversation.mockResolvedValue({ id: UUID });

      await api.patch(`${BASE}/conversations/${UUID}`).send({ title: 't'.repeat(200) }).expect(200);
      expect(renameConversation).toHaveBeenCalledTimes(1);

      await api.patch(`${BASE}/conversations/${UUID}`).send({ title: 't'.repeat(201) }).expect(400);
    });

    it('rejects a malformed conversation id', async () => {
      await api.patch(`${BASE}/conversations/nope`).send({ title: 'x' }).expect(400);
    });
  });

  describe('GET/DELETE /conversations/:id', () => {
    it('accepts an uppercase UUID id and passes it through unchanged', async () => {
      const upper = UUID.toUpperCase();
      getConversationWithMessages.mockResolvedValue({ id: upper, messages: [] });

      await api.get(`${BASE}/conversations/${upper}`).expect(200);

      expect(getConversationWithMessages).toHaveBeenCalledWith(upper);
    });

    it('rejects a missing or malformed id', async () => {
      await api.get(`${BASE}/conversations/123`).expect(400);

      const res = await api.delete(`${BASE}/conversations/123`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(deleteConversation).not.toHaveBeenCalled();
    });

    // The original suite asserted this branch by calling the handler directly
    // with a hand-built `{ params: { id: '' } }` — a request Express can never
    // actually construct: `/conversations/` with no verb defined for the bare
    // collection path other than GET/POST simply doesn't route to the
    // GET/DELETE `:id` handler at all, it 404s via the funnel handler first.
    it('funnels an empty :id segment to a 404, not the malformed-id ValidationError', async () => {
      const res = await api.delete(`${BASE}/conversations/`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
      expect(deleteConversation).not.toHaveBeenCalled();
    });
  });
});
