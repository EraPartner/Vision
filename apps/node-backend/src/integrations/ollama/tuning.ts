/**
 * Per-request Ollama sizing: pick `num_ctx` from the prompt, the model and the
 * Mac's memory instead of one fixed window.
 *
 * Ollama allocates the KV cache for the whole `num_ctx` when it loads a model
 * and reloads the model whenever a request asks for a different `num_ctx`.
 * So the tuner:
 *   - estimates the prompt in tokens (characters / 3.5, plus a 15% margin and
 *     room for the answer),
 *   - rounds up to a bucket (4k, 8k, 16k, 32k) so small prompt changes never
 *     reload the model,
 *   - never steps a model's bucket down while it stays loaded (a step down
 *     would reload it too); `forget()` resets that once the model is unloaded,
 *   - caps the bucket by the model's own context length and by what its
 *     weights plus KV cache can take from RAM, but never below today's 8k.
 *
 * OLLAMA_NUM_CTX, when set, pins the window as before. The Apple Foundation
 * model has its own 4,096-token window and trimming (appleFoundation.ts), so
 * it keeps the fixed default.
 */

import os from "node:os";

import settings from "../../config/config.ts";
import { APPLE_FOUNDATION_MODEL } from "./appleFoundation.ts";
import { getOllamaClient } from "./client.ts";
import type { OllamaKeepAlive } from "./client.ts";

const CONTEXT_BUCKETS = [4_096, 8_192, 16_384, 32_768] as const;
/** The window Vision sent on every request before tuning; the cap's floor. */
export const DEFAULT_NUM_CTX = 8_192;
/** Tokens kept free for the reply; matches the chat's `num_predict`. */
export const ANSWER_RESERVE_TOKENS = 1_024;
const CHARS_PER_TOKEN = 3.5;
const ESTIMATE_MARGIN = 1.15;
/** Share of RAM the model may use, after leaving room for macOS and Vision. */
const RAM_SHARE = 0.75;
const RAM_HEADROOM_BYTES = 4 * 1024 ** 3;
const PROFILE_TTL_MS = 10 * 60_000;
/** How long the chat model stays loaded after a request or a warm-up. */
export const ACTIVE_KEEP_ALIVE = "10m";
/** Short linger after the chat page closes, when memory allows. */
export const RELEASE_KEEP_ALIVE = "2m";
/** Weights above this share of total RAM make the model unload at once. */
export const MEMORY_TIGHT_WEIGHT_SHARE = 0.25;

/** What sizing needs to know about one installed model. */
export interface ModelProfile {
  /** The model's trained context length, from /api/show. */
  contextLength: number | null;
  /** Size of the weights on disk, from /api/tags. */
  weightBytes: number | null;
  /** f16 KV cache bytes per context token, from the model's architecture. */
  kvBytesPerToken: number | null;
}

export interface ContextTunerOptions {
  /** Loads a profile; may throw or return null when Ollama can't say. */
  loadProfile: (model: string) => Promise<ModelProfile | null>;
  totalMemoryBytes?: number;
  /** OLLAMA_NUM_CTX: when set, every request uses exactly this window. */
  fixedNumCtx?: number | undefined;
  now?: () => number;
}

/** How long to keep a model loaded while the chat is in use and after it. */
export interface ModelResidency {
  active: OllamaKeepAlive;
  release: OllamaKeepAlive;
}

/** What the memory advisor shows for one model. */
export interface ModelFitSummary {
  model: string;
  totalMemoryBytes: number;
  weightBytes: number | null;
  kvBytesPerToken: number | null;
  /** Largest window the tuner may pick; null for the Apple Foundation model. */
  maxNumCtx: number | null;
}

export interface ContextChoice {
  numCtx: number;
  /** Estimated prompt + answer tokens. */
  neededTokens: number;
  /** True when the estimate is above the largest window this model may use. */
  overflow: boolean;
}

/** Rough token count for text or a JSON-serialisable value. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Characters of prompt that fit in `tokens`, after the estimate's margin. */
export function charsForTokens(tokens: number): number {
  return Math.max(0, Math.floor((tokens / ESTIMATE_MARGIN) * CHARS_PER_TOKEN));
}

function promptTokens(messages: unknown, tools: unknown): number {
  const raw = estimateTokens(messages) + (tools ? estimateTokens(tools) : 0);
  return Math.ceil(raw * ESTIMATE_MARGIN) + ANSWER_RESERVE_TOKENS;
}

