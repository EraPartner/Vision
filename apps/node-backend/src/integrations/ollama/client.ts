/**
 * Ollama HTTP client — thin wrapper over the local Ollama REST API.
 *
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * Responsibilities:
 *   - healthCheck(): ping the server and report reachable/not
 *   - listModels(): enumerate installed models
 *   - chat(): non-streaming completion with optional tool-calling
 *   - chatStream(): NDJSON streaming completion; emits content deltas via
 *     onToken, returns the final aggregated message + usage.
 */

import { logger } from "../../config/logger.ts";
import settings from "../../config/config.ts";
import { withAppleFoundation } from "./appleFoundation.ts";
import type { ProviderToolCall } from "./prompts.ts";
import { errorMessage, isAbortError } from "../../lib/errors.ts";

export interface OllamaErrorOptions {
  status?: number | null;
  cause?: unknown;
  code?: string | null;
}

/** Ollama /api/tags and /api/ps entry; provider JSON, fields unchecked. */
export interface OllamaModelEntry {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
  context_length?: number;
  expires_at?: string;
  modified_at?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaModelListResponse {
  models?: OllamaModelEntry[];
}

/** One installed model as reported by listModels(). */
export interface OllamaModelSummary {
  name: string | undefined;
  size: number | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  modifiedAt: string | null;
}

export interface OllamaEmbedResponse {
  model?: string;
  embeddings?: number[][];
}

export interface OllamaResponseMessage {
  role?: string;
  content?: string;
  tool_calls?: ProviderToolCall[];
}

/** One /api/chat response object (whole response or one NDJSON chunk). */
export interface OllamaChatResponse {
  model?: string;
  message?: OllamaResponseMessage;
  done?: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  error?: string;
}

export interface OllamaClientOptions {
  baseUrl?: string;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  fetchImpl?: typeof fetch | null | undefined;
}

/** A byte-stream reader as the client uses it; shims and stubs may omit `releaseLock`. */
interface ByteStreamReader {
  read(): Promise<
    { done: true; value?: undefined } | { done: false; value: Uint8Array }
  >;
  cancel(): Promise<unknown>;
  releaseLock?: (() => void) | undefined;
}

/**
 * The slice of a fetch Response the client reads. `fetchImpl` is injectable
 * (Apple helper shim, test stubs), so headers, body and `text` are not assumed.
 */
interface FetchedResponse {
  ok: boolean;
  status: number;
  headers?:
    | { get?: ((name: string) => string | null) | undefined }
    | undefined;
  body?:
    | { getReader?: (() => ByteStreamReader) | undefined }
    | null
    | undefined;
  text: () => Promise<string>;
}

interface OllamaRequestOptions {
  method?: string | undefined;
  body?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
}

/**
 * How long Ollama keeps the model loaded after a request: a duration such as
 * "10m", seconds, or 0 to unload at once. Unset uses the server's default.
 */
export type OllamaKeepAlive = string | number;

export interface OllamaChatParams {
  model?: string | undefined;
  messages: unknown[];
  tools?: unknown[] | undefined;
  options?: unknown;
  keepAlive?: OllamaKeepAlive | undefined;
  format?: unknown;
  signal?: AbortSignal | undefined;
}

export interface OllamaChatStreamParams {
  model?: string | undefined;
  messages?: unknown[] | undefined;
  tools?: unknown[] | undefined;
  options?: unknown;
  keepAlive?: OllamaKeepAlive | undefined;
  signal?: AbortSignal | undefined;
  onToken?: ((chunk: string) => void | Promise<void>) | undefined;
}

/** The assembled result of a streamed /api/chat call. */
export interface OllamaChatStreamResult {
  model: string;
  role: "assistant";
  content: string;
  toolCalls: ProviderToolCall[];
  done: boolean;
  doneReason: string | null;
  evalCount: number | null;
  promptEvalCount: number | null;
  totalDurationMs: number | null;
  loadDurationMs: number | null;
  promptEvalDurationMs: number | null;
  evalDurationMs: number | null;
}

/** Ollama reports durations in nanoseconds; absent or zero means unknown. */
function nsToMs(ns: number | null | undefined): number | null {
  return typeof ns === "number" && ns !== 0 ? Math.round(ns / 1e6) : null;
}

export class OllamaError extends Error {
  status: number | null;
  code: string | null;

