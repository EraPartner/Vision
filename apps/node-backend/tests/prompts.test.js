import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  toOllamaMessage,
  buildChatMessages,
} from '../src/integrations/ollama/prompts.js';

describe('buildSystemPrompt', () => {
  it('injects comma-separated tool names into the prompt', () => {
    const prompt = buildSystemPrompt(['getSpendByCategory', 'getPortfolioHoldings']);
    expect(prompt).toContain('Available tools: getSpendByCategory, getPortfolioHoldings');
  });

  it('injects a single tool name cleanly', () => {
    const prompt = buildSystemPrompt(['getSpendByCategory']);
    expect(prompt).toContain('Available tools: getSpendByCategory');
  });

  it('falls back to "(none)" when tool list is empty', () => {
    expect(buildSystemPrompt([])).toContain('Available tools: (none)');
  });

  it('falls back to "(none)" when toolNames is undefined', () => {
    expect(buildSystemPrompt(undefined)).toContain('Available tools: (none)');
  });

  it('falls back to "(none)" when toolNames is null', () => {
    expect(buildSystemPrompt(null)).toContain('Available tools: (none)');
  });

  it('falls back to "(none)" when toolNames is not an array', () => {
    expect(buildSystemPrompt('foo')).toContain('Available tools: (none)');
  });

  it('contains core ground rules (English, EUR, no fabrication)', () => {
    const prompt = buildSystemPrompt(['x']);
    expect(prompt).toContain('Never invent figures');
    expect(prompt).toContain('Respond in English');
    expect(prompt).toContain('EUR');
  });

  it('contains tool-error handling guidance', () => {
    const prompt = buildSystemPrompt(['x']);
    expect(prompt).toContain('VALIDATION_ERROR');
    expect(prompt).toContain('UNKNOWN_TOOL');
    expect(prompt).toContain('TOOL_ERROR');
  });

  it('mentions the renderAs meta hint', () => {
    const prompt = buildSystemPrompt(['x']);
    expect(prompt).toContain('renderAs');
  });
});

