import { describe, it, expect } from "vitest";
import {
  __buildSystemPrompt as buildSystemPrompt,
  toOllamaMessage,
  buildChatMessages,
  serializeToolResultForPrompt,
} from "../src/integrations/ollama/prompts.js";

describe("buildSystemPrompt", () => {
  it("injects comma-separated tool names into the prompt", () => {
    const prompt = buildSystemPrompt([
      "getSpendByCategory",
      "getPortfolioHoldings",
    ]);
    expect(prompt).toContain(
      "Available tools: getSpendByCategory, getPortfolioHoldings",
    );
  });

  it("injects a single tool name cleanly", () => {
    const prompt = buildSystemPrompt(["getSpendByCategory"]);
    expect(prompt).toContain("Available tools: getSpendByCategory");
  });

  it('falls back to "(none)" when tool list is empty', () => {
    expect(buildSystemPrompt([])).toContain("Available tools: (none)");
  });

  it('falls back to "(none)" when toolNames is undefined', () => {
    expect(buildSystemPrompt(undefined)).toContain("Available tools: (none)");
  });

  it('falls back to "(none)" when toolNames is null', () => {
    expect(buildSystemPrompt(null)).toContain("Available tools: (none)");
  });

  it('falls back to "(none)" when toolNames is not an array', () => {
    expect(buildSystemPrompt("foo")).toContain("Available tools: (none)");
  });

  it("contains core ground rules (English, EUR, no fabrication)", () => {
    const prompt = buildSystemPrompt(["x"]);
    expect(prompt).toContain("Never invent figures");
    expect(prompt).toContain("Respond in English");
    expect(prompt).toContain("EUR");
  });

  it("contains tool-error handling guidance", () => {
    const prompt = buildSystemPrompt(["x"]);
    expect(prompt).toContain("VALIDATION_ERROR");
    expect(prompt).toContain("UNKNOWN_TOOL");
    expect(prompt).toContain("TOOL_ERROR");
  });

  it("mentions the renderAs meta hint", () => {
    const prompt = buildSystemPrompt(["x"]);
    expect(prompt).toContain("renderAs");
  });
});

