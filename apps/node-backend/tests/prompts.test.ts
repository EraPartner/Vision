import { describe, it, expect } from "vitest";
import {
  HISTORY_REPLAY_STEP,
  __buildSystemPrompt as buildSystemPrompt,
  toOllamaMessage,
  buildChatMessages,
  serializeToolResultForPrompt,
} from "../src/integrations/ollama/prompts.ts";
import type { BuildChatMessagesArgs } from "../src/integrations/ollama/prompts.ts";
import type { AiMessageRow } from "../src/types/rows.ts";
import { loose, partial } from "./helpers/partial.ts";
import { must } from "./helpers/must.ts";
import { valueAt } from "./helpers/responseBody.ts";

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
    // @ts-expect-error -- a missing tool list must still render "(none)"
    expect(buildSystemPrompt(undefined)).toContain("Available tools: (none)");
  });

  it('falls back to "(none)" when toolNames is null', () => {
    // @ts-expect-error -- a null tool list must still render "(none)"
    expect(buildSystemPrompt(null)).toContain("Available tools: (none)");
  });

  it('falls back to "(none)" when toolNames is not an array', () => {
    // @ts-expect-error -- a non-array tool list must still render "(none)"
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
    expect(
      toOllamaMessage(partial<AiMessageRow>({ content: "hi" })),
    ).toBeNull();
  });

  it("maps a user row to {role, content}", () => {
    const row = partial<AiMessageRow>({ role: "user", content: "hello" });
    expect(toOllamaMessage(row)).toEqual({ role: "user", content: "hello" });
  });

  it("maps an assistant row to {role, content}", () => {
    const row = partial<AiMessageRow>({ role: "assistant", content: "ok" });
    expect(toOllamaMessage(row)).toEqual({ role: "assistant", content: "ok" });
  });

  it("uses empty string when content is missing on non-tool row", () => {
    expect(
      toOllamaMessage(partial<AiMessageRow>({ role: "assistant" })),
    ).toEqual({
      role: "assistant",
      content: "",
    });
  });

  it("uses empty string when content is null on non-tool row", () => {
    expect(
      toOllamaMessage(partial<AiMessageRow>({ role: "user", content: null })),
    ).toEqual({
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
    const row = partial<AiMessageRow>({
      role: "tool",
      toolName: "getSpendByCategory",
      toolResult: { ok: true, data: [{ category: "Food", total: 42.5 }] },
    });
    const msg = must(toOllamaMessage(row), "toOllamaMessage result");
    expect(msg.role).toBe("tool");
    expect(msg.name).toBe("getSpendByCategory");
    expect(JSON.parse(msg.content)).toEqual({
      ok: true,
      data: [{ category: "Food", total: 42.5 }],
    });
  });

  it("passes through a pre-stringified toolResult", () => {
    const row = partial<AiMessageRow>({
      role: "tool",
      toolName: "x",
      toolResult: '{"already":"json"}',
    });
    const msg = must(toOllamaMessage(row), "toOllamaMessage result");
    expect(msg.content).toBe('{"already":"json"}');
  });

  it('falls back to "unknown" when toolName is missing on tool row', () => {
    const row = partial<AiMessageRow>({
      role: "tool",
      toolResult: { ok: true, data: {} },
    });
    expect(must(toOllamaMessage(row), "toOllamaMessage result").name).toBe("unknown");
  });

  it("substitutes a fallback envelope when toolResult is missing", () => {
    const row = partial<AiMessageRow>({ role: "tool", toolName: "x" });
    const msg = must(toOllamaMessage(row), "toOllamaMessage result");
    const parsed: unknown = JSON.parse(msg.content);
    expect(valueAt(parsed, "ok")).toBe(false);
    expect(valueAt(parsed, "error", "code")).toBe("MISSING");
  });

  it("substitutes a fallback envelope when toolResult is null", () => {
    const row = partial<AiMessageRow>({
      role: "tool",
      toolName: "x",
      toolResult: null,
    });
    const parsed: unknown = JSON.parse(
      must(toOllamaMessage(row), "toOllamaMessage result").content,
    );
    expect(valueAt(parsed, "ok")).toBe(false);
  });

  it("caps large tool data while retaining ok, meta, and error fields", () => {
    const row = partial<AiMessageRow>({
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
    });

    const parsed: unknown = JSON.parse(
      must(toOllamaMessage(row, { maxToolResultChars: 300 }), "toOllamaMessage result").content,
    );
    expect(valueAt(parsed, "ok")).toBe(false);
    expect(valueAt(parsed, "meta")).toEqual({ renderAs: "table", total: 100 });
    expect(valueAt(parsed, "error")).toEqual({
      code: "PARTIAL",
      message: "Some rows unavailable",
    });
    expect(valueAt(parsed, "data")).toMatchObject({ truncated: true });
    expect(Number(valueAt(parsed, "data", "originalCharacters"))).toBeGreaterThan(
      Number(valueAt(parsed, "data", "preview", "length")),
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
    const parsed: unknown = JSON.parse(serialized);
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
      expect(() => {
        JSON.parse(serialized);
      }).not.toThrow();
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
    expect(must(messages[0], "messages[0]").role).toBe("system");
    expect(must(messages[0], "messages[0]").content).toContain("getSpendByCategory");
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
    const messages = buildChatMessages(
      partial<BuildChatMessagesArgs>({
        toolNames: [],
        history: [],
      }),
    );
    expect(messages).toHaveLength(1);
    expect(must(messages[0], "messages[0]").role).toBe("system");
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
    const history = partial<AiMessageRow[]>([
      { role: "user", content: "first q" },
      { role: "assistant", content: "first a" },
    ]);
    const messages = buildChatMessages({
      toolNames: ["x"],
      history,
      userInput: "second q",
    });
    expect(messages).toHaveLength(4);
    expect(must(messages[0], "messages[0]").role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "first q" });
    expect(messages[2]).toEqual({ role: "assistant", content: "first a" });
    expect(messages[3]).toEqual({ role: "user", content: "second q" });
  });

  it("trims history to the last maxHistoryMessages rows", () => {
    const history = partial<AiMessageRow[]>(
      Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg-${i}`,
      })),
    );
    const messages = buildChatMessages({
      toolNames: [],
      history,
      userInput: "latest",
      maxHistoryMessages: 5,
    });
    const historyMessages = messages.slice(1, -1);
    expect(historyMessages).toHaveLength(5);
    expect(must(historyMessages[0], "historyMessages[0]").content).toBe("msg-45");
    expect(must(historyMessages[4], "historyMessages[4]").content).toBe("msg-49");
  });

  it("defaults maxHistoryMessages to 30", () => {
    const history = partial<AiMessageRow[]>(
      Array.from({ length: 40 }, (_, i) => ({
        role: "user",
        content: `msg-${i}`,
      })),
    );
    const messages = buildChatMessages({
      toolNames: [],
      history,
      userInput: "latest",
    });
    const historyMessages = messages.slice(1, -1);
    expect(historyMessages).toHaveLength(30);
    expect(must(historyMessages[0], "historyMessages[0]").content).toBe("msg-10");
    expect(must(historyMessages[29], "historyMessages[29]").content).toBe("msg-39");
  });

  it("walks history newest-first under the context budget", () => {
    const history = partial<AiMessageRow[]>([
      { role: "user", content: `old-${"a".repeat(75)}` },
      { role: "assistant", content: `middle-${"b".repeat(75)}` },
      { role: "user", content: `newest-${"c".repeat(75)}` },
    ]);
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
      history: partial<AiMessageRow[]>([
        { role: "assistant", content: `prefix-${"z".repeat(500)}` },
      ]),
      userInput: "latest",
      contextBudgetChars: buildSystemPrompt([]).length + 60,
    });

    const historyMessage = must(messages[1], "messages[1]");
    expect(historyMessage.role).toBe("assistant");
    expect(historyMessage.content).toMatch(/^…/);
    expect(historyMessage.content.endsWith("z".repeat(10))).toBe(true);
    expect(historyMessage.content.length).toBeLessThanOrEqual(54);
    expect(messages.at(-1)).toEqual({ role: "user", content: "latest" });
  });

  it("skips null rows returned from mapper", () => {
    // Deliberately includes a null row and a role-less row for the mapper to skip.
    const history = loose<AiMessageRow[]>([
      { role: "user", content: "hi" },
      null,
      { role: "assistant", content: "hey" },
      { content: "no role" },
    ]);
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
    const history = partial<AiMessageRow[]>([
      { role: "user", content: "show spend" },
      {
        role: "tool",
        toolName: "getSpendByCategory",
        toolResult: { ok: true, data: [{ category: "Food", total: 100 }] },
      },
    ]);
    const messages = buildChatMessages({
      toolNames: ["getSpendByCategory"],
      history,
      userInput: "thanks",
    });
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(must(toolMsg, "toolMsg").name).toBe("getSpendByCategory");
    const toolBody: unknown = JSON.parse(must(toolMsg, "toolMsg").content);
    expect(valueAt(toolBody, "data", 0, "category")).toBe("Food");
  });

  it("handles empty history with no user input (system-only)", () => {
    const messages = buildChatMessages(
      partial<BuildChatMessagesArgs>({ toolNames: ["x"] }),
    );
    expect(messages).toHaveLength(1);
    expect(must(messages[0], "messages[0]").role).toBe("system");
  });
});

describe("serializeToolResultForPrompt leaner output", () => {
  const serialize = (payload: unknown): unknown =>
    JSON.parse(serializeToolResultForPrompt(payload));

  it("drops null, undefined and empty-string object fields, at any depth", () => {
    expect(
      serialize({
        ok: true,
        data: [
          { category: "Food", note: "", parent: null, extra: undefined, n: 0 },
          { category: null, flags: [null, "", false] },
        ],
      }),
    ).toEqual({
      ok: true,
      data: [{ category: "Food", n: 0 }, { flags: [null, "", false] }],
    });
  });

  it("rounds numbers beyond four decimals and leaves the rest exact", () => {
    expect(
      valueAt(
        serialize({
          data: [
            { a: 12.345678, b: 1234.5, c: 0.1234, d: 7, e: -2.00006, f: 99.99 },
          ],
        }),
        "data",
        0,
      ),
    ).toEqual({ a: 12.3457, b: 1234.5, c: 0.1234, d: 7, e: -2.0001, f: 99.99 });
  });

  it("keeps four significant digits on numbers below 1", () => {
    expect(
      valueAt(
        serialize({ data: [{ btc: 0.000123456, rate: 0.0325 }] }),
        "data",
        0,
      ),
    ).toEqual({ btc: 0.0001235, rate: 0.0325 });
  });

  it("keeps meta.renderAs and drops chart column bindings", () => {
    const parsed = serialize({
      ok: true,
      data: [],
      meta: {
        renderAs: "bar",
        currency: "EUR",
        xField: "category",
        yField: "total",
        yFields: ["a"],
        labelField: "name",
        valueField: "marketValue",
        from: "2025-01-01",
      },
    });
    expect(valueAt(parsed, "meta")).toEqual({
      renderAs: "bar",
      currency: "EUR",
      from: "2025-01-01",
    });
  });

  it("does not mutate the persisted payload", () => {
    const payload = { ok: true, data: { x: null, y: 1.123456 } };
    serializeToolResultForPrompt(payload);
    expect(payload).toEqual({ ok: true, data: { x: null, y: 1.123456 } });
  });

  it("falls back to the raw payload when it cannot be compacted", () => {
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    expect(JSON.parse(serializeToolResultForPrompt(cyclic))).toMatchObject({
      ok: false,
      error: { code: "SERIALIZATION_ERROR" },
    });
  });
});

describe("buildChatMessages stable history start", () => {
  const ROW = 100;
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      partial<AiMessageRow>({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `row-${String(index).padStart(3, "0")}-${"x".repeat(ROW - 8)}`,
      }),
    );
  const replayed = (
    count: number,
    extra: Partial<BuildChatMessagesArgs> = {},
  ) =>
    buildChatMessages({
      toolNames: [],
      history: rows(count),
      userInput: "q",
      maxHistoryMessages: 20,
      historyStep: HISTORY_REPLAY_STEP,
      ...extra,
    }).slice(1, -1);
  const firstIndex = (messages: { content: string }[]) =>
    Number(messages[0]?.content.slice(4, 7));

  it("keeps the first replayed row until the next step boundary", () => {
    const starts = Array.from({ length: 40 }, (_, i) => i + 21).map((count) =>
      firstIndex(replayed(count)),
    );
    // 21 rows -> window starts at index 1 -> first multiple of 8 is 8.
    expect(starts.slice(0, 8)).toEqual(Array(8).fill(8));
    expect(new Set(starts).size).toBeLessThanOrEqual(6);
    for (const start of starts) expect(start % HISTORY_REPLAY_STEP).toBe(0);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("never replays more than maxHistoryMessages", () => {
    for (let count = 1; count < 70; count += 1) {
      expect(replayed(count).length).toBeLessThanOrEqual(20);
    }
  });

  it("never exceeds the budget and moves on in whole steps when it binds", () => {
    const system = buildSystemPrompt([]).length;
    const budget = system + 1 + 10 * ROW;
    const starts: number[] = [];
    for (let count = 12; count < 60; count += 1) {
      const messages = replayed(count, {
        contextBudgetChars: budget,
        maxHistoryMessages: 30,
      });
      const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
      expect(chars + system + 1).toBeLessThanOrEqual(budget);
      starts.push(firstIndex(messages));
    }
    expect(new Set(starts).size).toBeLessThan(starts.length / 3);
    for (const start of starts) expect(start % HISTORY_REPLAY_STEP).toBe(0);
  });

  it("still truncates the newest row when nothing else fits", () => {
    const messages = buildChatMessages({
      toolNames: [],
      history: partial<AiMessageRow[]>([
        { role: "assistant", content: `prefix-${"z".repeat(500)}` },
      ]),
      userInput: "latest",
      contextBudgetChars: buildSystemPrompt([]).length + 60,
      historyStep: HISTORY_REPLAY_STEP,
    });
    expect(messages[1]?.content).toMatch(/^…/);
  });

  it("falls back to the newest rows that fit when no aligned start does", () => {
    const system = buildSystemPrompt([]).length;
    const messages = replayed(19, {
      contextBudgetChars: system + 1 + 2 * ROW,
    });
    // Aligned starts are 8 and 16 (rows 16..18 = 3 rows) and 17 does not exist.
    expect(messages.map((m) => firstIndex([m]))).toEqual([17, 18]);
  });

  it("replays the newest rows that fit with a step of 1", () => {
    const messages = replayed(25, {
      historyStep: 1,
      maxHistoryMessages: 30,
      contextBudgetChars: buildSystemPrompt([]).length + 1 + 3 * ROW,
    });
    expect(messages.map((m) => firstIndex([m]))).toEqual([22, 23, 24]);
  });
});
