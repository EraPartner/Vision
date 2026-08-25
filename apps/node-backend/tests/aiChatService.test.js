import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/config.js', () => {
  const settings = {
    aiChat: {
      enabled: true,
      rateLimit: 30,
      maxHistoryMessages: 30,
      maxToolRows: 500,
    },
    ollama: {
      url: 'http://localhost:11434',
      defaultModel: 'llama3.1:8b',
      requestTimeoutMs: 60000,
      healthTimeoutMs: 3000,
    },
  };
  return { default: settings };
});

vi.mock('../src/repositories/aiChatRepository.js', () => ({
  aiChatRepository: {
    getConversation: vi.fn(),
    createConversation: vi.fn(),
    updateConversationModel: vi.fn(),
    renameConversation: vi.fn(),
    getMessages: vi.fn(),
    appendMessage: vi.fn(),
  },
}));

vi.mock('../src/services/aiChat/tools/index.js', () => ({
  dispatchTool: vi.fn(),
  getToolSchemas: vi.fn().mockReturnValue([
    { type: 'function', function: { name: 'getSpendByCategory', parameters: {} } },
  ]),
  getToolNames: vi.fn().mockReturnValue(['getSpendByCategory']),
}));

import settings from '../src/config/config.js';
import { aiChatRepository } from '../src/repositories/aiChatRepository.js';
import { dispatchTool } from '../src/services/aiChat/tools/index.js';
import { OllamaError } from '../src/integrations/ollama/client.js';
import {
  AiChatServiceError,
  runChatTurn,
  __constants,
} from '../src/services/aiChatService.js';

function makeConversation(overrides = {}) {
  return {
    id: 'conv-1',
    title: 'New conversation',
    model: 'llama3.1:8b',
    created_at: '2026-04-01T10:00:00Z',
    updated_at: '2026-04-01T10:00:00Z',
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: 'conv-1',
    role: 'user',
    content: '',
    tool_name: null,
    tool_args: null,
    tool_result: null,
    status: 'complete',
    created_at: '2026-04-01T10:00:00Z',
    ...overrides,
  };
}

function makeMockOllama() {
  return { chat: vi.fn() };
}

let originalEnabled;

beforeEach(() => {
  vi.clearAllMocks();
  originalEnabled = settings.aiChat.enabled;
  settings.aiChat.enabled = true;

  aiChatRepository.getMessages.mockResolvedValue([]);
  aiChatRepository.appendMessage.mockImplementation(async (input) =>
    makeMessage({ ...input, conversation_id: input.conversationId }),
  );
  aiChatRepository.createConversation.mockImplementation(async ({ title, model }) =>
    makeConversation({ title, model }),
  );
  aiChatRepository.getConversation.mockResolvedValue(makeConversation());
  aiChatRepository.updateConversationModel.mockResolvedValue(makeConversation());
});

afterEach(() => {
  settings.aiChat.enabled = originalEnabled;
});

describe('runChatTurn — feature flag', () => {
  it('throws AI_CHAT_DISABLED 503 when disabled', async () => {
    settings.aiChat.enabled = false;
    const ollamaClient = makeMockOllama();

    await expect(
      runChatTurn({ message: 'hi', ollamaClient }),
    ).rejects.toMatchObject({
      name: 'AiChatServiceError',
      code: 'AI_CHAT_DISABLED',
      status: 503,
    });
    expect(ollamaClient.chat).not.toHaveBeenCalled();
  });
});

