import { describe, expect, it, vi } from "vitest";

import { APPLE_FOUNDATION_MODEL as SHARED_APPLE_MODEL } from "@vision/types/aiChat";
import { APPLE_FOUNDATION_MODEL } from "../src/integrations/ollama/appleFoundation.ts";
import {
  ACTIVE_KEEP_ALIVE,
  RELEASE_KEEP_ALIVE,
  contextCeiling,
  createContextTuner,
  profileFromModelInfo,
  releaseLoadedModels,
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

describe("model residency", () => {
  it("shares the Apple model id with the frontend", () => {
    expect(SHARED_APPLE_MODEL).toBe(APPLE_FOUNDATION_MODEL);
  });

  const tunerFor = (
    profile: ModelProfile | null,
    totalGiB = 16,
    fixedNumCtx?: number,
  ) =>
    createContextTuner({
      loadProfile: vi.fn().mockResolvedValue(profile),
      totalMemoryBytes: totalGiB * GiB,
      fixedNumCtx,
    });

  it("warms with the default window capped by the ceiling", async () => {
    await expect(tunerFor(llama8b).warmWindow("m")).resolves.toBe(8_192);
    await expect(
      tunerFor({ ...llama8b, contextLength: 4096 }).warmWindow("m"),
    ).resolves.toBe(4_096);
  });

  it("warms with the window the model already has, and records its own", async () => {
    const tuner = tunerFor(llama8b);
    await tuner.choose("m", messagesOfChars(30_000));
    await expect(tuner.warmWindow("m")).resolves.toBe(16_384);
    const fresh = tunerFor(llama8b);
    await fresh.warmWindow("m");
    // A later small chat must not pick a smaller window than the preload.
    await expect(
      fresh.choose("m", messagesOfChars(100)),
    ).resolves.toMatchObject({ numCtx: 8_192 });
  });

  it("warms a pinned OLLAMA_NUM_CTX and the Apple model with their fixed windows", async () => {
    await expect(tunerFor(llama8b, 16, 16_384).warmWindow("m")).resolves.toBe(
      16_384,
    );
    await expect(
      tunerFor(llama8b).warmWindow(APPLE_FOUNDATION_MODEL),
    ).resolves.toBe(8_192);
  });

  it("releases at once when the weights exceed a quarter of RAM", async () => {
    // 8B at 4.9 GiB on 16 GiB is 30%.
    await expect(tunerFor(llama8b, 16).residencyFor("m")).resolves.toEqual({
      active: ACTIVE_KEEP_ALIVE,
      release: 0,
    });
    await expect(tunerFor(llama8b, 32).residencyFor("m")).resolves.toEqual({
      active: "10m",
      release: RELEASE_KEEP_ALIVE,
    });
  });

  it("lingers briefly when the model size is unknown", async () => {
    await expect(tunerFor(null).residencyFor("m")).resolves.toEqual({
      active: "10m",
      release: "2m",
    });
  });

  it("tracks loaded models until forgotten, never the Apple model", async () => {
    const tuner = tunerFor(llama8b, 16, 8_192);
    await tuner.choose("a", messagesOfChars(10));
    await tuner.warmWindow("b");
    await tuner.choose(APPLE_FOUNDATION_MODEL, messagesOfChars(10));
    expect(tuner.loadedModels().sort()).toEqual(["a", "b"]);
    tuner.forget("a");
    expect(tuner.loadedModels()).toEqual(["b"]);
  });

  it("summarises a model's fit, with nulls for Apple", async () => {
    const tuner = tunerFor(llama8b);
    await expect(tuner.profileSummary("m")).resolves.toEqual({
      model: "m",
      totalMemoryBytes: 16 * GiB,
      weightBytes: 4.9 * GiB,
      kvBytesPerToken: 128 * 1024,
      maxNumCtx: 16_384,
    });
    await expect(
      tuner.profileSummary(APPLE_FOUNDATION_MODEL),
    ).resolves.toMatchObject({
      weightBytes: null,
      kvBytesPerToken: null,
      maxNumCtx: null,
    });
  });
});

describe("releaseLoadedModels", () => {
  it("unloads every loaded model with keepAlive 0 and forgets it", async () => {
    const tuner = createContextTuner({
      loadProfile: vi.fn().mockResolvedValue(llama8b),
      totalMemoryBytes: 16 * GiB,
    });
    await tuner.warmWindow("a");
    await tuner.choose("b", messagesOfChars(10));
    const setModelResidency = vi.fn().mockResolvedValue(undefined);
    await releaseLoadedModels({ tuner, client: { setModelResidency } });
    expect(setModelResidency.mock.calls.map(([arg]) => arg)).toEqual([
      expect.objectContaining({ model: "a", keepAlive: 0 }),
      expect.objectContaining({ model: "b", keepAlive: 0 }),
    ]);
    expect(tuner.loadedModels()).toEqual([]);
  });

  it("does nothing without loaded models and never throws", async () => {
    const setModelResidency = vi.fn().mockRejectedValue(new Error("down"));
    const tuner = createContextTuner({
      loadProfile: vi.fn().mockResolvedValue(null),
    });
    await releaseLoadedModels({ tuner, client: { setModelResidency } });
    expect(setModelResidency).not.toHaveBeenCalled();
    await tuner.warmWindow("a");
    await expect(
      releaseLoadedModels({ tuner, client: { setModelResidency } }),
    ).resolves.toBeUndefined();
  });
});
