import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { __createOllamaClient as createOllamaClient } from "../src/integrations/ollama/client.ts";
import {
  APPLE_FOUNDATION_MODEL,
  withAppleFoundation,
} from "../src/integrations/ollama/appleFoundation.ts";

// A stand-in for vision-apple-ai: answers --check, echoes the request's last
// message back as Ollama NDJSON, and fails when asked to.
const fakeHelper = `#!/bin/sh
if [ "$1" = "--check" ]; then echo '{"available":true}'; exit 0; fi
body=$(cat)
case "$body" in
  *'"fail"'*) echo '{"error":"model busy"}'; exit 1 ;;
  *'"stream":true'*)
    echo '{"message":{"role":"assistant","content":"Hel"},"done":false}'
    echo '{"message":{"role":"assistant","content":"lo"},"done":false}'
    echo '{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}' ;;
  *) echo '{"message":{"role":"assistant","content":"Hello"},"done":true}' ;;
esac
`;

let directory = "";
const platform = Object.getOwnPropertyDescriptor(process, "platform");

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "vision-apple-ai-"));
  const helper = path.join(directory, "vision-apple-ai");
  fs.writeFileSync(helper, fakeHelper, { mode: 0o755 });
  vi.stubEnv("APPLE_AI_HELPER", helper);
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterAll(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function client(base = vi.fn<typeof fetch>()) {
  return createOllamaClient({
    baseUrl: "http://127.0.0.1:11434",
    requestTimeoutMs: 5_000,
    fetchImpl: withAppleFoundation(base),
  });
}

const messages = [{ role: "user", content: "hi" }];

describe("Apple model through the helper", () => {
  it("lists the Apple model when Ollama is down", async () => {
    const base = vi.fn<typeof fetch>().mockRejectedValue(new Error("down"));

    const models = await client(base).listModels();

    expect(models.map((model) => model.name)).toEqual([APPLE_FOUNDATION_MODEL]);
  });

  it("answers a chat without calling Ollama", async () => {
    const base = vi.fn<typeof fetch>();

    const reply = await client(base).chat({
      model: APPLE_FOUNDATION_MODEL,
      messages,
    });

    expect(reply.content).toBe("Hello");
    expect(base).not.toHaveBeenCalled();
  });

  it("streams tokens", async () => {
    const tokens: string[] = [];

    const reply = await client().chatStream({
      model: APPLE_FOUNDATION_MODEL,
      messages,
      onToken: (token) => {
        tokens.push(token);
      },
    });

    expect(tokens).toEqual(["Hel", "lo"]);
    expect(reply).toMatchObject({ content: "Hello", done: true });
  });

  it("reports the helper's error", async () => {
    await expect(
      client().chat({
        model: APPLE_FOUNDATION_MODEL,
        messages: [{ role: "user", content: "fail" }],
      }),
    ).rejects.toThrow("failed with 500: model busy");
  });
});