describe('runChatTurn — input validation', () => {
  it('throws INVALID_INPUT 400 when message is empty', async () => {
    const ollamaClient = makeMockOllama();

    await expect(
      runChatTurn({ message: '   ', ollamaClient }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      status: 400,
    });
  });

  it('throws INVALID_INPUT 400 when message is not a string', async () => {
    const ollamaClient = makeMockOllama();

    await expect(
      runChatTurn({ message: null, ollamaClient }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      status: 400,
    });
    await expect(
      runChatTurn({ message: 42, ollamaClient }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('runChatTurn — conversation lifecycle', () => {
  it('creates new conversation with truncated title from first user message', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockResolvedValueOnce({
      content: 'reply',
      toolCalls: [],
      evalCount: 10,
      promptEvalCount: 5,
      totalDurationMs: 100,
    });

    const longMessage =
      'What was my biggest expense category in 2025 and how does it compare to the prior year average monthly spend across all categories?';

    await runChatTurn({ message: longMessage, ollamaClient });

    expect(aiChatRepository.createConversation).toHaveBeenCalledTimes(1);
    const { title, model } = aiChatRepository.createConversation.mock.calls[0][0];
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
    expect(model).toBe(settings.ollama.defaultModel);
  });

  it('uses existing conversation when conversationId passed', async () => {
    const existing = makeConversation({ id: 'c-99', model: 'llama3.1:8b' });
    aiChatRepository.getConversation.mockResolvedValueOnce(existing);

    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockResolvedValueOnce({
      content: 'ok', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
    });

    const result = await runChatTurn({
      conversationId: 'c-99',
      message: 'hi',
      ollamaClient,
    });

    expect(aiChatRepository.createConversation).not.toHaveBeenCalled();
    expect(aiChatRepository.getConversation).toHaveBeenCalledWith('c-99');
    expect(result.conversation.id).toBe('c-99');
  });

  it('throws CONVERSATION_NOT_FOUND 404 when id missing', async () => {
    aiChatRepository.getConversation.mockResolvedValueOnce(null);
    const ollamaClient = makeMockOllama();

    await expect(
      runChatTurn({ conversationId: 'does-not-exist', message: 'hi', ollamaClient }),
    ).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
      status: 404,
    });
    expect(ollamaClient.chat).not.toHaveBeenCalled();
  });

  it('updates conversation model when caller passes a different model', async () => {
    const existing = makeConversation({ id: 'c-1', model: 'llama3.1:8b' });
    aiChatRepository.getConversation.mockResolvedValueOnce(existing);

    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockResolvedValueOnce({
      content: 'ok', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
    });

    await runChatTurn({
      conversationId: 'c-1',
      message: 'hi',
      model: 'qwen2.5:7b',
      ollamaClient,
    });

    expect(aiChatRepository.updateConversationModel).toHaveBeenCalledWith('c-1', 'qwen2.5:7b');
    const chatCall = ollamaClient.chat.mock.calls[0][0];
    expect(chatCall.model).toBe('qwen2.5:7b');
  });

  it('does NOT update model when same as stored', async () => {
    const existing = makeConversation({ id: 'c-1', model: 'llama3.1:8b' });
    aiChatRepository.getConversation.mockResolvedValueOnce(existing);

    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockResolvedValueOnce({
      content: 'ok', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
    });

    await runChatTurn({
      conversationId: 'c-1',
      message: 'hi',
      model: 'llama3.1:8b',
      ollamaClient,
    });

    expect(aiChatRepository.updateConversationModel).not.toHaveBeenCalled();
  });
});

describe('runChatTurn — single turn (no tool calls)', () => {
  it('persists user + assistant message and returns', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockResolvedValueOnce({
      content: 'Your biggest category was Rent.',
      toolCalls: [],
      evalCount: 42,
      promptEvalCount: 10,
      totalDurationMs: 1200,
    });

    const result = await runChatTurn({ message: 'biggest category?', ollamaClient });

    expect(ollamaClient.chat).toHaveBeenCalledTimes(1);
    expect(aiChatRepository.appendMessage).toHaveBeenCalledTimes(2);
    expect(aiChatRepository.appendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: 'user', content: 'biggest category?' }),
    );
    expect(aiChatRepository.appendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ role: 'assistant', content: 'Your biggest category was Rent.' }),
    );
    expect(result.toolMessages).toHaveLength(0);
    expect(result.iterations).toBe(1);
    expect(result.usage).toEqual({
      evalCount: 42,
      promptEvalCount: 10,
      totalDurationMs: 1200,
    });
  });

  it('fires onEvent for user_message and assistant_message', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockResolvedValueOnce({
      content: 'reply', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
    });

    const events = [];
    await runChatTurn({
      message: 'hi',
      ollamaClient,
      onEvent: (e) => events.push(e.type),
    });

    expect(events).toEqual(['user_message', 'assistant_message']);
  });
});

