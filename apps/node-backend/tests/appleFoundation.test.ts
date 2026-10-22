import { describe, expect, it, vi } from "vitest";

import {
  __APPLE_FOUNDATION_MODEL as APPLE_FOUNDATION_MODEL,
  __fitForAppleModel as fitForAppleModel,
  withAppleFoundation,
} from "../src/integrations/ollama/appleFoundation.ts";

function tool(name: string, description: string) {
  return { type: "function", function: { name, description, parameters: {} } };
}

describe("fitForAppleModel", () => {
  it("keeps only the tools that match the question", () => {
    const fitted = fitForAppleModel({
      model: APPLE_FOUNDATION_MODEL,
      messages: [
        { role: "user", content: "What were my dividends this year?" },
      ],
      tools: [
        tool("getDividendIncome", "Dividend income received per year."),
        tool("getLoanSchedule", "Loan amortisation schedule."),
        tool("getMonthlySpend", "Total spend per month."),
      ],
    });

    expect(fitted.tools?.map((entry) => entry.function?.name)).toEqual([
      "getDividendIncome",
    ]);
  });

  it("drops tools when nothing matches", () => {
    const fitted = fitForAppleModel({
      messages: [{ role: "user", content: "hello" }],
      tools: [tool("getLoanSchedule", "Loan amortisation schedule.")],
    });

    expect(fitted.tools).toBeUndefined();
  });

  it("keeps the system prompt and the newest messages within budget", () => {
    const long = "x".repeat(1_400);
    const fitted = fitForAppleModel({
      messages: [
        { role: "system", content: "You are Vision." },
        ...Array.from({ length: 6 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `${index} ${long}`,
        })),
        { role: "user", content: "latest" },
      ],
    });

    expect(fitted.messages?.[0]).toEqual({
      role: "system",
      content: "You are Vision.",
    });
    expect(fitted.messages?.at(-1)?.content).toBe("latest");
    const conversationChars = (fitted.messages ?? [])
      .slice(1)
      .reduce((sum, message) => sum + String(message.content).length, 0);
    expect(conversationChars).toBeLessThanOrEqual(4_000);
    expect(fitted.messages?.length).toBeLessThan(8);
  });
});

describe("withAppleFoundation without the helper", () => {
  it("passes Ollama requests through", async () => {
    const base = vi.fn().mockResolvedValue(new Response("{}"));
    const wrapped = withAppleFoundation(base);
    await wrapped("http://127.0.0.1:11434/api/tags");

    expect(base).toHaveBeenCalledOnce();
  });

  it("answers an Apple chat with 503 instead of calling Ollama", async () => {
    const base = vi.fn();
    const wrapped = withAppleFoundation(base);
    const response = await wrapped("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      body: JSON.stringify({
        model: APPLE_FOUNDATION_MODEL,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(503);
    expect(base).not.toHaveBeenCalled();
  });
});
