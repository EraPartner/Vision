import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { executeBrokerRequest } from "../src/integrations/openai/egress-helper.mjs";
import {
  callOpenAiBroker,
  __seatbeltProfile,
} from "../src/integrations/openai/brokerClient.js";

describe("OpenAI egress helper contract", () => {
  it("uses only Responses API with storage, hosted tools, background, and redirects disabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "resp_synthetic",
        output_text: "{}",
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    });
    await executeBrokerRequest(
      {
        body: JSON.stringify({
          model: "synthetic-model",
          input: "public",
          store: false,
          background: false,
          tools: [],
          max_output_tokens: 64,
        }),
        timeoutMs: 60000,
      },
      { fetchImpl, apiKey: "synthetic-key" },
    );
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(options.redirect).toBe("error");
    expect(JSON.parse(options.body)).toEqual({
      model: "synthetic-model",
      input: "public",
      store: false,
      background: false,
      tools: [],
      max_output_tokens: 64,
    });
  });
  it("does not change destinations or fall back on a provider error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await expect(
      executeBrokerRequest(
        {
          body: JSON.stringify({
            model: "x",
            input: "x",
            store: false,
            background: false,
            tools: [],
            max_output_tokens: 64,
          }),
          timeoutMs: 1000,
        },
        { fetchImpl, apiKey: "synthetic" },
      ),
    ).resolves.toEqual({ ok: false, code: "HTTP_429", requestId: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("extracts text from the raw Responses API output structure", async () => {
    const response = await executeBrokerRequest(
      {
        body: JSON.stringify({
          model: "synthetic-model",
          input: "selected evidence",
          store: false,
          background: false,
          tools: [],
          max_output_tokens: 64,
        }),
        timeoutMs: 1000,
      },
      {
        apiKey: "synthetic",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            id: "resp_synthetic",
            output: [
              {
                content: [{ type: "output_text", text: '{"schemaVersion":1}' }],
              },
            ],
          }),
        }),
      },
    );
    expect(response.outputText).toBe('{"schemaVersion":1}');
  });

  it("rejects oversized provider responses before buffering them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(9 * 1024 * 1024) },
      json: async () => ({}),
    });
    await expect(
      executeBrokerRequest(
        {
          body: JSON.stringify({
            model: "x",
            input: "x",
            store: false,
            background: false,
            tools: [],
            max_output_tokens: 64,
          }),
          timeoutMs: 1000,
        },
        { fetchImpl, apiKey: "synthetic" },
      ),
    ).resolves.toEqual({ ok: false, code: "RESPONSE_TOO_LARGE" });
  });

  it("rejects unbounded or policy-expanding helper input before fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeBrokerRequest(
        {
          body: JSON.stringify({
            model: "x",
            input: "x",
            store: false,
            background: false,
            tools: [{ type: "web_search" }],
            max_output_tokens: 64,
          }),
          timeoutMs: 1000,
        },
        { fetchImpl, apiKey: "synthetic" },
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_BROKER_POLICY" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses a default-deny profile without broad application-file reads", () => {
    const profile = __seatbeltProfile(
      "/opt/homebrew/Cellar/node/1/bin/node",
      "/app/egress-helper.mjs",
      "/private/tmp/empty",
      ["/opt/homebrew/Cellar/node/1", "/opt/homebrew/Cellar/llhttp/1"],
    );
    expect(profile).toContain("(deny default)");
    expect(profile).toContain('(subpath "/opt/homebrew/Cellar/node/1")');
    expect(profile).toContain('(subpath "/opt/homebrew/Cellar/llhttp/1")');
    expect(profile).not.toContain('(subpath "/opt/homebrew/Cellar")');
    expect(profile).toContain("file-map-executable");
    expect(profile).toContain('(literal "/")');
    expect(profile).toContain(
      '(literal "/opt/homebrew/etc/openssl@3/openssl.cnf")',
    );
    expect(profile).toContain('(allow file-read-metadata (literal "/app"))');
    expect(profile).not.toContain("/Users/");
    expect(profile).not.toContain("(allow file-read-metadata)\n");
    const packagedProfile = __seatbeltProfile(
      "/Applications/Vision.app/Contents/Resources/native/vision-backend",
      "/Applications/Vision.app/Contents/Resources/egress-helper.mjs",
    );
    expect(packagedProfile).not.toContain("/opt/homebrew/Cellar");
  });

  it("starts the helper with an empty working directory and only the API key", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-key";
    const spawnImpl = vi.fn((runtime, args, options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ ok: true, outputText: "{}" }));
        child.emit("close", 0);
      });
      expect(options.env).toEqual({ OPENAI_API_KEY: "synthetic-key" });
      expect(options.cwd).toContain("vision-openai-egress-");
      expect(options.stdio).toEqual(["pipe", "pipe", "ignore"]);
      expect(runtime).toBe("/usr/bin/sandbox-exec");
      expect(args[0]).toBe("-p");
      expect(args[1]).toContain("(deny default)");
      expect(args.at(-1)).toMatch(/egress-helper\.mjs$/);
      return child;
    });
    try {
      await expect(
        callOpenAiBroker({ body: "{}" }, { spawnImpl, platform: "darwin" }),
      ).resolves.toMatchObject({ ok: true });
      expect(spawnImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("reports a sandbox process failure without parsing empty output", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-key";
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => child.emit("close", 71, null));
      return child;
    });
    try {
      await expect(
        callOpenAiBroker({ body: "{}" }, { spawnImpl, platform: "darwin" }),
      ).rejects.toMatchObject({
        code: "BROKER_PROCESS_FAILED",
        exitCode: 71,
      });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("preserves a structured pre-send rejection from the helper", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-key";
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.end(
          JSON.stringify({ ok: false, code: "INVALID_BROKER_INPUT" }),
        );
        child.emit("close", 2, null);
      });
      return child;
    });
    try {
      await expect(
        callOpenAiBroker({ body: "{" }, { spawnImpl, platform: "darwin" }),
      ).resolves.toEqual({ ok: false, code: "INVALID_BROKER_INPUT" });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("does not launch a helper for an already cancelled parent request", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-key";
    const controller = new AbortController();
    controller.abort();
    const spawnImpl = vi.fn();
    try {
      await expect(
        callOpenAiBroker(
          { body: "{}" },
          { spawnImpl, platform: "darwin", signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: "ABORTED" });
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("terminates a running helper when the parent cancels", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-key";
    const controller = new AbortController();
    let child;
    const spawnImpl = vi.fn(() => {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      });
      return child;
    });
    try {
      const pending = callOpenAiBroker(
        { body: "{}" },
        { spawnImpl, platform: "darwin", signal: controller.signal },
      );
      await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});