describe('runChatTurn — tool-call loop', () => {
  it('runs one tool call then returns assistant reply', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'getSpendByCategory',
              arguments: { from: '2025-01-01', to: '2025-12-31' },
            },
          },
        ],
        evalCount: 10, promptEvalCount: 5, totalDurationMs: 100,
      })
      .mockResolvedValueOnce({
        content: 'Rent was €3600.',
        toolCalls: [],
        evalCount: 20, promptEvalCount: 15, totalDurationMs: 200,
      });

    dispatchTool.mockResolvedValueOnce({
      args: { from: '2025-01-01', to: '2025-12-31' },
      result: {
        ok: true,
        data: [{ category: 'Rent', total: 3600, count: 12 }],
        meta: { renderAs: 'bar' },
      },
    });

    const events = [];
    const result = await runChatTurn({
      message: 'biggest category?',
      ollamaClient,
      onEvent: (e) => events.push(e.type),
    });

    expect(ollamaClient.chat).toHaveBeenCalledTimes(2);
    expect(dispatchTool).toHaveBeenCalledWith(
      'getSpendByCategory',
      { from: '2025-01-01', to: '2025-12-31' },
      { cache: expect.any(Map), maxRows: settings.aiChat.maxToolRows },
    );
    expect(dispatchTool.mock.calls[0][2]).not.toHaveProperty('conversationId');
    expect(result.toolMessages).toHaveLength(1);
    expect(result.iterations).toBe(2);
    expect(result.assistantMessage.content).toBe('Rent was €3600.');
    expect(events).toEqual(['user_message', 'tool_call', 'tool_message', 'assistant_message']);
  });

  it('persists tool message with tool_name, tool_args, tool_result', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'getSpendByCategory',
              arguments: { from: '2025-01-01', to: '2025-12-31' },
            },
          },
        ],
        evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      })
      .mockResolvedValueOnce({
        content: 'done', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      });

    const toolPayload = { ok: true, data: [], meta: { renderAs: 'bar' } };
    dispatchTool.mockResolvedValueOnce({
      args: { from: '2025-01-01', to: '2025-12-31' },
      result: toolPayload,
    });

    await runChatTurn({ message: 'x', ollamaClient });

    const toolAppend = aiChatRepository.appendMessage.mock.calls.find(
      ([arg]) => arg.role === 'tool',
    );
    expect(toolAppend[0]).toMatchObject({
      role: 'tool',
      toolName: 'getSpendByCategory',
      toolArgs: { from: '2025-01-01', to: '2025-12-31' },
      toolResult: toolPayload,
    });
  });

  it('passes raw string arguments through to dispatchTool (the single coercion point) and persists/streams the coerced args it reports', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'getSpendByCategory',
              arguments: '{"from":"2025-01-01","to":"2025-01-31"}',
            },
          },
        ],
        evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      })
      .mockResolvedValueOnce({
        content: 'ok', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      });
    const coerced = { from: '2025-01-01', to: '2025-01-31' };
    dispatchTool.mockResolvedValueOnce({
      args: coerced,
      result: { ok: true, data: [], meta: { renderAs: 'bar' } },
    });

    const events = [];
    await runChatTurn({ message: 'x', ollamaClient, onEvent: (e) => events.push(e) });

    // The service no longer parses — the raw string reaches the dispatcher.
    expect(dispatchTool).toHaveBeenCalledWith(
      'getSpendByCategory',
      '{"from":"2025-01-01","to":"2025-01-31"}',
      expect.any(Object),
    );
    // Persisted toolArgs carries what the tool actually saw — the
    // dispatcher-coerced object.
    const toolAppend = aiChatRepository.appendMessage.mock.calls.find(
      ([arg]) => arg.role === 'tool',
    );
    expect(toolAppend[0].toolArgs).toEqual(coerced);
    // The pre-dispatch tool_call frame cannot know the coerced value yet:
    // string args ride as `{}` (the frame schema requires a record); the
    // tool_message frame that follows carries the coerced record.
    const toolCallEvt = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvt.data).toEqual({ name: 'getSpendByCategory', args: {} });
    const toolMsgEvt = events.find((e) => e.type === 'tool_message');
    expect(toolMsgEvt.data.toolArgs).toEqual(coerced);
  });

  it('bad-JSON tool args: persists the raw string next to the error result, streams an object args frame, and feeds the model the exact error payload', async () => {
    const rawArgs = '{not valid json';
    const validationResult = {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'arguments is not valid JSON: …' },
    };
    const ollamaClient = makeMockOllama();
    ollamaClient.chat
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { function: { name: 'getSpendByCategory', arguments: rawArgs } },
        ],
        evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      })
      .mockResolvedValueOnce({
        content: 'retried', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      });
    // Real dispatchTool returns the raw value as `args` when coercion fails.
    dispatchTool.mockResolvedValueOnce({ args: rawArgs, result: validationResult });

    const events = [];
    await runChatTurn({ message: 'x', ollamaClient, onEvent: (e) => events.push(e) });

    // Honest record: the unparsed string the model emitted, plus the error.
    const toolAppend = aiChatRepository.appendMessage.mock.calls.find(
      ([arg]) => arg.role === 'tool',
    );
    expect(toolAppend[0].toolArgs).toBe(rawArgs);
    expect(toolAppend[0].toolResult).toBe(validationResult);

    // The SSE frame schema requires a plain object — a non-record falls
    // back to {} (the raw value rides in the following tool_message row).
    const toolCallEvt = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvt.data).toEqual({ name: 'getSpendByCategory', args: {} });
    const toolMsgEvt = events.find((e) => e.type === 'tool_message');
    expect(toolMsgEvt.data.toolArgs).toBe(rawArgs);

    // LLM retry contract: the second model call sees the byte-identical
    // stringified error payload as its role:'tool' message.
    const secondCallMessages = ollamaClient.chat.mock.calls[1][0].messages;
    const toolMsg = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toBe(JSON.stringify(validationResult));
  });

  it('handles multiple tool calls in one model response', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { function: { name: 'getSpendByCategory', arguments: {} } },
          { function: { name: 'getSpendByCategory', arguments: {} } },
        ],
        evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      })
      .mockResolvedValueOnce({
        content: 'summary', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      });
    dispatchTool.mockResolvedValue({ args: {}, result: { ok: true, data: [], meta: { renderAs: 'bar' } } });

    const result = await runChatTurn({ message: 'x', ollamaClient });

    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(result.toolMessages).toHaveLength(2);
  });

  it('skips tool calls with missing name', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ function: { arguments: {} } }],
        evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      })
      .mockResolvedValueOnce({
        content: 'done', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      });

    const result = await runChatTurn({ message: 'x', ollamaClient });

    expect(dispatchTool).not.toHaveBeenCalled();
    expect(result.toolMessages).toHaveLength(0);
  });

  it('loops through multiple iterations', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ function: { name: 'getSpendByCategory', arguments: {} } }],
        evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ function: { name: 'getSpendByCategory', arguments: {} } }],
        evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      })
      .mockResolvedValueOnce({
        content: 'final', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
      });
    dispatchTool.mockResolvedValue({ args: {}, result: { ok: true, data: [], meta: { renderAs: 'bar' } } });

    const result = await runChatTurn({ message: 'x', ollamaClient });

    expect(result.iterations).toBe(3);
    expect(result.toolMessages).toHaveLength(2);
    expect(result.assistantMessage.content).toBe('final');
  });
});

