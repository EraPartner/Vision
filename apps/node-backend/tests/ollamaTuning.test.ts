import { describe, expect, it, vi } from "vitest";

import { APPLE_FOUNDATION_MODEL } from "../src/integrations/ollama/appleFoundation.ts";
import {
  contextCeiling,
  createContextTuner,
  profileFromModelInfo,
} from "../src/integrations/ollama/tuning.ts";
import type { ModelProfile } from "../src/integrations/ollama/tuning.ts";

const GiB = 1024 ** 3;
// Llama 3.1 8B: 32 layers, 8 KV heads, head size 128 -> 128 KiB per token.
const LLAMA_8B_INFO = {
  "general.architecture": "llama",
  "llama.block_count": 32,
  "llama.attention.head_count": 32,
  "llama.attention.head_count_kv": 8,
  "llama.embedding_length": 4096,
  "llama.context_length": 131072,
};
const llama8b = profileFromModelInfo(LLAMA_8B_INFO, 4.9 * GiB);

function messagesOfChars(chars: number) {
  return [{ role: "user", content: "x".repeat(chars) }];
}

describe("profileFromModelInfo", () => {
  it("derives the f16 KV cache size per token from GGUF metadata", () => {
    expect(llama8b).toEqual({
      contextLength: 131072,
      weightBytes: 4.9 * GiB,
      kvBytesPerToken: 128 * 1024,
    });
  });

  it("returns nulls when Ollama reports no architecture", () => {
    expect(profileFromModelInfo(null, null)).toEqual({
      contextLength: null,
      weightBytes: null,
      kvBytesPerToken: null,
    });
  });
});

describe("contextCeiling", () => {
  it("scales with RAM and never drops below the old fixed 8k", () => {
    expect(contextCeiling(llama8b, 16 * GiB)).toBe(16_384);
    expect(contextCeiling(llama8b, 64 * GiB)).toBe(32_768);
    const seventyB: ModelProfile = {
      contextLength: 131072,
      weightBytes: 42 * GiB,
      kvBytesPerToken: 320 * 1024,
    };
    expect(contextCeiling(seventyB, 64 * GiB)).toBe(8_192);
    expect(contextCeiling(null, 16 * GiB)).toBe(8_192);
  });

  it("respects a model's own shorter context length", () => {
    expect(contextCeiling({ ...llama8b, contextLength: 4096 }, 64 * GiB)).toBe(
      4_096,
    );
  });
});

describe("createContextTuner", () => {
  const tunerFor = (profile: ModelProfile | null, fixedNumCtx?: number) =>
    createContextTuner({
      loadProfile: vi.fn().mockResolvedValue(profile),
      totalMemoryBytes: 16 * GiB,
      fixedNumCtx,
    });

  it("picks the smallest bucket that fits the prompt and the answer", async () => {
    const tuner = tunerFor(llama8b);
    await expect(
      tuner.choose("llama3.1:8b", messagesOfChars(4_000)),
    ).resolves.toMatchObject({ numCtx: 4_096, overflow: false });
  });

  it("never steps a loaded model's window down, until forgotten", async () => {
    const tuner = tunerFor(llama8b);
    const large = await tuner.choose("m", messagesOfChars(30_000));
    expect(large.numCtx).toBe(16_384);
    const small = await tuner.choose("m", messagesOfChars(100));
    expect(small.numCtx).toBe(16_384);
    tuner.forget("m");
    const afterUnload = await tuner.choose("m", messagesOfChars(100));
    expect(afterUnload.numCtx).toBe(4_096);
  });

  it("flags prompts above the ceiling instead of exceeding it", async () => {
    const tuner = tunerFor(llama8b);
    await expect(
      tuner.choose("m", messagesOfChars(200_000)),
    ).resolves.toMatchObject({ numCtx: 16_384, overflow: true });
  });

  it("keeps OLLAMA_NUM_CTX and the Apple model on a fixed window", async () => {
    await expect(
      tunerFor(llama8b, 2_048).choose("m", messagesOfChars(30_000)),
    ).resolves.toMatchObject({ numCtx: 2_048 });
    await expect(
      tunerFor(llama8b).choose(APPLE_FOUNDATION_MODEL, messagesOfChars(100)),
    ).resolves.toMatchObject({ numCtx: 8_192 });
  });

  it("falls back to 8k when the model profile cannot be read", async () => {
    const tuner = createContextTuner({
      loadProfile: vi.fn().mockRejectedValue(new Error("offline")),
      totalMemoryBytes: 64 * GiB,
    });
    await expect(tuner.ceilingFor("m")).resolves.toBe(8_192);
  });
});