describe('toOllamaMessage', () => {
  it('returns null for a null row', () => {
    expect(toOllamaMessage(null)).toBeNull();
  });

  it('returns null for an undefined row', () => {
    expect(toOllamaMessage(undefined)).toBeNull();
  });

  it('returns null when row has no role', () => {
    expect(toOllamaMessage({ content: 'hi' })).toBeNull();
  });

  it('maps a user row to {role, content}', () => {
    const row = { role: 'user', content: 'hello' };
    expect(toOllamaMessage(row)).toEqual({ role: 'user', content: 'hello' });
  });

  it('maps an assistant row to {role, content}', () => {
    const row = { role: 'assistant', content: 'ok' };
    expect(toOllamaMessage(row)).toEqual({ role: 'assistant', content: 'ok' });
  });

  it('uses empty string when content is missing on non-tool row', () => {
    expect(toOllamaMessage({ role: 'assistant' })).toEqual({
      role: 'assistant',
      content: '',
    });
  });

  it('uses empty string when content is null on non-tool row', () => {
    expect(toOllamaMessage({ role: 'user', content: null })).toEqual({
      role: 'user',
      content: '',
    });
  });

  it('serializes an object tool_result to JSON for tool rows', () => {
    const row = {
      role: 'tool',
      tool_name: 'getSpendByCategory',
      tool_result: { ok: true, data: [{ category: 'Food', total: 42.5 }] },
    };
    const msg = toOllamaMessage(row);
    expect(msg.role).toBe('tool');
    expect(msg.name).toBe('getSpendByCategory');
    expect(JSON.parse(msg.content)).toEqual({
      ok: true,
      data: [{ category: 'Food', total: 42.5 }],
    });
  });

  it('passes through a pre-stringified tool_result', () => {
    const row = {
      role: 'tool',
      tool_name: 'x',
      tool_result: '{"already":"json"}',
    };
    const msg = toOllamaMessage(row);
    expect(msg.content).toBe('{"already":"json"}');
  });

  it('falls back to "unknown" when tool_name is missing on tool row', () => {
    const row = { role: 'tool', tool_result: { ok: true, data: {} } };
    expect(toOllamaMessage(row).name).toBe('unknown');
  });

  it('substitutes a fallback envelope when tool_result is missing', () => {
    const row = { role: 'tool', tool_name: 'x' };
    const msg = toOllamaMessage(row);
    const parsed = JSON.parse(msg.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('MISSING');
  });

  it('substitutes a fallback envelope when tool_result is null', () => {
    const row = { role: 'tool', tool_name: 'x', tool_result: null };
    const parsed = JSON.parse(toOllamaMessage(row).content);
    expect(parsed.ok).toBe(false);
  });
});

describe('buildChatMessages', () => {
  it('always prepends a system message with tool names', () => {
    const messages = buildChatMessages({
      toolNames: ['getSpendByCategory'],
      history: [],
      userInput: 'hello',
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('getSpendByCategory');
  });

  it('appends the user input as the final message', () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [],
      userInput: 'what is my spend',
    });
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: 'what is my spend',
    });
  });

  it('trims leading/trailing whitespace from user input', () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [],
      userInput: '   hello   ',
    });
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: 'hello',
    });
  });

  it('omits user message when userInput is missing', () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
  });

  it('omits user message when userInput is empty', () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [],
      userInput: '',
    });
    expect(messages).toHaveLength(1);
  });

  it('omits user message when userInput is whitespace only', () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [],
      userInput: '   \t\n  ',
    });
    expect(messages).toHaveLength(1);
  });

  it('maps history rows in order between system and user', () => {
    const history = [
      { role: 'user', content: 'first q' },
      { role: 'assistant', content: 'first a' },
    ];
    const messages = buildChatMessages({
      toolNames: ['x'],
      history,
      userInput: 'second q',
    });
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'first q' });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'first a' });
    expect(messages[3]).toEqual({ role: 'user', content: 'second q' });
  });

  it('trims history to the last maxHistoryMessages rows', () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`,
    }));
    const messages = buildChatMessages({
      toolNames: [],
      history,
      userInput: 'latest',
      maxHistoryMessages: 5,
    });
    const historyMessages = messages.slice(1, -1);
    expect(historyMessages).toHaveLength(5);
    expect(historyMessages[0].content).toBe('msg-45');
    expect(historyMessages[4].content).toBe('msg-49');
  });

  it('defaults maxHistoryMessages to 30', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: 'user',
      content: `msg-${i}`,
    }));
    const messages = buildChatMessages({
      toolNames: [],
      history,
      userInput: 'latest',
    });
    const historyMessages = messages.slice(1, -1);
    expect(historyMessages).toHaveLength(30);
    expect(historyMessages[0].content).toBe('msg-10');
    expect(historyMessages[29].content).toBe('msg-39');
  });

  it('skips null rows returned from mapper', () => {
    const history = [
      { role: 'user', content: 'hi' },
      null,
      { role: 'assistant', content: 'hey' },
      { content: 'no role' },
    ];
    const messages = buildChatMessages({
      toolNames: [],
      history,
      userInput: 'go',
    });
    expect(messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
      { role: 'user', content: 'go' },
    ]);
  });

  it('serializes tool rows inside history', () => {
    const history = [
      { role: 'user', content: 'show spend' },
      {
        role: 'tool',
        tool_name: 'getSpendByCategory',
        tool_result: { ok: true, data: [{ category: 'Food', total: 100 }] },
      },
    ];
    const messages = buildChatMessages({
      toolNames: ['getSpendByCategory'],
      history,
      userInput: 'thanks',
    });
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.name).toBe('getSpendByCategory');
    expect(JSON.parse(toolMsg.content).data[0].category).toBe('Food');
  });

  it('handles empty history with no user input (system-only)', () => {
    const messages = buildChatMessages({ toolNames: ['x'] });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
  });
});