describe('runChatTurn — server-side pre-call (ADR-110 §4)', () => {
  const digest = {
    subscriptionCreep: { new: [{ name: 'Netflix', amount: 12.99 }], priceChanges: [] },
    categoryOutliers: [],
    cashForecast: { endOfMonthP50: 1240 },
  };

  it('dispatches the pre-call tool, persists/emits it before the assistant turn, injects it into the model context, and returns the narration', async () => {
    dispatchTool.mockResolvedValueOnce({ args: {}, result: digest });

    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockResolvedValueOnce({
      content: 'One new subscription: Netflix at €12.99.',
      toolCalls: [],
      evalCount: 5, promptEvalCount: 3, totalDurationMs: 40,
    });

    const events = [];
    const result = await runChatTurn({
      message: 'Narrate my insights',
      preCallTool: 'insightsDigest',
      useTools: true,
      ollamaClient,
      onEvent: (e) => events.push(e.type),
    });

    // (a) tool dispatched server-side, row persisted, and events emitted
    // BEFORE the assistant turn ran.
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledWith(
      'insightsDigest',
      {},
      { cache: expect.any(Map), maxRows: settings.aiChat.maxToolRows },
    );
    expect(dispatchTool.mock.calls[0][2]).not.toHaveProperty('conversationId');
    expect(dispatchTool.mock.invocationCallOrder[0]).toBeLessThan(
      ollamaClient.chat.mock.invocationCallOrder[0],
    );
    expect(events).toEqual(['user_message', 'tool_call', 'tool_message', 'assistant_message']);
    const toolAppend = aiChatRepository.appendMessage.mock.calls.find(
      ([arg]) => arg.role === 'tool',
    );
    expect(toolAppend[0]).toMatchObject({
      role: 'tool',
      toolName: 'insightsDigest',
      toolArgs: {},
      toolResult: digest,
    });
    expect(result.toolMessages).toHaveLength(1);

    // (b) the single model call received the injected synthetic tool_call +
    // role:'tool' digest message before being asked to generate — with tool
    // schemas still enabled.
    expect(ollamaClient.chat).toHaveBeenCalledTimes(1);
    const chatArgs = ollamaClient.chat.mock.calls[0][0];
    const syntheticIdx = chatArgs.messages.findIndex(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls),
    );
    const toolMsgIdx = chatArgs.messages.findIndex(
      (m) => m.role === 'tool' && m.name === 'insightsDigest',
    );
    expect(syntheticIdx).toBeGreaterThanOrEqual(0);
    expect(toolMsgIdx).toBe(syntheticIdx + 1);
    expect(chatArgs.messages[syntheticIdx].tool_calls).toEqual([
      { function: { name: 'insightsDigest', arguments: '{}' } },
    ]);
    expect(chatArgs.messages[toolMsgIdx].content).toBe(JSON.stringify(digest));
    expect(chatArgs.tools).toBeDefined();
    expect(chatArgs.tools.length).toBeGreaterThan(0);

    // (c) the final assistant message is the narration.
    expect(result.assistantMessage.content).toBe('One new subscription: Netflix at €12.99.');
    expect(result.iterations).toBe(1);
  });

  it('does not crash the turn when the pre-call dispatch throws — logs and continues', async () => {
    dispatchTool.mockRejectedValueOnce(new Error('digest exploded'));

    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockResolvedValueOnce({
      content: 'plain reply', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
    });

    const result = await runChatTurn({
      message: 'Narrate my insights',
      preCallTool: 'insightsDigest',
      useTools: true,
      ollamaClient,
    });

    expect(result.assistantMessage.content).toBe('plain reply');
    expect(result.toolMessages).toHaveLength(0);
    const sentMessages = ollamaClient.chat.mock.calls[0][0].messages;
    expect(sentMessages.some((m) => m.role === 'tool')).toBe(false);
  });

  it('does not dispatch any pre-call when preCallTool is not set', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockResolvedValueOnce({
      content: 'ok', toolCalls: [], evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
    });

    await runChatTurn({ message: 'hi', ollamaClient });

    expect(dispatchTool).not.toHaveBeenCalled();
  });
});

