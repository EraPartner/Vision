// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";

import {
  getOllamaStatus,
  getOllamaModels,
  getConversations,
  getConversation,
  createConversation,
  renameConversation,
  deleteConversation,
  sendChatMessage,
  streamChat,
} from "@/lib/api/ai";

const API_BASE = "http://localhost:3002";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data });
}

afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});

describe("ai conversation API client", () => {
  it("getOllamaStatus fetches status", async () => {
    server.use(http.get(`${API_BASE}/api/ai/status`, () => ok({ ok: true, baseUrl: "x", defaultModel: "m", enabled: true })));
    expect((await getOllamaStatus()).ok).toBe(true);
  });

  it("getOllamaModels returns the models array", async () => {
    server.use(
      http.get(`${API_BASE}/api/ai/models`, () => ok({ models: [{ name: "llama3" }] })),
    );
    const models = await getOllamaModels();
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe("llama3");
  });

  it("getOllamaModels defaults to [] when models is absent", async () => {
    server.use(http.get(`${API_BASE}/api/ai/models`, () => ok({})));
    expect(await getOllamaModels()).toEqual([]);
  });

  it("getConversations returns summaries", async () => {
    server.use(http.get(`${API_BASE}/api/ai/conversations`, () => ok([{ id: "a" }])));
    expect((await getConversations())[0].id).toBe("a");
  });

  it("getConversation URL-encodes the id", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/ai/conversations/:id`, ({ request }) => {
        url = request.url;
        return ok({ conversation: { id: "a b" }, messages: [] });
      }),
    );
    await getConversation("a b");
    expect(url).toContain("a%20b");
  });

  it("createConversation POSTs the body", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/ai/conversations`, async ({ request }) => {
        body = await request.json();
        return ok({ conversation: { id: "new" }, messages: [] });
      }),
    );
    const res = await createConversation({ title: "Hello" });
    expect(body).toMatchObject({ title: "Hello" });
    expect(res.conversation.id).toBe("new");
  });

  it("renameConversation PATCHes the title", async () => {
    let body: unknown = null;
    server.use(
      http.patch(`${API_BASE}/api/ai/conversations/:id`, async ({ request }) => {
        body = await request.json();
        return ok({ id: "x", title: "Renamed" });
      }),
    );
    await renameConversation("x", "Renamed");
    expect(body).toMatchObject({ title: "Renamed" });
  });

  it("deleteConversation resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/ai/conversations/:id`, () => ok(null)));
    await expect(deleteConversation("x")).resolves.toBeUndefined();
  });

  it("sendChatMessage POSTs to the chat route", async () => {
    server.use(
      http.post(`${API_BASE}/api/ai/chat`, () =>
        ok({ assistantMessage: { role: "assistant", content: "hi" } }),
      ),
    );
    const res = await sendChatMessage({ message: "hi", conversationId: "c" } as never);
    expect(res.assistantMessage.role).toBe("assistant");
  });
});

// ---------------------------------------------------------------------------
// streamChat — SSE block parsing + terminal event handling
// ---------------------------------------------------------------------------

/** Build a Response whose body streams `text` as a single chunk. */
function sseResponse(text: string, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("streamChat SSE handling", () => {
  it("parses token, user_message, tool_call, tool_result and done events", async () => {
    const wire = [
      "event: user_message\ndata: {\"message\":{\"role\":\"user\",\"content\":\"hi\"}}",
      'event: token\ndata: "Hel"',
      'event: token\ndata: "lo"',
      'event: tool_call\ndata: {"name":"search","args":{"q":"x"}}',
      'event: tool_result\ndata: {"message":{"role":"tool","content":"ok"}}',
      'event: done\ndata: {"finishReason":"stop"}',
    ].join("\n\n") + "\n\n";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(wire)));

    const events: string[] = [];
    const { result } = streamChat({ message: "hi" } as never, (e) => events.push(e.type));
    const terminal = await result;

    expect(events).toEqual([
      "user_message",
      "token",
      "token",
      "tool_call",
      "tool_result",
      "done",
    ]);
    expect(terminal.type).toBe("done");
  });

  it("decodes a non-JSON token payload as a raw string", async () => {
    const wire = "event: token\ndata: plain text token\n\nevent: done\ndata: {}\n\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(wire)));

    const captured: Array<{ type: string; delta?: string }> = [];
    const { result } = streamChat({ message: "hi" } as never, (e) =>
      captured.push(e as { type: string; delta?: string }),
    );
    await result;

    const tokenEvent = captured.find((e) => e.type === "token");
    expect(tokenEvent?.delta).toBe("plain text token");
  });

  it("throws with the detail from a terminal error event", async () => {
    const wire = 'event: error\ndata: {"detail":"model unavailable","code":"E_MODEL"}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(wire)));

    const { result } = streamChat({ message: "hi" } as never, () => {});
    await expect(result).rejects.toThrow("model unavailable");
  });

  it("throws when the stream ends without a terminal event", async () => {
    const wire = 'event: token\ndata: "partial"\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(wire)));

    const { result } = streamChat({ message: "hi" } as never, () => {});
    await expect(result).rejects.toThrow(/Stream ended without terminal event/);
  });

  it("throws when the response is not ok", async () => {
    server.use(
      http.post(`${API_BASE}/api/ai/chat/stream`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );
    const { result } = streamChat({ message: "hi" } as never, () => {});
    await expect(result).rejects.toBeTruthy();
  });
});