function numberOrNull(value: unknown): number | null {
  if (Array.isArray(value)) {
    const numbers = value.filter(
      (item): item is number => typeof item === "number",
    );
    return numbers.length > 0 ? Math.max(...numbers) : null;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Read context length and f16 KV bytes per token from /api/show `model_info`
 * (GGUF metadata keyed by architecture, e.g. `llama.block_count`).
 */
export function profileFromModelInfo(
  modelInfo: Record<string, unknown> | null | undefined,
  weightBytes: number | null,
): ModelProfile {
  const arch = modelInfo?.["general.architecture"];
  const read = (key: string) =>
    typeof arch === "string" && modelInfo
      ? numberOrNull(modelInfo[`${arch}.${key}`])
      : null;
  const layers = read("block_count");
  const heads = read("attention.head_count");
  const kvHeads = read("attention.head_count_kv") ?? heads;
  const embedding = read("embedding_length");
  const headDim =
    embedding !== null && heads !== null ? embedding / heads : null;
  const keyLength = read("attention.key_length") ?? headDim;
  const valueLength = read("attention.value_length") ?? headDim;
  const kvBytesPerToken =
    layers !== null &&
    kvHeads !== null &&
    keyLength !== null &&
    valueLength !== null
      ? layers * kvHeads * (keyLength + valueLength) * 2
      : null;
  return {
    contextLength: read("context_length"),
    weightBytes,
    kvBytesPerToken,
  };
}

/** Largest window this model may use on this Mac, never below today's 8k. */
export function contextCeiling(
  profile: ModelProfile | null,
  totalMemoryBytes: number,
): number {
  const largest =
    CONTEXT_BUCKETS[CONTEXT_BUCKETS.length - 1] ?? DEFAULT_NUM_CTX;
  let ceiling: number = DEFAULT_NUM_CTX;
  const weightBytes = profile?.weightBytes ?? null;
  const kvBytesPerToken = profile?.kvBytesPerToken ?? null;
  if (weightBytes !== null && kvBytesPerToken !== null) {
    const spare =
      totalMemoryBytes * RAM_SHARE - RAM_HEADROOM_BYTES - weightBytes;
    const tokens = Math.floor(spare / kvBytesPerToken);
    const fitting = CONTEXT_BUCKETS.filter((bucket) => bucket <= tokens);
    ceiling = Math.max(DEFAULT_NUM_CTX, fitting.at(-1) ?? 0);
  }
  ceiling = Math.min(ceiling, largest);
  const contextLength = profile?.contextLength ?? null;
  if (contextLength !== null) ceiling = Math.min(ceiling, contextLength);
  return ceiling;
}

export function createContextTuner({
  loadProfile,
  totalMemoryBytes = os.totalmem(),
  fixedNumCtx,
  now = Date.now,
}: ContextTunerOptions) {
  const profiles = new Map<
    string,
    { at: number; profile: Promise<ModelProfile | null> }
  >();
  const loadedWindows = new Map<string, number>();
  // Every non-Apple model this process loaded, for the best-effort unload on
  // shutdown; unlike loadedWindows it also covers a pinned OLLAMA_NUM_CTX.
  const residentModels = new Set<string>();

  function profileFor(model: string): Promise<ModelProfile | null> {
    const cached = profiles.get(model);
    if (cached && now() - cached.at < PROFILE_TTL_MS) return cached.profile;
    const profile = loadProfile(model).catch(() => null);
    profiles.set(model, { at: now(), profile });
    return profile;
  }

  function isTuned(model: string) {
    return fixedNumCtx === undefined && model !== APPLE_FOUNDATION_MODEL;
  }

  /** Largest window a request for this model may get. */
  async function ceilingFor(model: string): Promise<number> {
    if (fixedNumCtx !== undefined) return fixedNumCtx;
    if (!isTuned(model)) return DEFAULT_NUM_CTX;
    return contextCeiling(await profileFor(model), totalMemoryBytes);
  }

  /** Window for one request with these messages and tools. */
  async function choose(
    model: string,
    messages: unknown,
    tools?: unknown,
  ): Promise<ContextChoice> {
    const neededTokens = promptTokens(messages, tools);
    const ceiling = await ceilingFor(model);
    if (model !== APPLE_FOUNDATION_MODEL) residentModels.add(model);
    if (!isTuned(model)) {
      return {
        numCtx: ceiling,
        neededTokens,
        overflow: neededTokens > ceiling,
      };
    }
    const bucket =
      CONTEXT_BUCKETS.find((size) => size >= neededTokens) ?? ceiling;
    const numCtx = Math.min(
      ceiling,
      Math.max(bucket, loadedWindows.get(model) ?? 0),
    );
    loadedWindows.set(model, numCtx);
    return { numCtx, neededTokens, overflow: neededTokens > numCtx };
  }

  /**
   * Window to preload a model with: the one it is loaded with now, else the
   * default capped by the ceiling. Chats send the same window, so Ollama does
   * not reload the model for them.
   */
  async function warmWindow(model: string): Promise<number> {
    if (fixedNumCtx !== undefined) {
      if (model !== APPLE_FOUNDATION_MODEL) residentModels.add(model);
      return fixedNumCtx;
    }
    if (!isTuned(model)) return DEFAULT_NUM_CTX;
    const numCtx =
      loadedWindows.get(model) ??
      Math.min(DEFAULT_NUM_CTX, await ceilingFor(model));
    loadedWindows.set(model, numCtx);
    residentModels.add(model);
    return numCtx;
  }

  /**
   * keep_alive while chatting and after leaving. A model whose weights take
   * over a quarter of RAM is unloaded at once on release; an unknown size
   * gets the short linger.
   */
  async function residencyFor(model: string): Promise<ModelResidency> {
    const weightBytes = (await profileFor(model))?.weightBytes ?? null;
    const memoryTight =
      weightBytes !== null &&
      weightBytes > totalMemoryBytes * MEMORY_TIGHT_WEIGHT_SHARE;
    return {
      active: ACTIVE_KEEP_ALIVE,
      release: memoryTight ? 0 : RELEASE_KEEP_ALIVE,
    };
  }

  /** Memory advisor facts for one model; nulls when Ollama can't say. */
  async function profileSummary(model: string): Promise<ModelFitSummary> {
    if (model === APPLE_FOUNDATION_MODEL) {
      return {
        model,
        totalMemoryBytes,
        weightBytes: null,
        kvBytesPerToken: null,
        maxNumCtx: null,
      };
    }
    const profile = await profileFor(model);
    return {
      model,
      totalMemoryBytes,
      weightBytes: profile?.weightBytes ?? null,
      kvBytesPerToken: profile?.kvBytesPerToken ?? null,
      maxNumCtx: await ceilingFor(model),
    };
  }

  /** Models this process loaded and has not seen leave memory. */
  function loadedModels(): string[] {
    return [...residentModels];
  }

  /** The model left memory: its next request may pick a smaller window. */
  function forget(model?: string) {
    if (model === undefined) {
      loadedWindows.clear();
      residentModels.clear();
    } else {
      loadedWindows.delete(model);
      residentModels.delete(model);
    }
  }

  return {
    ceilingFor,
    choose,
    warmWindow,
    residencyFor,
    profileSummary,
    loadedModels,
    forget,
  };
}

export type ContextTuner = ReturnType<typeof createContextTuner>;

let defaultTuner: ContextTuner | null = null;
/** The process-wide tuner, so every AI path shares one loaded window. */
export function getContextTuner(): ContextTuner {
  defaultTuner ??= createContextTuner({
    fixedNumCtx: settings.ollama.numCtx,
    loadProfile: async (model) => {
      const client = getOllamaClient();
      const [modelInfo, installed] = await Promise.all([
        client.showModel(model),
        client.listModels(),
      ]);
      const names = model.includes(":") ? [model] : [model, `${model}:latest`];
      const weightBytes =
        installed.find((entry) => names.includes(entry.name ?? ""))?.size ??
        null;
      return profileFromModelInfo(modelInfo, weightBytes);
    },
  });
  return defaultTuner;
}

/**
 * Best-effort unload of the models this process loaded, for shutdown. Bounded
 * by `timeoutMs` and never throws, so it cannot hold the exit up.
 */
export async function releaseLoadedModels({
  timeoutMs = 1_000,
  tuner = getContextTuner(),
  client = getOllamaClient(),
}: {
  timeoutMs?: number;
  tuner?: Pick<ContextTuner, "loadedModels" | "forget">;
  client?: Pick<ReturnType<typeof getOllamaClient>, "setModelResidency">;
} = {}): Promise<void> {
  const models = tuner.loadedModels();
  if (models.length === 0) return;
  const signal = AbortSignal.timeout(timeoutMs);
  await Promise.allSettled(
    models.map(async (model) => {
      await client.setModelResidency({ model, keepAlive: 0, signal });
      tuner.forget(model);
    }),
  );
}