describe('runChatTurn — iteration cap', () => {
  it('returns fallback error assistant message when cap reached', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockResolvedValue({
      content: '',
      toolCalls: [{ function: { name: 'getSpendByCategory', arguments: {} } }],
      evalCount: 1, promptEvalCount: 1, totalDurationMs: 10,
    });
    dispatchTool.mockResolvedValue({ args: {}, result: { ok: true, data: [], meta: { renderAs: 'bar' } } });

    const result = await runChatTurn({ message: 'x', ollamaClient });

    expect(ollamaClient.chat).toHaveBeenCalledTimes(__constants.MAX_TOOL_ITERATIONS);
    expect(result.iterations).toBe(__constants.MAX_TOOL_ITERATIONS);
    expect(result.assistantMessage.content).toMatch(/iteration limit/i);

    const fallbackCall = aiChatRepository.appendMessage.mock.calls.find(
      ([arg]) => arg.role === 'assistant' && arg.status === 'error',
    );
    expect(fallbackCall).toBeDefined();
  });
});

describe('runChatTurn — Ollama error mapping', () => {
  it('maps OllamaError (non-abort) to AiChatServiceError 502', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockRejectedValueOnce(
      new OllamaError('boom', { code: 'HTTP_ERROR', status: 500 }),
    );

    await expect(runChatTurn({ message: 'x', ollamaClient })).rejects.toMatchObject({
      name: 'AiChatServiceError',
      code: 'HTTP_ERROR',
      status: 502,
    });
  });

  it('maps aborted OllamaError to 499', async () => {
    const ollamaClient = makeMockOllama();
    ollamaClient.chat.mockRejectedValueOnce(
      new OllamaError('aborted', { code: 'ABORTED' }),
    );

    await expect(runChatTurn({ message: 'x', ollamaClient })).rejects.toMatchObject({
      code: 'ABORTED',
      status: 499,
    });
  });

  it('maps a coded error from another injected provider to 502', async () => {
    const ollamaClient = makeMockOllama();
    const providerError = Object.assign(new Error('provider failed'), {
      code: 'PROVIDER_FAILED',
    });
    ollamaClient.chat.mockRejectedValueOnce(providerError);

    await expect(runChatTurn({ message: 'x', ollamaClient })).rejects.toMatchObject({
      name: 'AiChatServiceError',
      code: 'PROVIDER_FAILED',
      status: 502,
    });
  });

  it('maps a coded abort from another injected provider to 499', async () => {
    const ollamaClient = makeMockOllama();
    const providerError = Object.assign(new Error('aborted'), { code: 'ABORTED' });
    ollamaClient.chat.mockRejectedValueOnce(providerError);

    await expect(runChatTurn({ message: 'x', ollamaClient })).rejects.toMatchObject({
      code: 'ABORTED',
      status: 499,
    });
  });

  it('rethrows non-Ollama errors unchanged', async () => {
    const ollamaClient = makeMockOllama();
    const err = new Error('unexpected');
    ollamaClient.chat.mockRejectedValueOnce(err);

    await expect(runChatTurn({ message: 'x', ollamaClient })).rejects.toBe(err);
  });
});