describe("toOllamaMessage", () => {
  it("returns null for a null row", () => {
    expect(toOllamaMessage(null)).toBeNull();
  });

  it("returns null for an undefined row", () => {
    expect(toOllamaMessage(undefined)).toBeNull();
  });

  it("returns null when row has no role", () => {
    expect(toOllamaMessage({ content: "hi" })).toBeNull();
  });

  it("maps a user row to {role, content}", () => {
    const row = { role: "user", content: "hello" };
    expect(toOllamaMessage(row)).toEqual({ role: "user", content: "hello" });
  });

  it("maps an assistant row to {role, content}", () => {
    const row = { role: "assistant", content: "ok" };
    expect(toOllamaMessage(row)).toEqual({ role: "assistant", content: "ok" });
  });

  it("uses empty string when content is missing on non-tool row", () => {
    expect(toOllamaMessage({ role: "assistant" })).toEqual({
      role: "assistant",
      content: "",
    });
  });

  it("uses empty string when content is null on non-tool row", () => {
    expect(toOllamaMessage({ role: "user", content: null })).toEqual({
      role: "user",
      content: "",
    });
  });

  // Fixtures use the camelCase field names aiChatRepository's MESSAGE_COLUMNS
  // aliases to in SQL (toolName/toolResult) — the shape aiChatService actually
  // passes. They previously used the raw snake_case column names, which no
  // caller has ever produced, so they exercised a fallback branch that could
  // not fire in production; that branch is now gone.
  it("serializes an object toolResult to JSON for tool rows", () => {
    const row = {
      role: "tool",
      toolName: "getSpendByCategory",
      toolResult: { ok: true, data: [{ category: "Food", total: 42.5 }] },
    };
    const msg = toOllamaMessage(row);
    expect(msg.role).toBe("tool");
    expect(msg.name).toBe("getSpendByCategory");
    expect(JSON.parse(msg.content)).toEqual({
      ok: true,
      data: [{ category: "Food", total: 42.5 }],
    });
  });

  it("passes through a pre-stringified toolResult", () => {
    const row = {
      role: "tool",
      toolName: "x",
      toolResult: '{"already":"json"}',
    };
    const msg = toOllamaMessage(row);
    expect(msg.content).toBe('{"already":"json"}');
  });

  it('falls back to "unknown" when toolName is missing on tool row', () => {
    const row = { role: "tool", toolResult: { ok: true, data: {} } };
    expect(toOllamaMessage(row).name).toBe("unknown");
  });

  it("substitutes a fallback envelope when toolResult is missing", () => {
    const row = { role: "tool", toolName: "x" };
    const msg = toOllamaMessage(row);
    const parsed = JSON.parse(msg.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("MISSING");
  });

  it("substitutes a fallback envelope when toolResult is null", () => {
    const row = { role: "tool", toolName: "x", toolResult: null };
    const parsed = JSON.parse(toOllamaMessage(row).content);
    expect(parsed.ok).toBe(false);
  });

  it("caps large tool data while retaining ok, meta, and error fields", () => {
    const row = {
      role: "tool",
      toolName: "largeTool",
      toolResult: {
        ok: false,
        data: Array.from({ length: 100 }, (_, id) => ({
          id,
          value: "x".repeat(20),
        })),
        meta: { renderAs: "table", total: 100 },
        error: { code: "PARTIAL", message: "Some rows unavailable" },
      },
    };

    const parsed = JSON.parse(
      toOllamaMessage(row, { maxToolResultChars: 300 }).content,
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.meta).toEqual({ renderAs: "table", total: 100 });
    expect(parsed.error).toEqual({
      code: "PARTIAL",
      message: "Some rows unavailable",
    });
    expect(parsed.data).toMatchObject({ truncated: true });
    expect(parsed.data.originalCharacters).toBeGreaterThan(
      parsed.data.preview.length,
    );
  });

  it("enforces the final limit for string tool results", () => {
    const serialized = serializeToolResultForPrompt("x".repeat(1_000), 100);
    expect(serialized.length).toBeLessThanOrEqual(100);
    expect(serialized.endsWith("…")).toBe(true);
  });

  it("enforces the final limit when metadata and errors are oversized", () => {
    const serialized = serializeToolResultForPrompt(
      {
        ok: false,
        data: "d".repeat(1_000),
        meta: { detail: "m".repeat(1_000) },
        error: { message: "e".repeat(1_000) },
      },
      100,
    );
    expect(serialized.length).toBeLessThanOrEqual(100);
    const parsed = JSON.parse(serialized);
    expect(parsed).toHaveProperty("ok", false);
    expect(parsed).toHaveProperty("meta");
    expect(parsed).toHaveProperty("error");
    expect(parsed).toHaveProperty("data");
  });

  it("always returns valid content within even a tiny positive limit", () => {
    for (const limit of [1, 2, 17, 18]) {
      const serialized = serializeToolResultForPrompt(
        { ok: true, data: "x".repeat(100) },
        limit,
      );
      expect(serialized.length).toBeLessThanOrEqual(limit);
      expect(() => JSON.parse(serialized)).not.toThrow();
    }
  });
});

describe("buildChatMessages", () => {
  it("always prepends a system message with tool names", () => {
    const messages = buildChatMessages({
      toolNames: ["getSpendByCategory"],
      history: [],
      userInput: "hello",
    });
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("getSpendByCategory");
  });

  it("appends the user input as the final message", () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [],
      userInput: "what is my spend",
    });
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "what is my spend",
    });
  });

  it("trims leading/trailing whitespace from user input", () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [],
      userInput: "   hello   ",
    });
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("omits user message when userInput is missing", () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
  });

  it("omits user message when userInput is empty", () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [],
      userInput: "",
    });
    expect(messages).toHaveLength(1);
  });

  it("omits user message when userInput is whitespace only", () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [],
      userInput: "   \t\n  ",
    });
    expect(messages).toHaveLength(1);
  });

  it("maps history rows in order between system and user", () => {
    const history = [
      { role: "user", content: "first q" },
      { role: "assistant", content: "first a" },
    ];
    const messages = buildChatMessages({
      toolNames: ["x"],
      history,
      userInput: "second q",
    });
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "first q" });
    expect(messages[2]).toEqual({ role: "assistant", content: "first a" });
    expect(messages[3]).toEqual({ role: "user", content: "second q" });
  });

  it("trims history to the last maxHistoryMessages rows", () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
    }));
    const messages = buildChatMessages({
      toolNames: [],
      history,
      userInput: "latest",
      maxHistoryMessages: 5,
    });
    const historyMessages = messages.slice(1, -1);
    expect(historyMessages).toHaveLength(5);
    expect(historyMessages[0].content).toBe("msg-45");
    expect(historyMessages[4].content).toBe("msg-49");
  });

  it("defaults maxHistoryMessages to 30", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: "user",
      content: `msg-${i}`,
    }));
    const messages = buildChatMessages({
      toolNames: [],
      history,
      userInput: "latest",
    });
    const historyMessages = messages.slice(1, -1);
    expect(historyMessages).toHaveLength(30);
    expect(historyMessages[0].content).toBe("msg-10");
    expect(historyMessages[29].content).toBe("msg-39");
  });

  it("walks history newest-first under the context budget", () => {
    const history = [
      { role: "user", content: `old-${"a".repeat(75)}` },
      { role: "assistant", content: `middle-${"b".repeat(75)}` },
      { role: "user", content: `newest-${"c".repeat(75)}` },
    ];
    const messages = buildChatMessages({
      toolNames: [],
      history,
      userInput: "latest",
      contextBudgetChars: buildSystemPrompt([]).length + 90,
    });

    expect(messages.slice(1, -1)).toEqual([
      { role: "user", content: `newest-${"c".repeat(75)}` },
    ]);
  });

  it("truncates rather than drops the newest history row when it only partly fits", () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: [{ role: "assistant", content: `prefix-${"z".repeat(500)}` }],
      userInput: "latest",
      contextBudgetChars: buildSystemPrompt([]).length + 60,
    });

    const historyMessage = messages[1];
    expect(historyMessage.role).toBe("assistant");
    expect(historyMessage.content).toMatch(/^…/);
    expect(historyMessage.content.endsWith("z".repeat(10))).toBe(true);
    expect(historyMessage.content.length).toBeLessThanOrEqual(54);
    expect(messages.at(-1)).toEqual({ role: "user", content: "latest" });
  });

  it("skips null rows returned from mapper", () => {
    const history = [
      { role: "user", content: "hi" },
      null,
      { role: "assistant", content: "hey" },
      { content: "no role" },
    ];
    const messages = buildChatMessages({
      toolNames: [],
      history,
      userInput: "go",
    });
    expect(messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
      { role: "user", content: "go" },
    ]);
  });

  it("serializes tool rows inside history", () => {
    const history = [
      { role: "user", content: "show spend" },
      {
        role: "tool",
        toolName: "getSpendByCategory",
        toolResult: { ok: true, data: [{ category: "Food", total: 100 }] },
      },
    ];
    const messages = buildChatMessages({
      toolNames: ["getSpendByCategory"],
      history,
      userInput: "thanks",
    });
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.name).toBe("getSpendByCategory");
    expect(JSON.parse(toolMsg.content).data[0].category).toBe("Food");
  });

  it("handles empty history with no user input (system-only)", () => {
    const messages = buildChatMessages({ toolNames: ["x"] });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
  });
});
