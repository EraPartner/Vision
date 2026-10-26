import { describe, expect, it, vi } from "vitest";

import {
  APPLE_FOUNDATION_MODEL,
  withAppleFoundation,
} from "../src/integrations/ollama/appleFoundation.ts";
import { __createOllamaClient as createOllamaClient } from "../src/integrations/ollama/client.ts";
import { loose } from "./helpers/partial.ts";

/** The slice of a Response the client reads (see FetchedResponse in client.ts). */
function jsonResponse(payload: string) {
  return { ok: true, status: 200, text: () => Promise.resolve(payload) };
}

function streamResponse(body: string) {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
    body: {
      getReader: () => ({
        read: () => {
          if (sent) return Promise.resolve({ done: true as const });
          sent = true;
          return Promise.resolve({ done: false as const, value: bytes });
        },
        cancel: () => Promise.resolve(),
        releaseLock: () => {},
      }),
    },
  };
}

function clientFor(response: unknown) {
  return createOllamaClient({
    baseUrl: "http://localhost:11434",
    requestTimeoutMs: 1000,
    healthTimeoutMs: 500,
    // Response-like stub, not a real Response.
    fetchImpl: loose<typeof fetch>(vi.fn().mockResolvedValue(response)),
  });
}

const messages = [{ role: "user", content: "hi" }];

describe("ollama client: third-party JSON that is not the expected shape", () => {
  describe("chatStream", () => {
    it("skips NDJSON lines that are valid JSON but not objects", async () => {
      const body = [
        "null",
        "42",
        '"text"',
        "[1,2]",
        "true",
        JSON.stringify({ message: { content: "hello" }, done: false }),
        "null",
        JSON.stringify({ model: "m1", done: true, done_reason: "stop" }),
      ].join("\n");

      const result = await clientFor(streamResponse(`${body}\n`)).chatStream({
        messages,
      });

      expect(result).toMatchObject({
        content: "hello",
        done: true,
        doneReason: "stop",
        model: "m1",
      });
    });

    it("still reports a malformed NDJSON line as INVALID_JSON", async () => {
      const body = `null\n{not json}\n`;

      await expect(
        clientFor(streamResponse(body)).chatStream({ messages }),
      ).rejects.toMatchObject({ code: "INVALID_JSON" });
    });

    it("still reports a provider error chunk as PROVIDER_ERROR", async () => {
      const body = `${JSON.stringify({ error: "model not found" })}\n`;

      await expect(
        clientFor(streamResponse(body)).chatStream({ messages }),
      ).rejects.toMatchObject({
        code: "PROVIDER_ERROR",
        message: "model not found",
      });
    });

    it("ignores chunk fields of the wrong type and keeps usable tool calls", async () => {
      const body = [
        {
          model: 7,
          message: {
            content: 12,
            tool_calls: [
              { function: { name: "getBalance" } },
              "junk",
              null,
              { id: "c2", function: { name: "getTotals", arguments: { a: 1 } } },
            ],
          },
          done: "yes",
        },
        { done: true, eval_count: "many", total_duration: 2_000_000 },
      ]
        .map((chunk) => JSON.stringify(chunk))
        .join("\n");

      const result = await clientFor(streamResponse(`${body}\n`)).chatStream({
        model: "fallback-model",
        messages,
      });

      expect(result).toMatchObject({
        model: "fallback-model",
        content: "",
        done: true,
        evalCount: null,
        totalDurationMs: 2,
      });
      expect(result.toolCalls).toEqual([
        { function: { name: "getBalance" } },
        // "junk" and null both read as null; identical calls are deduped.
        null,
        { id: "c2", function: { name: "getTotals", arguments: { a: 1 } } },
      ]);
    });
  });

  describe("non-streaming requests", () => {
    it("treats a non-object chat body like an empty one", async () => {
      for (const payload of ["null", "[]", "7", '"x"']) {
        const result = await clientFor(jsonResponse(payload)).chat({
          model: "m",
          messages,
        });
        expect(result).toMatchObject({
          model: "m",
          role: "assistant",
          content: "",
          toolCalls: [],
          done: true,
        });
      }
    });

    it("skips model entries that are not objects", async () => {
      const client = clientFor(
        jsonResponse(
          JSON.stringify({
            models: [null, 3, { name: "good", size: 5, details: "odd" }],
          }),
        ),
      );

      expect(await client.listModels()).toEqual([
        {
          name: "good",
          size: 5,
          family: null,
          parameterSize: null,
          quantization: null,
          modifiedAt: null,
        },
      ]);
    });

    it("reports a models list that is not an array as empty", async () => {
      const client = clientFor(jsonResponse('{"models":"nope"}'));

      expect(await client.healthCheck()).toMatchObject({
        reachable: true,
        modelCount: 0,
      });
    });

    it("rejects embeddings that are not arrays of numbers", async () => {
      for (const embeddings of [[["1", "2"]], [[1, null]], "x", [[]]]) {
        const client = clientFor(jsonResponse(JSON.stringify({ embeddings })));

        await expect(client.embed({ model: "e", input: "a" })).rejects.toMatchObject({
          code: "INVALID_EMBEDDING_RESPONSE",
        });
      }
    });

    it("returns null model info when /api/show model_info is not an object", async () => {
      const client = clientFor(jsonResponse('{"model_info":[1]}'));

      expect(await client.showModel("m")).toBeNull();
    });
  });
});

describe("Apple Foundation helper shim: request bodies that are not the expected shape", () => {
  it("passes a non-object chat body through to Ollama", async () => {
    const base = vi.fn().mockResolvedValue(new Response("{}"));
    const wrapped = withAppleFoundation(base);

    await wrapped("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      body: "null",
    });

    expect(base).toHaveBeenCalledOnce();
  });

  it("does not run the helper for other models with odd message entries", async () => {
    const base = vi.fn().mockResolvedValue(new Response("{}"));
    const wrapped = withAppleFoundation(base);

    await wrapped("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      body: JSON.stringify({ model: "llama3", messages: [null, 5] }),
    });

    expect(base).toHaveBeenCalledOnce();
  });

  it("still answers an Apple chat with 503 when messages are junk", async () => {
    const base = vi.fn();
    const wrapped = withAppleFoundation(base);

    const response = await wrapped("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      body: JSON.stringify({
        model: APPLE_FOUNDATION_MODEL,
        messages: "junk",
        tools: [null],
      }),
    });

    expect(response.status).toBe(503);
    expect(base).not.toHaveBeenCalled();
  });
});
