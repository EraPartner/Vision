import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OllamaError,
  __createOllamaClient as createOllamaClient,
} from "../src/integrations/ollama/client.js";

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

function errorResponse(status, text = "") {
  return {
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(text),
  };
}

function streamResponse(chunks, { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) =>
    chunk instanceof Uint8Array ? chunk : encoder.encode(chunk),
  );
  let i = 0;
  const reader = {
    read: vi.fn(async () => {
      if (i >= encoded.length) return { value: undefined, done: true };
      const value = encoded[i];
      i += 1;
      return { value, done: false };
    }),
    releaseLock: vi.fn(),
  };
  return {
    ok,
    status,
    body: { getReader: () => reader },
    text: vi.fn().mockResolvedValue(""),
    _reader: reader,
  };
}

function ndjson(...objs) {
  return objs.map((o) => `${JSON.stringify(o)}\n`).join("");
}

function makeClient(fetchImpl, overrides = {}) {
  return createOllamaClient({
    baseUrl: "http://localhost:11434",
    requestTimeoutMs: 1000,
    healthTimeoutMs: 500,
    fetchImpl,
    ...overrides,
  });
}

describe("ollama client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("healthCheck", () => {
    it("reports reachable and model count when API responds", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ models: [{ name: "a" }, { name: "b" }] }),
        );
      const client = makeClient(fetchImpl);

      const result = await client.healthCheck();

      expect(result).toEqual({
        reachable: true,
        baseUrl: "http://localhost:11434",
        modelCount: 2,
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        "http://localhost:11434/api/tags",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("reports unreachable on network failure", async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const client = makeClient(fetchImpl);

      const result = await client.healthCheck();

      expect(result.reachable).toBe(false);
      expect(result.code).toBe("NETWORK_ERROR");
      expect(result.error).toMatch(/ECONNREFUSED/);
    });

    it("reports unreachable on HTTP error status", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(errorResponse(500, "boom"));
      const client = makeClient(fetchImpl);

      const result = await client.healthCheck();

      expect(result.reachable).toBe(false);
      expect(result.code).toBe("HTTP_ERROR");
    });
  });

  describe("listModels", () => {
    it("normalises model metadata", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          models: [
            {
              name: "llama3.1:8b",
              size: 4_700_000_000,
              modified_at: "2026-04-01T10:00:00Z",
              details: {
                family: "llama",
                parameter_size: "8B",
                quantization_level: "Q4_K_M",
              },
            },
          ],
        }),
      );
      const client = makeClient(fetchImpl);

      const models = await client.listModels();

      expect(models).toEqual([
        {
          name: "llama3.1:8b",
          size: 4_700_000_000,
          family: "llama",
          parameterSize: "8B",
          quantization: "Q4_K_M",
          modifiedAt: "2026-04-01T10:00:00Z",
        },
      ]);
    });

    it("returns empty array when no models installed", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ models: [] }));
      const client = makeClient(fetchImpl);

      expect(await client.listModels()).toEqual([]);
    });

    it("throws OllamaError on HTTP failure", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(errorResponse(404));
      const client = makeClient(fetchImpl);

      await expect(client.listModels()).rejects.toBeInstanceOf(OllamaError);
    });
  });

  describe("chat", () => {
    it("posts messages and shapes the response", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          model: "llama3.1:8b",
          message: { role: "assistant", content: "hi there" },
          done: true,
          done_reason: "stop",
          eval_count: 42,
          prompt_eval_count: 10,
          total_duration: 1_200_000_000,
        }),
      );
      const client = makeClient(fetchImpl);

      const res = await client.chat({
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "hello" }],
      });

      expect(res).toMatchObject({
        model: "llama3.1:8b",
        role: "assistant",
        content: "hi there",
        toolCalls: [],
        done: true,
        doneReason: "stop",
        evalCount: 42,
        promptEvalCount: 10,
        totalDurationMs: 1200,
      });

      const [, init] = fetchImpl.mock.calls[0];
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
    });

    it("includes tools and model options in request body when provided", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: { role: "assistant", content: "" } }),
        );
      const client = makeClient(fetchImpl);
      const tools = [
        { type: "function", function: { name: "getSpend", parameters: {} } },
      ];

      await client.chat({
        messages: [{ role: "user", content: "go" }],
        tools,
        options: { num_ctx: 8192 },
      });

      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(body.tools).toEqual(tools);
      expect(body.options).toEqual({ num_ctx: 8192 });
    });

    it("surfaces tool_calls from the model", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "getSpendByCategory",
                  arguments: { from: "2025-01-01", to: "2025-12-31" },
                },
              },
            ],
          },
        }),
      );
      const client = makeClient(fetchImpl);

      const res = await client.chat({
        messages: [{ role: "user", content: "biggest category?" }],
      });

      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0].function.name).toBe("getSpendByCategory");
    });

    it("rejects empty messages", async () => {
      const fetchImpl = vi.fn();
      const client = makeClient(fetchImpl);

      await expect(client.chat({ messages: [] })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("propagates abort signal from caller", async () => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(
        (url, init) =>
          new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const client = makeClient(fetchImpl);

      const promise = client.chat({
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      });
      controller.abort();

      await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
    });
  });

  describe("chatStream", () => {
    it("accumulates content deltas and invokes onToken for each non-empty delta", async () => {
      const body = ndjson(
        {
          model: "llama3.1:8b",
          message: { role: "assistant", content: "Hel" },
          done: false,
        },
        { message: { role: "assistant", content: "lo " }, done: false },
        { message: { role: "assistant", content: "world" }, done: false },
        {
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          eval_count: 7,
          prompt_eval_count: 3,
          total_duration: 2_500_000_000,
        },
      );
      const fetchImpl = vi.fn().mockResolvedValue(streamResponse([body]));
      const client = makeClient(fetchImpl);
      const tokens = [];

      const res = await client.chatStream({
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "hi" }],
        onToken: (t) => tokens.push(t),
      });

      expect(tokens).toEqual(["Hel", "lo ", "world"]);
      expect(res).toMatchObject({
        model: "llama3.1:8b",
        role: "assistant",
        content: "Hello world",
        toolCalls: [],
        done: true,
        doneReason: "stop",
        evalCount: 7,
        promptEvalCount: 3,
        totalDurationMs: 2500,
      });

      const [, init] = fetchImpl.mock.calls[0];
      const sent = JSON.parse(init.body);
      expect(sent.stream).toBe(true);
      expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
    });

    it("handles chunks that split NDJSON lines across reads", async () => {
      const line1 = JSON.stringify({
        message: { content: "foo" },
        done: false,
      });
      const line2 = JSON.stringify({ message: { content: "bar" }, done: true });
      const full = `${line1}\n${line2}\n`;
      const chunks = [full.slice(0, 10), full.slice(10, 30), full.slice(30)];
      const fetchImpl = vi.fn().mockResolvedValue(streamResponse(chunks));
      const client = makeClient(fetchImpl);
      const tokens = [];

      const res = await client.chatStream({
        messages: [{ role: "user", content: "x" }],
        onToken: (t) => tokens.push(t),
      });

      expect(tokens).toEqual(["foo", "bar"]);
      expect(res.content).toBe("foobar");
      expect(res.done).toBe(true);
    });

    it("processes a trailing line that lacks a final newline", async () => {
      const body =
        `${JSON.stringify({ message: { content: "a" }, done: false })}\n` +
        `${JSON.stringify({ message: { content: "b" }, done: true })}`;
      const fetchImpl = vi.fn().mockResolvedValue(streamResponse([body]));
      const client = makeClient(fetchImpl);

      const res = await client.chatStream({
        messages: [{ role: "user", content: "x" }],
      });

      expect(res.content).toBe("ab");
      expect(res.done).toBe(true);
    });

    it("surfaces tool_calls from the final streamed chunk", async () => {
      const body = ndjson(
        { message: { content: "" }, done: false },
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "getSpendByCategory",
                  arguments: { from: "2025-01-01", to: "2025-12-31" },
                },
              },
            ],
          },
          done: true,
          done_reason: "tool_calls",
        },
      );
      const fetchImpl = vi.fn().mockResolvedValue(streamResponse([body]));
      const client = makeClient(fetchImpl);

      const res = await client.chatStream({
        messages: [{ role: "user", content: "biggest?" }],
      });

      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0].function.name).toBe("getSpendByCategory");
      expect(res.doneReason).toBe("tool_calls");
    });

    it("accumulates tool_calls spread across multiple chunks", async () => {
      const callA = {
        function: { name: "getSpendByCategory", arguments: { year: 2025 } },
      };
      const callB = {
        function: { name: "getRecipients", arguments: { top: 5 } },
      };
      const body = ndjson(
        { message: { content: "", tool_calls: [callA] }, done: false },
        { message: { content: "", tool_calls: [callB] }, done: false },
        { message: { content: "" }, done: true, done_reason: "tool_calls" },
      );
      const fetchImpl = vi.fn().mockResolvedValue(streamResponse([body]));
      const client = makeClient(fetchImpl);

      const res = await client.chatStream({
        messages: [{ role: "user", content: "spend + recipients?" }],
      });

      expect(res.toolCalls).toHaveLength(2);
      expect(res.toolCalls.map((c) => c.function.name)).toEqual([
        "getSpendByCategory",
        "getRecipients",
      ]);
    });

    it("dedupes tool_calls re-emitted in full on the done chunk", async () => {
      const callA = {
        function: { name: "getSpendByCategory", arguments: { year: 2025 } },
      };
      const callB = {
        function: { name: "getRecipients", arguments: { top: 5 } },
      };
      const body = ndjson(
        { message: { content: "", tool_calls: [callA] }, done: false },
        { message: { content: "", tool_calls: [callB] }, done: false },
        // Some builds repeat the complete list on the final chunk.
        {
          message: { content: "", tool_calls: [callA, callB] },
          done: true,
          done_reason: "tool_calls",
        },
      );
      const fetchImpl = vi.fn().mockResolvedValue(streamResponse([body]));
      const client = makeClient(fetchImpl);

      const res = await client.chatStream({
        messages: [{ role: "user", content: "spend + recipients?" }],
      });

      expect(res.toolCalls).toHaveLength(2);
    });

    it("re-arms the idle window per chunk so long generations outlive requestTimeoutMs", async () => {
      vi.useFakeTimers();
      const encoder = new TextEncoder();
      const chunks = [
        encoder.encode(ndjson({ message: { content: "a" }, done: false })),
        encoder.encode(ndjson({ message: { content: "b" }, done: false })),
        encoder.encode(ndjson({ message: { content: "c" }, done: true })),
      ];
      let i = 0;
      // Each read resolves after 800ms — beyond requestTimeoutMs (1000ms)
      // in TOTAL after a few chunks, but always inside the idle window.
      const reader = {
        read: vi.fn(
          () =>
            new Promise((resolve) => {
              const idx = i;
              i += 1;
              setTimeout(() => {
                if (idx >= chunks.length)
                  resolve({ value: undefined, done: true });
                else resolve({ value: chunks[idx], done: false });
              }, 800);
            }),
        ),
        releaseLock: vi.fn(),
      };
      const response = {
        ok: true,
        status: 200,
        body: { getReader: () => reader },
        text: vi.fn().mockResolvedValue(""),
      };
      const fetchImpl = vi.fn().mockResolvedValue(response);
      const client = makeClient(fetchImpl, { streamIdleTimeoutMs: 1000 });

      const promise = client.chatStream({
        messages: [{ role: "user", content: "go" }],
      });
      // 3 reads × 800ms = 2400ms total > requestTimeoutMs (1000ms); the
      // pre-fix total-budget timer would have aborted mid-stream.
      await vi.advanceTimersByTimeAsync(2600);
      const res = await promise;

      expect(res.content).toBe("abc");
      expect(res.done).toBe(true);
    });

    it("aborts when the stream goes idle past streamIdleTimeoutMs", async () => {
      vi.useFakeTimers();
      const encoder = new TextEncoder();
      const first = encoder.encode(
        ndjson({ message: { content: "a" }, done: false }),
      );
      let callCount = 0;
      let rejectRead;
      const composedSignals = [];
      const reader = {
        read: vi.fn(() => {
          callCount += 1;
          if (callCount === 1)
            return Promise.resolve({ value: first, done: false });
          // Second read never yields data; reject when the client aborts,
          // mirroring how a real body reader fails after signal abort.
          return new Promise((_, reject) => {
            rejectRead = reject;
            composedSignals[0]?.addEventListener(
              "abort",
              () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              },
              { once: true },
            );
          });
        }),
        releaseLock: vi.fn(),
      };
      const response = {
        ok: true,
        status: 200,
        body: { getReader: () => reader },
        text: vi.fn().mockResolvedValue(""),
      };
      const fetchImpl = vi.fn((url, init) => {
        composedSignals.push(init.signal);
        return Promise.resolve(response);
      });
      const client = makeClient(fetchImpl, { streamIdleTimeoutMs: 500 });

      const promise = client.chatStream({
        messages: [{ role: "user", content: "go" }],
      });
      promise.catch(() => {}); // observed below; avoid unhandled-rejection noise under fake timers
      await vi.advanceTimersByTimeAsync(1600);

      await expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(rejectRead).toBeDefined();
    });

    it("includes tools and model options in the request body when provided", async () => {
      const body = ndjson({ message: { content: "" }, done: true });
      const fetchImpl = vi.fn().mockResolvedValue(streamResponse([body]));
      const client = makeClient(fetchImpl);
      const tools = [
        { type: "function", function: { name: "getSpend", parameters: {} } },
      ];

      await client.chatStream({
        messages: [{ role: "user", content: "go" }],
        tools,
        options: { num_ctx: 8192 },
      });

      const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(sent.tools).toEqual(tools);
      expect(sent.options).toEqual({ num_ctx: 8192 });
      expect(sent.stream).toBe(true);
    });

    it("rejects empty messages without calling fetch", async () => {
      const fetchImpl = vi.fn();
      const client = makeClient(fetchImpl);

      await expect(client.chatStream({ messages: [] })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("throws HTTP_ERROR on non-ok response", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({
          ok: false,
          status: 503,
          text: vi.fn().mockResolvedValue(""),
        });
      const client = makeClient(fetchImpl);

      await expect(
        client.chatStream({ messages: [{ role: "user", content: "x" }] }),
      ).rejects.toMatchObject({ code: "HTTP_ERROR", status: 503 });
    });

    it("throws NO_BODY when response has no readable body", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({
          ok: true,
          status: 200,
          body: null,
          text: vi.fn(),
        });
      const client = makeClient(fetchImpl);

      await expect(
        client.chatStream({ messages: [{ role: "user", content: "x" }] }),
      ).rejects.toMatchObject({ code: "NO_BODY" });
    });

    it("throws INVALID_JSON on malformed NDJSON line", async () => {
      const body = `${JSON.stringify({ message: { content: "ok" }, done: false })}\nnot-json-here\n`;
      const fetchImpl = vi.fn().mockResolvedValue(streamResponse([body]));
      const client = makeClient(fetchImpl);

      await expect(
        client.chatStream({ messages: [{ role: "user", content: "x" }] }),
      ).rejects.toMatchObject({ code: "INVALID_JSON" });
    });

    it("maps fetch AbortError to ABORTED", async () => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(
        (url, init) =>
          new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const client = makeClient(fetchImpl);

      const promise = client.chatStream({
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      });
      controller.abort();

      await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
    });

    it("continues after onToken handler throws", async () => {
      const body = ndjson(
        { message: { content: "a" }, done: false },
        { message: { content: "b" }, done: true },
      );
      const fetchImpl = vi.fn().mockResolvedValue(streamResponse([body]));
      const client = makeClient(fetchImpl);

      const res = await client.chatStream({
        messages: [{ role: "user", content: "x" }],
        onToken: () => {
          throw new Error("handler boom");
        },
      });

      expect(res.content).toBe("ab");
      expect(res.done).toBe(true);
    });

    it("ignores empty deltas when invoking onToken", async () => {
      const body = ndjson(
        { message: { content: "" }, done: false },
        { message: { content: "x" }, done: false },
        { message: {}, done: true },
      );
      const fetchImpl = vi.fn().mockResolvedValue(streamResponse([body]));
      const client = makeClient(fetchImpl);
      const tokens = [];

      await client.chatStream({
        messages: [{ role: "user", content: "q" }],
        onToken: (t) => tokens.push(t),
      });

      expect(tokens).toEqual(["x"]);
    });

    it("releases the reader lock after completion", async () => {
      const body = ndjson({ message: { content: "hi" }, done: true });
      const response = streamResponse([body]);
      const fetchImpl = vi.fn().mockResolvedValue(response);
      const client = makeClient(fetchImpl);

      await client.chatStream({ messages: [{ role: "user", content: "x" }] });

      expect(response._reader.releaseLock).toHaveBeenCalled();
    });
  });

  describe("timeouts", () => {
    it("aborts when request exceeds timeout", async () => {
      vi.useFakeTimers();
      const fetchImpl = vi.fn(
        (url, init) =>
          new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const client = makeClient(fetchImpl, { requestTimeoutMs: 50 });

      const promise = client.chat({
        messages: [{ role: "user", content: "hi" }],
      });

      vi.advanceTimersByTime(60);

      await expect(promise).rejects.toBeInstanceOf(OllamaError);
    });
  });
});
