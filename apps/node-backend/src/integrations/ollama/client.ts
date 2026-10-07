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
import type { OllamaToolCall } from "./prompts.ts";

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
  tool_calls?: OllamaToolCall[];
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
}

export interface OllamaClientOptions {
  baseUrl?: string;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface OllamaRequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface OllamaChatParams {
  model?: string;
  messages: unknown[];
  tools?: unknown[];
  options?: unknown;
  format?: unknown;
  signal?: AbortSignal;
}

export interface OllamaChatStreamParams {
  model?: string;
  messages?: unknown[];
  tools?: unknown[];
  options?: unknown;
  signal?: AbortSignal;
  onToken?: (chunk: string) => void | Promise<void>;
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
  response: Response,
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
  while (true) {
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
  if ((err as Error | null | undefined)?.name === "AbortError" || aborted) {
    return new OllamaError("Ollama request aborted", {
      code: "ABORTED",
      cause: err,
    });
  }
  return new OllamaError(`${failurePrefix}: ${(err as Error).message}`, {
    code: "NETWORK_ERROR",
    cause: err,
  });
}

function createOllamaClient({
  baseUrl = settings.ollama.url,
  requestTimeoutMs = settings.ollama.requestTimeoutMs,
  healthTimeoutMs = settings.ollama.healthTimeoutMs,
  streamIdleTimeoutMs = settings.ollama.streamIdleTimeoutMs,
  fetchImpl = globalThis.fetch,
}: OllamaClientOptions = {}) {
  if (!fetchImpl) {
    throw new OllamaError("No fetch implementation available");
  }

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
      const response = await fetchImpl(url(path), {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: composedSignal,
      });

      if (!response.ok) {
        const _payload = await response.text().catch(() => "");
        throw new OllamaError(
          `Ollama ${method} ${path} failed with ${response.status}`,
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
      const error = err as OllamaError;
      logger.debug?.("[ollama] healthCheck failed", {
        message: error.message,
        code: error.code,
      });
      return {
        reachable: false,
        baseUrl,
        error: error.message,
        code: error.code || "UNKNOWN",
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
    signal,
  }: {
    model?: string;
    input?: string | string[];
    signal?: AbortSignal;
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
      body: { model, input: values, truncate: false },
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

  async function chat({
    model = settings.ollama.defaultModel,
    messages,
    tools,
    options,
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
    if (format) body.format = format;

    const data = await request<OllamaChatResponse>("/api/chat", {
      method: "POST",
      body,
      signal,
    });

    const message: OllamaResponseMessage = data?.message || {};
    return {
      model: data?.model || model,
      role: message.role || "assistant",
      content: message.content || "",
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      done: data?.done ?? true,
      doneReason: data?.done_reason ?? null,
      evalCount: data?.eval_count ?? null,
      promptEvalCount: data?.prompt_eval_count ?? null,
      totalDurationMs: data?.total_duration
        ? Math.round(data.total_duration / 1e6)
        : null,
      raw: data,
    };
  }

  async function chatStream({
    model = settings.ollama.defaultModel,
    messages,
    tools,
    options,
    signal,
    onToken,
  }: OllamaChatStreamParams = {}) {
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
    let response: Response;
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
      await response.text?.().catch(() => "");
      throw new OllamaError(
        `Ollama POST /api/chat failed with ${response.status}`,
        {
          status: response.status,
          code: "HTTP_ERROR",
        },
      );
    }

    if (!response.body || typeof response.body.getReader !== "function") {
      cancel();
      throw new OllamaError("Ollama streaming response has no readable body", {
        code: "NO_BODY",
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let accumulatedContent = "";
    // Tool calls can arrive spread across several NDJSON chunks; accumulate
    // them all. Some Ollama builds re-emit the complete list on the final
    // done chunk, so dedupe by call signature rather than trusting order.
    const toolCalls: OllamaToolCall[] = [];
    const seenToolCallSigs = new Set<string>();
    const addToolCalls = (calls: OllamaToolCall[]) => {
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
    let totalDurationNs: number | null = null;
    let doneReason: string | null = null;
    let isDone = false;

    const handleLine = async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: OllamaChatResponse;
      try {
        parsed = JSON.parse(trimmed) as OllamaChatResponse;
      } catch (err) {
        throw new OllamaError("Ollama returned malformed NDJSON chunk", {
          code: "INVALID_JSON",
          cause: err,
        });
      }

      if (parsed.model) modelName = parsed.model;
      const msg: OllamaResponseMessage = parsed.message || {};
      const deltaContent = typeof msg.content === "string" ? msg.content : "";
      if (deltaContent) {
        accumulatedContent += deltaContent;
        try {
          await onToken?.(deltaContent);
        } catch (err) {
          logger.warn?.("[ollama] onToken handler threw", {
            error: (err as Error | null | undefined)?.message,
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
      }
    };

    try {
      while (!isDone) {
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
          await handleLine(line);
          if (isDone) break;
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
        (err as Error | null | undefined)?.name === "AbortError" ||
        composedSignal.aborted
      ) {
        throw new OllamaError("Ollama stream aborted", {
          code: "ABORTED",
          cause: err,
        });
      }
      throw new OllamaError(
        `Ollama stream read failed: ${(err as Error).message}`,
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
      totalDurationMs: totalDurationNs
        ? Math.round(totalDurationNs / 1e6)
        : null,
    };
  }

  return {
    baseUrl,
    healthCheck,
    listModels,
    embed,
    listRunningModels,
    chat,
    chatStream,
  };
}

let defaultClient: ReturnType<typeof createOllamaClient> | null = null;
export function getOllamaClient() {
  if (!defaultClient) defaultClient = createOllamaClient();
  return defaultClient;
}

export function __resetOllamaClientForTests() {
  defaultClient = null;
}

export { createOllamaClient as __createOllamaClient };
