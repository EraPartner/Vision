/**
 * AI chat route tests.
 *
 * Focus: POST /api/ai/chat/stream SSE route + shared validator via /chat.
 * Mirrors the mockRouter pattern from tests/routes/import.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/services/aiChatService.js', () => {
  class AiChatServiceError extends Error {
    constructor(message, { code, status, cause } = {}) {
      super(message);
      this.name = 'AiChatServiceError';
      this.code = code || 'AI_CHAT_ERROR';
      this.status = status || 500;
      if (cause) this.cause = cause;
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

import { AiChatServiceError, runChatTurn } from '../../src/services/aiChatService.js';
import { ValidationError, AppError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/ai.js');

const UUID = '11111111-2222-4333-8444-555555555555';

function makeListenerStub() {
  const listeners = {};
  return {
    on: vi.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    emit(event, ...args) {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
  };
}

function mockResponse() {
  return createMockResponse(makeListenerStub());
}

function mockSseResponse() {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    writableEnded: false,
    ...makeListenerStub(),
  };
}

function mockStreamReq(body) {
  const listeners = {};
  return {
    body,
    on: vi.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    emit: (event, ...args) => (listeners[event] || []).forEach((cb) => cb(...args)),
  };
}

// ──────────────────────────────────────────
// POST /chat/stream (SSE)
// ──────────────────────────────────────────
describe('POST /api/ai/chat/stream', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws ValidationError when message missing (before SSE headers)', async () => {
    const req = mockStreamReq({ conversationId: UUID });
    const res = mockSseResponse();

    await expect(routeHandlers['post:/chat/stream'](req, res)).rejects.toBeInstanceOf(ValidationError);

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it('throws ValidationError when conversationId is not a UUID', async () => {
    const req = mockStreamReq({ conversationId: 'not-a-uuid', message: 'hi' });
    const res = mockSseResponse();

    await expect(routeHandlers['post:/chat/stream'](req, res)).rejects.toBeInstanceOf(ValidationError);

    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('throws ValidationError when message exceeds max length', async () => {
    const req = mockStreamReq({ message: 'x'.repeat(8001) });
    const res = mockSseResponse();

    await expect(routeHandlers['post:/chat/stream'](req, res)).rejects.toBeInstanceOf(ValidationError);

    expect(res.writeHead).not.toHaveBeenCalled();
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

    const req = mockStreamReq({ message: 'hi', conversationId: UUID });
    const res = mockSseResponse();

    await routeHandlers['post:/chat/stream'](req, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }));

    const writes = res.write.mock.calls
      .map(([payload]) => payload)
      // Skip the leading padding comment (lines beginning with `:`) used to
      // flush the browser SSE buffer threshold.
      .filter((p) => /^event:/.test(p));
    const eventNames = writes.map((p) => p.match(/^event: (\w+)/)[1]);
    expect(eventNames).toEqual([
      'user_message',
      'token',
      'token',
      'token',
      'tool_call',
      'tool_result',
      'done',
    ]);

    const userFrame = writes[0];
    expect(userFrame).toContain('data: ');
    expect(JSON.parse(userFrame.split('data: ')[1].trim())).toEqual({ message: userMsg });

    const tokenFrame = writes[1];
    expect(JSON.parse(tokenFrame.split('data: ')[1].trim())).toBe('Your ');

    const toolCallFrame = writes[4];
    const toolCallPayload = JSON.parse(toolCallFrame.split('data: ')[1].trim());
    expect(toolCallPayload.name).toBe('getSpendByCategory');
    expect(toolCallPayload.args.from).toBe('2025-01-01');

    const toolResultFrame = writes[5];
    expect(JSON.parse(toolResultFrame.split('data: ')[1].trim())).toEqual({ message: toolMsg });

    const doneFrame = writes[6];
    const donePayload = JSON.parse(doneFrame.split('data: ')[1].trim());
    expect(donePayload.conversation).toEqual(conversation);
    expect(donePayload.assistantMessage).toEqual(assistantMsg);
    expect(donePayload.usage.evalCount).toBe(10);
    expect(donePayload.iterations).toBe(2);

    expect(res.end).toHaveBeenCalledTimes(1);
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

    const req = mockStreamReq({ message: 'hi' });
    const res = mockSseResponse();
    await routeHandlers['post:/chat/stream'](req, res);

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

    const req = mockStreamReq({ message: 'hi' });
    const res = mockSseResponse();
    await routeHandlers['post:/chat/stream'](req, res);

    const writes = res.write.mock.calls.map(([payload]) => payload);
    expect(writes.some((p) => p.startsWith('event: error'))).toBe(true);

    const errFrame = writes.find((p) => p.startsWith('event: error'));
    const errPayload = JSON.parse(errFrame.split('data: ')[1].trim());
    expect(errPayload).toEqual({ detail: 'Model unavailable', code: 'OLLAMA_UNREACHABLE' });

    expect(writes.some((p) => p.startsWith('event: done'))).toBe(false);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('emits generic error SSE event on unexpected failure', async () => {
    runChatTurn.mockRejectedValue(new Error('db exploded'));

    const req = mockStreamReq({ message: 'hi' });
    const res = mockSseResponse();
    await routeHandlers['post:/chat/stream'](req, res);

    const writes = res.write.mock.calls.map(([payload]) => payload);
    const errFrame = writes.find((p) => p.startsWith('event: error'));
    expect(errFrame).toBeDefined();
    const errPayload = JSON.parse(errFrame.split('data: ')[1].trim());
    expect(errPayload).toEqual({ detail: 'Failed to stream AI chat message' });
    expect(errPayload.detail).not.toContain('db exploded');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('aborts runChatTurn and stops writing on client disconnect', async () => {
    let capturedSignal;
    runChatTurn.mockImplementation(async ({ signal, onEvent }) => {
      capturedSignal = signal;
      onEvent({ type: 'user_message', data: { id: 'u1' } });
      onEvent({ type: 'token', data: 'hello' });
      return {
        conversation: { id: UUID },
        userMessage: { id: 'u1' },
        toolMessages: [],
        assistantMessage: { id: 'a1', content: 'hello' },
        usage: {},
        iterations: 1,
      };
    });

    const req = mockStreamReq({ message: 'hi' });
    const res = mockSseResponse();

    const promise = routeHandlers['post:/chat/stream'](req, res);
    res.emit('close');
    await promise;

    expect(capturedSignal?.aborted).toBe(true);
    const writes = res.write.mock.calls.map(([payload]) => payload);
    expect(writes.some((p) => p.startsWith('event: done'))).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
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

    const req = mockStreamReq({ message: 'hi' });
    const res = mockSseResponse();
    await routeHandlers['post:/chat/stream'](req, res);

    const writes = res.write.mock.calls.map(([payload]) => payload);
    const eventNames = writes
      .map((p) => p.match(/^event: (\w+)/)?.[1])
      .filter(Boolean);

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

  it('throws ValidationError when message missing', async () => {
    const req = { body: {}, on: vi.fn() };
    const res = mockResponse();

    await expect(routeHandlers['post:/chat'](req, res)).rejects.toBeInstanceOf(ValidationError);

    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it('throws ValidationError when model is an empty string', async () => {
    const req = { body: { message: 'hi', model: '  ' }, on: vi.fn() };
    const res = mockResponse();

    await expect(routeHandlers['post:/chat'](req, res)).rejects.toBeInstanceOf(ValidationError);
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

    const req = { body: { message: 'hi' }, on: vi.fn() };
    const res = mockResponse();

    await routeHandlers['post:/chat'](req, res);

    expect(runChatTurn).toHaveBeenCalledTimes(1);
    const callArgs = runChatTurn.mock.calls[0][0];
    expect(callArgs.streaming).toBeUndefined();
    expect(callArgs.message).toBe('hi');
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        conversation: turn.conversation,
        userMessage: turn.userMessage,
        toolMessages: turn.toolMessages,
        assistantMessage: turn.assistantMessage,
        usage: turn.usage,
        iterations: turn.iterations,
      },
    });
  });

  it('throws AppError when AiChatServiceError occurs', async () => {
    runChatTurn.mockRejectedValue(new AiChatServiceError('bad', { code: 'INVALID_INPUT', status: 400 }));

    const req = { body: { message: 'hi' }, on: vi.fn() };
    const res = mockResponse();

    await expect(routeHandlers['post:/chat'](req, res)).rejects.toBeInstanceOf(AppError);
  });

  it('throws AppError on generic error', async () => {
    runChatTurn.mockRejectedValue(new Error('internal'));

    const req = { body: { message: 'hi' }, on: vi.fn() };
    const res = mockResponse();

    await expect(routeHandlers['post:/chat'](req, res)).rejects.toBeInstanceOf(AppError);
  });
});