  constructor(
    message: string,
    { status, cause, code }: OllamaErrorOptions = {},
  ) {
    super(message);
    this.name = "OllamaError";
    this.status = status ?? null;
    this.code = code ?? null;
    if (cause) this.cause = cause;
  }
}

function withTimeout(
  signal: AbortSignal | null | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timedOut = false;
  const onTimeout = () => {
    timedOut = true;
    controller.abort();
  };
  let timer = setTimeout(onTimeout, timeoutMs);

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => controller.abort(signal.reason), {
        once: true,
      });
    }
  }

  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
    isTimeout: () => timedOut,
    /** Restart the timer with a new window (used per streamed chunk). */
    rearm: (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, ms);
    },
  };
}

async function readJson(
  response: FetchedResponse,
  maxBytes = 8 * 1024 * 1024,
): Promise<unknown> {
  const declaredBytes = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
    throw new OllamaError(
      "Ollama response exceeds the configured memory bound",
      {
        status: response.status,
        code: "RESPONSE_TOO_LARGE",
      },
    );
  const reader = response.body?.getReader?.();
  if (!reader) {
    const fallbackText = await response.text();
    if (Buffer.byteLength(fallbackText) > maxBytes)
      throw new OllamaError(
        "Ollama response exceeds the configured memory bound",
        { status: response.status, code: "RESPONSE_TOO_LARGE" },
      );
    if (!fallbackText) return null;
    try {
      return JSON.parse(fallbackText);
    } catch (err) {
      throw new OllamaError("Ollama returned non-JSON response", {
        status: response.status,
        cause: err,
        code: "INVALID_JSON",
      });
    }
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new OllamaError(
        "Ollama response exceeds the configured memory bound",
        { status: response.status, code: "RESPONSE_TOO_LARGE" },
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new OllamaError("Ollama returned non-JSON response", {
      status: response.status,
      cause: err,
      code: "INVALID_JSON",
    });
  }
}

/** ": <message>" from an error body shaped `{"error": "..."}`, else "". */
function upstreamDetail(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    )
      return `: ${parsed.error}`;
  } catch {
    // Not JSON: keep the status-only message.
  }
  return "";
}

/**
 * Map a fetch-layer error to a typed OllamaError (timeout / aborted / network),
 * shared by the request and chatStream paths (SIMP-38). An OllamaError already
 * in flight is passed through unchanged.
 */
function normalizeFetchError(
  err: unknown,
  {
    isTimeout,
    aborted,
    timeoutMessage,
    failurePrefix,
  }: {
    isTimeout: boolean;
    aborted: boolean;
    timeoutMessage: string;
    failurePrefix: string;
  },
): OllamaError {
  if (err instanceof OllamaError) return err;
  if (isTimeout)
    return new OllamaError(timeoutMessage, { code: "TIMEOUT", cause: err });
  if (isAbortError(err) || aborted) {
    return new OllamaError("Ollama request aborted", {
      code: "ABORTED",
      cause: err,
    });
  }
  return new OllamaError(`${failurePrefix}: ${errorMessage(err)}`, {
    code: "NETWORK_ERROR",
    cause: err,
  });
}

