import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/config/config.ts", () => ({
  default: {
    aiChat: {
      enabled: true,
      maxHistoryMessages: 30,
      maxToolRows: 500,
      maxToolResultChars: 4000,
    },
    ollama: { defaultModel: "synthetic", numCtx: 4096 },
  },
}));
vi.mock("../src/repositories/aiChatRepository.ts", () => ({
  aiChatRepository: {
    getConversation: vi.fn(),
    getMessages: vi.fn(),
    createConversation: vi.fn(),
    appendMessage: vi.fn(),
  },
}));
vi.mock("../src/services/aiChat/tools/index.ts", () => ({
  dispatchTool: vi.fn(),
  getToolSchemas: vi.fn().mockReturnValue([]),
  getToolNames: vi.fn().mockReturnValue([]),
}));
import { aiChatRepository } from "../src/repositories/aiChatRepository.ts";
import { dispatchTool } from "../src/services/aiChat/tools/index.ts";
import {
  getConversationWithMessages,
  presentAiToolMessage,
  runChatTurn,
} from "../src/services/aiChatService.ts";
import { partial } from "./helpers/partial.ts";
import type {
  AiChatClient,
  AiMessageRow,
  AiConversationRow,
} from "../src/services/aiChatService.ts";
import type { AiChatServiceEvent } from "@vision/types/aiChat";
const conversation = partial<AiConversationRow>({
  id: "conv-presentation",
  model: "synthetic",
  title: "Synthetic",
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(aiChatRepository.createConversation).mockResolvedValue(
    conversation,
  );
  vi.mocked(aiChatRepository.getConversation).mockResolvedValue(conversation);
  vi.mocked(aiChatRepository.getMessages).mockResolvedValue([]);
  vi.mocked(aiChatRepository.appendMessage).mockImplementation(
    async (input) => {
      const roles: AiMessageRow["role"][] = [
        "user",
        "assistant",
        "tool",
        "system",
      ];
      const statuses: AiMessageRow["status"][] = [
        "complete",
        "streaming",
        "aborted",
        "error",
      ];
      const role = roles.find((role) => role === input.role);
      const status = statuses.find(
        (status) => status === (input.status ?? "complete"),
      );
      if (!role || !status)
        throw new Error("Invalid synthetic message role/status");
      return partial<AiMessageRow>({
        ...input,
        role,
        status,
        id: `${role}-row`,
        createdAt: new Date("2026-10-13T00:00:00Z"),
      });
    },
  );
});
describe("Outgoing AI tool presentation preserves stored data and prompt contracts", () => {
  it("normalizes only the inference view as the real JSON transport does", () => {
    const result = {
      ok: true,
      data: [
        {
          date: new Date("2026-01-01T00:00:00Z"),
          value: Infinity,
          omitted: undefined,
          amount: 2,
        },
      ],
      meta: { renderAs: "pie" },
    };
    const row = { id: "tool", toolResult: result };
    const presented = presentAiToolMessage(row);
    expect(presented.toolResult).toBe(result);
    expect(presented.toolPresentation).toMatchObject({
      columns: ["date", "value", "amount"],
      yKeys: ["amount"],
      rows: [{ date: "2026-01-01T00:00:00.000Z", value: null, amount: 2 }],
      pieRows: [
        {
          name: "2026-01-01T00:00:00.000Z",
          value: 2,
          percent: 1,
          labelPercent: 100,
          startAngle: 0,
          endAngle: 360,
        },
      ],
    });
    expect(result.data[0]?.value).toBe(Infinity);
    expect("toolPresentation" in row).toBe(false);
    expect(presentAiToolMessage({ id: "plain", toolResult: null })).toEqual({
      id: "plain",
      toolResult: null,
    });
  });
  it("enriches old historical JSON results without changing repository rows", async () => {
    const row = partial<AiMessageRow>({
      id: "old",
      role: "tool",
      toolResult: {
        ok: true,
        data: [{ category: "A", spent: 3 }],
        meta: { renderAs: "bar" },
      },
    });
    vi.mocked(aiChatRepository.getMessages).mockResolvedValue([row]);
    const history = await getConversationWithMessages(conversation.id);
    expect(history?.messages[0]).toMatchObject({
      toolPresentation: {
        columns: ["category", "spent"],
        xKey: "category",
        yKeys: ["spent"],
      },
    });
    expect(history?.messages[0]?.toolResult).toBe(row.toolResult);
    expect("toolPresentation" in row).toBe(false);
  });
  it("enriches SSE and ordinary turn results while persistence and provider context remain raw", async () => {
    const result = {
      ok: true,
      data: [{ category: "A", amount: 4 }],
      meta: { renderAs: "pie" as const },
    };
    vi.mocked(dispatchTool).mockResolvedValue({ args: {}, result });
    const chat = vi
      .fn()
      .mockResolvedValue({ content: "Answer", toolCalls: [] });
    const events: AiChatServiceEvent<AiMessageRow>[] = [];
    const turn = await runChatTurn({
      message: "Question",
      preCallTool: "syntheticTool",
      onEvent: (event) => {
        events.push(event);
      },
      ollamaClient: partial<AiChatClient>({ chat }),
    });
    const event = events.find((event) => event.type === "tool_result");
    expect(event).toMatchObject({
      data: {
        message: { toolPresentation: { pieRows: [{ value: 4, percent: 1 }] } },
      },
    });
    expect(turn.toolMessages[0]).toMatchObject({
      toolPresentation: { columns: ["category", "amount"] },
    });
    expect(
      vi
        .mocked(aiChatRepository.appendMessage)
        .mock.calls.find(([input]) => input.role === "tool")?.[0].toolResult,
    ).toBe(result);
    const request = chat.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = request.messages.find(
      (message) => message.role === "tool",
    )?.content;
    expect(prompt).toContain('"amount":4');
    expect(prompt).not.toContain("toolPresentation");
  });
});