describe('AiChatServiceError', () => {
  it('defaults code/status when not provided', () => {
    const err = new AiChatServiceError('boom');
    expect(err.code).toBe('AI_CHAT_ERROR');
    expect(err.status).toBe(500);
    expect(err.name).toBe('AiChatServiceError');
  });

  it('attaches cause when provided', () => {
    const cause = new Error('inner');
    const err = new AiChatServiceError('outer', { code: 'X', status: 502, cause });
    expect(err.cause).toBe(cause);
  });

  it('extends AppError and carries status/code so the error middleware maps it', async () => {
    const { AppError } = await import('../src/middleware/errorHandler.js');
    const err = new AiChatServiceError('nope', { code: 'CONVERSATION_NOT_FOUND', status: 404 });
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.code).toBe('CONVERSATION_NOT_FOUND');
  });
});

describe('runChatTurn — streaming', () => {
  it('emits token events for each delta and final assistant_message', async () => {
    const ollamaClient = {
      chat: vi.fn(),
      chatStream: vi.fn(async ({ onToken }) => {
        onToken('Hel');
        onToken('lo ');
        onToken('world');
        return {
          content: 'Hello world',
          toolCalls: [],
          evalCount: 3,
          promptEvalCount: 2,
          totalDurationMs: 50,
        };
      }),
    };

    const events = [];
    const result = await runChatTurn({
      message: 'hi',
      ollamaClient,
      streaming: true,
      onEvent: (e) => events.push(e),
    });

    expect(ollamaClient.chatStream).toHaveBeenCalledTimes(1);
    expect(ollamaClient.chat).not.toHaveBeenCalled();

    const tokens = events.filter((e) => e.type === 'token').map((e) => e.data);
    expect(tokens).toEqual(['Hel', 'lo ', 'world']);

    const types = events.map((e) => e.type);
    expect(types).toEqual(['user_message', 'token', 'token', 'token', 'assistant_message']);
    expect(result.assistantMessage.content).toBe('Hello world');
  });

  it('skips empty-string delta tokens', async () => {
    const ollamaClient = {
      chat: vi.fn(),
      chatStream: vi.fn(async ({ onToken }) => {
        onToken('A');
        onToken('');
        onToken('B');
        return {
          content: 'AB',
          toolCalls: [],
          evalCount: 2,
          promptEvalCount: 1,
          totalDurationMs: 10,
        };
      }),
    };

    const events = [];
    await runChatTurn({
      message: 'hi',
      ollamaClient,
      streaming: true,
      onEvent: (e) => events.push(e),
    });

    const tokens = events.filter((e) => e.type === 'token').map((e) => e.data);
    expect(tokens).toEqual(['A', 'B']);
  });

  it('emits tool_call before dispatch (progress affordance) and tool_message after', async () => {
    const ollamaClient = {
      chat: vi.fn(),
      chatStream: vi
        .fn()
        .mockImplementationOnce(async () => ({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'getSpendByCategory',
                arguments: { from: '2025-01-01', to: '2025-12-31' },
              },
            },
          ],
          evalCount: 1,
          promptEvalCount: 1,
          totalDurationMs: 10,
        }))
        .mockImplementationOnce(async ({ onToken }) => {
          onToken('done');
          return {
            content: 'done',
            toolCalls: [],
            evalCount: 1,
            promptEvalCount: 1,
            totalDurationMs: 10,
          };
        }),
    };

    dispatchTool.mockResolvedValueOnce({
      args: { from: '2025-01-01', to: '2025-12-31' },
      result: {
        ok: true,
        data: [{ category: 'Rent', total: 3600 }],
        meta: { renderAs: 'bar' },
      },
    });

    const events = [];
    // Pin the pre-dispatch ordering itself: record how many dispatches had
    // happened at the moment the tool_call frame fired.
    let dispatchCountAtToolCall;
    const result = await runChatTurn({
      message: 'biggest?',
      ollamaClient,
      streaming: true,
      onEvent: (e) => {
        if (e.type === 'tool_call') dispatchCountAtToolCall = dispatchTool.mock.calls.length;
        events.push(e);
      },
    });

    const types = events.map((e) => e.type);
    const toolCallIdx = types.indexOf('tool_call');
    const toolMsgIdx = types.indexOf('tool_message');
    expect(toolCallIdx).toBeGreaterThanOrEqual(0);
    expect(toolMsgIdx).toBeGreaterThan(toolCallIdx);
    expect(dispatchCountAtToolCall).toBe(0);

    const toolCallEvt = events[toolCallIdx];
    expect(toolCallEvt.data).toEqual({
      name: 'getSpendByCategory',
      args: { from: '2025-01-01', to: '2025-12-31' },
    });
    expect(result.iterations).toBe(2);
  });

  it('falls back to chat when ollamaClient lacks chatStream', async () => {
    const ollamaClient = {
      chat: vi.fn().mockResolvedValueOnce({
        content: 'plain',
        toolCalls: [],
        evalCount: 1,
        promptEvalCount: 1,
        totalDurationMs: 10,
      }),
    };

    const events = [];
    const result = await runChatTurn({
      message: 'hi',
      ollamaClient,
      streaming: true,
      onEvent: (e) => events.push(e),
    });

    expect(ollamaClient.chat).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'token')).toHaveLength(0);
    expect(result.assistantMessage.content).toBe('plain');
  });

  it('non-streaming default does not invoke chatStream even when present', async () => {
    const ollamaClient = {
      chat: vi.fn().mockResolvedValueOnce({
        content: 'ok',
        toolCalls: [],
        evalCount: 1,
        promptEvalCount: 1,
        totalDurationMs: 10,
      }),
      chatStream: vi.fn(),
    };

    await runChatTurn({ message: 'hi', ollamaClient });

    expect(ollamaClient.chat).toHaveBeenCalledTimes(1);
    expect(ollamaClient.chatStream).not.toHaveBeenCalled();
  });

  it('maps OllamaError from chatStream to AiChatServiceError', async () => {
    const ollamaClient = {
      chat: vi.fn(),
      chatStream: vi.fn().mockRejectedValueOnce(
        new OllamaError('stream failed', { code: 'STREAM_ERROR' }),
      ),
    };

    await expect(
      runChatTurn({ message: 'hi', ollamaClient, streaming: true }),
    ).rejects.toMatchObject({
      name: 'AiChatServiceError',
      code: 'STREAM_ERROR',
      status: 502,
    });
  });
});