function createOllamaClient({
  baseUrl = settings.ollama.url,
  requestTimeoutMs = settings.ollama.requestTimeoutMs,
  healthTimeoutMs = settings.ollama.healthTimeoutMs,
  streamIdleTimeoutMs = settings.ollama.streamIdleTimeoutMs,
  fetchImpl: injectedFetch = withAppleFoundation(globalThis.fetch),
}: OllamaClientOptions = {}) {
  if (injectedFetch == null) {
    throw new OllamaError("No fetch implementation available");
  }
  const fetchImpl = injectedFetch;

  const url = (path: string) => `${baseUrl}${path}`;

  // The type argument declares the expected provider JSON shape; the body is
  // parsed, not validated, so callers keep their defensive optional access.
  async function request<T>(
    path: string,
    {
      method = "GET",
      body,
      signal,
      timeoutMs = requestTimeoutMs,
      maxResponseBytes = 8 * 1024 * 1024,
    }: OllamaRequestOptions = {},
  ): Promise<T | null> {
    const {
      signal: composedSignal,
      cancel,
      isTimeout,
    } = withTimeout(signal, timeoutMs);
    try {
      const response: FetchedResponse = await fetchImpl(url(path), {
        method,
        ...(body
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
        signal: composedSignal,
      });

      if (!response.ok) {
        const payload = await response.text().catch(() => "");
        throw new OllamaError(
          `Ollama ${method} ${path} failed with ${response.status}${upstreamDetail(payload)}`,
          { status: response.status, code: "HTTP_ERROR" },
        );
      }

      return (await readJson(response, maxResponseBytes)) as T | null;
    } catch (err) {
      throw normalizeFetchError(err, {
        isTimeout: isTimeout(),
        aborted: composedSignal.aborted,
        timeoutMessage: `Ollama ${method} ${path} timed out after ${timeoutMs}ms`,
        failurePrefix: `Ollama ${method} ${path} failed`,
      });
    } finally {
      cancel();
    }
  }

  async function healthCheck() {
    try {
      const data = await request<OllamaModelListResponse>("/api/tags", {
        timeoutMs: healthTimeoutMs,
      });
      return {
        reachable: true,
        baseUrl,
        modelCount: Array.isArray(data?.models) ? data.models.length : 0,
      };
    } catch (err) {
      // request() normalizes every failure to an OllamaError.
      const message = errorMessage(err);
      const code = err instanceof OllamaError ? err.code : null;
      logger.debug("[ollama] healthCheck failed", { message, code });
      return {
        reachable: false,
        baseUrl,
        error: message,
        code: code || "UNKNOWN",
      };
    }
  }

  async function listModels({ signal }: { signal?: AbortSignal } = {}): Promise<
    OllamaModelSummary[]
  > {
    const data = await request<OllamaModelListResponse>("/api/tags", {
      signal,
      timeoutMs: healthTimeoutMs,
    });
    const raw = Array.isArray(data?.models) ? data.models : [];
    return raw.map((m) => ({
      name: m.name,
      size: m.size ?? null,
      family: m.details?.family ?? null,
      parameterSize: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
      modifiedAt: m.modified_at ?? null,
    }));
  }

  /** Generate local L2-normalized embeddings for bounded retrieval input. */
  async function embed({
    model = settings.ollama.embeddingModel,
    input,
    keepAlive,
    signal,
  }: {
    model?: string;
    input?: string | string[];
    keepAlive?: OllamaKeepAlive | undefined;
    signal?: AbortSignal | undefined;
  } = {}) {
    if (!model) {
      throw new OllamaError("No local embedding model is configured", {
        code: "EMBEDDING_MODEL_UNAVAILABLE",
      });
    }
    const values = Array.isArray(input) ? input : [input];
    if (
      values.length === 0 ||
      values.length > 64 ||
      values.some((value) => typeof value !== "string" || !value.trim())
    ) {
      throw new OllamaError("embed requires 1 to 64 non-empty strings", {
        code: "INVALID_INPUT",
      });
    }
    const data = await request<OllamaEmbedResponse>("/api/embed", {
      method: "POST",
      body: {
        model,
        input: values,
        truncate: false,
        ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
      },
      signal,
      maxResponseBytes: 4 * 1024 * 1024,
    });
    if (
      !Array.isArray(data?.embeddings) ||
      data.embeddings.length !== values.length ||
      data.embeddings.some(
        (vector) =>
          !Array.isArray(vector) ||
          vector.length === 0 ||
          vector.length > 8192 ||
          vector.some((number) => !Number.isFinite(number)),
      )
    ) {
      throw new OllamaError("Ollama returned invalid embeddings", {
        code: "INVALID_EMBEDDING_RESPONSE",
      });
    }
    return { model: data.model || model, embeddings: data.embeddings };
  }

  /**
   * Read Ollama's resident-model inventory for evaluation telemetry. `sizeVram`
   * is the provider-reported loaded memory, not the Vision process heap.
   */
  async function listRunningModels({ signal }: { signal?: AbortSignal } = {}) {
    const data = await request<OllamaModelListResponse>("/api/ps", {
      signal,
      timeoutMs: healthTimeoutMs,
    });
    const raw = Array.isArray(data?.models) ? data.models : [];
    return raw.map((model) => ({
      name: model.name,
      model: model.model ?? model.name,
      size: model.size ?? null,
      sizeVram: model.size_vram ?? null,
      contextLength: model.context_length ?? null,
      expiresAt: model.expires_at ?? null,
    }));
  }

  /** /api/show `model_info` (GGUF metadata) for one installed model. */
  async function showModel(
    model: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown> | null> {
    const data = await request<{ model_info?: Record<string, unknown> }>(
      "/api/show",
      { method: "POST", body: { model }, signal, timeoutMs: healthTimeoutMs },
    );
    return data?.model_info ?? null;
  }

  /**
   * Load a model (or keep it loaded) without generating, or unload it with
   * `keepAlive: 0`. Ollama treats a chat with no messages as a load request;
   * `numCtx` must match what later chats send or Ollama reloads the model.
   */
  async function setModelResidency({
    model,
    keepAlive,
    numCtx,
    signal,
  }: {
    model: string;
    keepAlive: OllamaKeepAlive;
    numCtx?: number | undefined;
    signal?: AbortSignal | undefined;
  }) {
    await request<OllamaChatResponse>("/api/chat", {
      method: "POST",
      body: {
        model,
        messages: [],
        keep_alive: keepAlive,
        ...(numCtx !== undefined ? { options: { num_ctx: numCtx } } : {}),
      },
      signal,
    });
  }

  async function chat({
    model = settings.ollama.defaultModel,
    messages,
    tools,
    options,
    keepAlive,
    format,
    signal,
  }: OllamaChatParams) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new OllamaError("chat requires a non-empty messages array", {
        code: "INVALID_INPUT",
      });
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (options) body.options = options;
    if (keepAlive !== undefined) body.keep_alive = keepAlive;
    if (format) body.format = format;

    const data = await request<OllamaChatResponse>("/api/chat", {
      method: "POST",
      body,
      signal,
    });

    const message: OllamaResponseMessage = data?.message ?? {};
    return {
      model: data?.model || model,
      role: message.role || "assistant",
      content: message.content || "",
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      done: data?.done ?? true,
      doneReason: data?.done_reason ?? null,
      evalCount: data?.eval_count ?? null,
      promptEvalCount: data?.prompt_eval_count ?? null,
      totalDurationMs:
        data?.total_duration !== undefined && data.total_duration !== 0
          ? Math.round(data.total_duration / 1e6)
          : null,
      loadDurationMs: nsToMs(data?.load_duration),
      promptEvalDurationMs: nsToMs(data?.prompt_eval_duration),
      evalDurationMs: nsToMs(data?.eval_duration),
      raw: data,
    };
  }

  async function chatStream({
    model = settings.ollama.defaultModel,
    messages,
    tools,
    options,
    keepAlive,
    signal,
    onToken,
  }: OllamaChatStreamParams = {}): Promise<OllamaChatStreamResult> {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new OllamaError("chatStream requires a non-empty messages array", {
        code: "INVALID_INPUT",
      });
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (options) body.options = options;
    if (keepAlive !== undefined) body.keep_alive = keepAlive;

    // requestTimeoutMs bounds the connect + prompt-eval phase (no chunks flow
    // until the first token, which on a cold model can take minutes). Once
    // chunks arrive, the window is re-armed per chunk (idle timeout) so a
    // healthy long generation is never cut off mid-stream.
    const {
      signal: composedSignal,
      cancel,
      isTimeout,
      rearm,
    } = withTimeout(signal, requestTimeoutMs);
    logger.debug("[ollama] chatStream request", {
      url: url("/api/chat"),
      model,
      messageCount: messages.length,
      toolCount: tools?.length ?? 0,
      timeoutMs: requestTimeoutMs,
      idleTimeoutMs: streamIdleTimeoutMs,
    });
    let response: FetchedResponse;
    try {
      response = await fetchImpl(url("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: composedSignal,
      });
      logger.debug("[ollama] chatStream response received", {
        status: response.status,
        contentType: response.headers?.get?.("content-type") ?? null,
      });
    } catch (err) {
      cancel();
      throw normalizeFetchError(err, {
        isTimeout: isTimeout(),
        aborted: composedSignal.aborted,
        timeoutMessage: `Ollama request timed out after ${requestTimeoutMs}ms`,
        failurePrefix: "Ollama POST /api/chat failed",
      });
    }

    if (!response.ok) {
      cancel();
      const payload = await response.text().catch(() => "");
      throw new OllamaError(
        `Ollama POST /api/chat failed with ${response.status}${upstreamDetail(payload)}`,
        {
          status: response.status,
          code: "HTTP_ERROR",
        },
      );
    }

    const streamBody = response.body;
    if (typeof streamBody?.getReader !== "function") {
      cancel();
      throw new OllamaError("Ollama streaming response has no readable body", {
        code: "NO_BODY",
      });
    }

    const reader = streamBody.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let accumulatedContent = "";
    // Tool calls can arrive spread across several NDJSON chunks; accumulate
    // them all. Some Ollama builds re-emit the complete list on the final
    // done chunk, so dedupe by call signature rather than trusting order.
    const toolCalls: ProviderToolCall[] = [];
    const seenToolCallSigs = new Set<string>();
    const addToolCalls = (calls: ProviderToolCall[]) => {
      for (const call of calls) {
        const sig = JSON.stringify([
          call?.id ?? null,
          call?.function?.name ?? null,
          call?.function?.arguments ?? null,
        ]);
        if (seenToolCallSigs.has(sig)) continue;
        seenToolCallSigs.add(sig);
        toolCalls.push(call);
      }
    };
    let modelName = model;
    let evalCount: number | null = null;
    let promptEvalCount: number | null = null;
    // Widened initializer: assigned inside handleLine, which TS cannot see here.
    let totalDurationNs = null as number | null;
    let loadDurationNs = null as number | null;
    let promptEvalDurationNs = null as number | null;
    let evalDurationNs = null as number | null;
    let doneReason: string | null = null;
    let isDone = false;

    // Resolves to whether the stream has reported `done` (TS cannot see the
    // assignment to `isDone` from the read loop below).
    const handleLine = async (line: string): Promise<boolean> => {
      const trimmed = line.trim();
      if (!trimmed) return isDone;
      let parsed: OllamaChatResponse;
      try {
        parsed = JSON.parse(trimmed) as OllamaChatResponse;
      } catch (err) {
        throw new OllamaError("Ollama returned malformed NDJSON chunk", {
          code: "INVALID_JSON",
          cause: err,
        });
      }

      if (typeof parsed.error === "string") {
        throw new OllamaError(parsed.error, { code: "PROVIDER_ERROR" });
      }
      if (parsed.model) modelName = parsed.model;
      const msg: OllamaResponseMessage = parsed.message ?? {};
      const deltaContent = typeof msg.content === "string" ? msg.content : "";
      if (deltaContent) {
        accumulatedContent += deltaContent;
        try {
          await onToken?.(deltaContent);
        } catch (err) {
          logger.warn("[ollama] onToken handler threw", {
            error: errorMessage(err),
          });
        }
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        addToolCalls(msg.tool_calls);
      }

      if (parsed.done) {
        isDone = true;
        doneReason = parsed.done_reason ?? null;
        evalCount = parsed.eval_count ?? evalCount;
        promptEvalCount = parsed.prompt_eval_count ?? promptEvalCount;
        totalDurationNs = parsed.total_duration ?? totalDurationNs;
        loadDurationNs = parsed.load_duration ?? loadDurationNs;
        promptEvalDurationNs =
          parsed.prompt_eval_duration ?? promptEvalDurationNs;
        evalDurationNs = parsed.eval_duration ?? evalDurationNs;
      }
      return isDone;
    };

    try {
      let streamDone = false;
      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;
        // A chunk arrived — the stream is alive. Re-arm the abort window so
        // only inactivity (not total generation time) can time the stream out.
        rearm(streamIdleTimeoutMs);
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          streamDone = await handleLine(line);
          if (streamDone) break;
        }
      }
      if (buffer.length > 0) await handleLine(buffer);
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      if (isTimeout()) {
        throw new OllamaError(
          `Ollama stream timed out (${requestTimeoutMs}ms to first chunk, then ${streamIdleTimeoutMs}ms idle between chunks)`,
          { code: "TIMEOUT", cause: err },
        );
      }
      if (
        isAbortError(err) ||
        composedSignal.aborted
      ) {
        throw new OllamaError("Ollama stream aborted", {
          code: "ABORTED",
          cause: err,
        });
      }
      throw new OllamaError(
        `Ollama stream read failed: ${errorMessage(err)}`,
        {
          cause: err,
          code: "STREAM_ERROR",
        },
      );
    } finally {
      cancel();
      try {
        reader.releaseLock?.();
      } catch {
        // noop
      }
    }

    return {
      model: modelName,
      role: "assistant",
      content: accumulatedContent,
      toolCalls,
      done: isDone,
      doneReason,
      evalCount,
      promptEvalCount,
      totalDurationMs:
        totalDurationNs !== null && totalDurationNs !== 0
          ? Math.round(totalDurationNs / 1e6)
          : null,
      loadDurationMs: nsToMs(loadDurationNs),
      promptEvalDurationMs: nsToMs(promptEvalDurationNs),
      evalDurationMs: nsToMs(evalDurationNs),
    };
  }

  return {
    baseUrl,
    healthCheck,
    listModels,
    embed,
    listRunningModels,
    showModel,
    setModelResidency,
    chat,
    chatStream,
  };
}

let defaultClient: ReturnType<typeof createOllamaClient> | null = null;
export function getOllamaClient() {
  defaultClient ??= createOllamaClient();
  return defaultClient;
}

export { createOllamaClient as __createOllamaClient };