describe('no-external-calls guarantee', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({})),
    );

    aiChatRepository.getConversation.mockResolvedValue(makeConversation());
    aiChatRepository.getMessages.mockResolvedValue([]);
    aiChatRepository.appendMessage.mockResolvedValue(undefined);
    dispatchTool.mockResolvedValue({ args: {}, result: { ok: true, data: [] } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call fetch when ollamaClient is injected', async () => {
    const ollamaClient = {
      chat: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'All clear.' },
        tool_calls: [],
      }),
    };

    await runChatTurn({
      conversationId: 'conv-1',
      message: 'show me my expenses',
      ollamaClient,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not call fetch even when tools are dispatched', async () => {
    const ollamaClient = {
      chat: vi.fn()
        .mockResolvedValueOnce({
          message: { role: 'assistant', content: null },
          tool_calls: [{ function: { name: 'getSpendByCategory', arguments: { from: '2025-01-01', to: '2025-01-31' } } }],
        })
        .mockResolvedValueOnce({
          message: { role: 'assistant', content: 'Here are your expenses.' },
          tool_calls: [],
        }),
    };

    await runChatTurn({
      conversationId: 'conv-1',
      message: 'how much did I spend?',
      ollamaClient,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not call fetch on the insights pre-call path (ADR-110 §4)', async () => {
    const ollamaClient = {
      chat: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'Here is what stands out this month.' },
        tool_calls: [],
      }),
    };

    await runChatTurn({
      conversationId: 'conv-1',
      message: 'Narrate my insights',
      preCallTool: 'insightsDigest',
      useTools: true,
      ollamaClient,
    });

    expect(dispatchTool).toHaveBeenCalledWith('insightsDigest', {}, expect.any(Object));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
