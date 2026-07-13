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

import { logger } from '../../config/logger.js';
import settings from '../../config/config.js';

export class OllamaError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number|null, cause?: unknown, code?: string|null }} [options]
   */
  constructor(message, { status, cause, code } = {}) {
    super(message);
    this.name = 'OllamaError';
    this.status = status ?? null;
    this.code = code ?? null;
    if (cause) this.cause = cause;
  }
}

function withTimeout(signal, timeoutMs) {
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
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
  }

  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
    isTimeout: () => timedOut,
    /** Restart the timer with a new window (used per streamed chunk). */
    rearm: (ms) => {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, ms);
    },
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new OllamaError('Ollama returned non-JSON response', {
      status: response.status,
      cause: err,
      code: 'INVALID_JSON',
    });
  }
}

/**
 * Map a fetch-layer error to a typed OllamaError (timeout / aborted / network),
 * shared by the request and chatStream paths (SIMP-38). An OllamaError already
 * in flight is passed through unchanged.
 * @param {unknown} err
 * @param {{ isTimeout: boolean, aborted: boolean, timeoutMessage: string, failurePrefix: string }} ctx
 * @returns {OllamaError}
 */
function normalizeFetchError(err, { isTimeout, aborted, timeoutMessage, failurePrefix }) {
  if (err instanceof OllamaError) return err;
  if (isTimeout) return new OllamaError(timeoutMessage, { code: 'TIMEOUT', cause: err });
  if (err?.name === 'AbortError' || aborted) {
    return new OllamaError('Ollama request aborted', { code: 'ABORTED', cause: err });
  }
  return new OllamaError(`${failurePrefix}: ${err.message}`, { code: 'NETWORK_ERROR', cause: err });
}

export function createOllamaClient({
  baseUrl = settings.ollama.url,
  requestTimeoutMs = settings.ollama.requestTimeoutMs,
  healthTimeoutMs = settings.ollama.healthTimeoutMs,
  streamIdleTimeoutMs = settings.ollama.streamIdleTimeoutMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!fetchImpl) {
    throw new OllamaError('No fetch implementation available');
  }

  const url = (path) => `${baseUrl}${path}`;

  /**
   * @param {string} path
   * @param {{ method?: string, body?: any, signal?: AbortSignal, timeoutMs?: number }} [options]
   */
  async function request(path, { method = 'GET', body, signal, timeoutMs = requestTimeoutMs } = {}) {
    const { signal: composedSignal, cancel, isTimeout } = withTimeout(signal, timeoutMs);
    try {
      const response = await fetchImpl(url(path), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: composedSignal,
      });

      if (!response.ok) {
        const _payload = await response.text().catch(() => '');
        throw new OllamaError(
          `Ollama ${method} ${path} failed with ${response.status}`,
          { status: response.status, code: 'HTTP_ERROR' },
        );
      }

      return await readJson(response);
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
      const data = await request('/api/tags', { timeoutMs: healthTimeoutMs });
      return {
        reachable: true,
        baseUrl,
        modelCount: Array.isArray(data?.models) ? data.models.length : 0,
      };
    } catch (err) {
      logger.debug?.('[ollama] healthCheck failed', { message: err.message, code: err.code });
      return {
        reachable: false,
        baseUrl,
        error: err.message,
        code: err.code || 'UNKNOWN',
      };
    }
  }

  /**
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function listModels({ signal } = {}) {
    const data = await request('/api/tags', { signal, timeoutMs: healthTimeoutMs });
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

  /**
   * @param {{ model?: string, messages: any[], tools?: any[], options?: any, signal?: AbortSignal }} params
   */
  async function chat({
    model = settings.ollama.defaultModel,
    messages,
    tools,
    options,
    signal,
  }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new OllamaError('chat requires a non-empty messages array', { code: 'INVALID_INPUT' });
    }

    /** @type {Record<string, any>} */
    const body = {
      model,
      messages,
      stream: false,
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (options) body.options = options;

    const data = /** @type {any} */ (await request('/api/chat', {
      method: 'POST',
      body,
      signal,
    }));

    const message = data?.message || {};
    return {
      model: data?.model || model,
      role: message.role || 'assistant',
      content: message.content || '',
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      done: data?.done ?? true,
      doneReason: data?.done_reason ?? null,
      evalCount: data?.eval_count ?? null,
      promptEvalCount: data?.prompt_eval_count ?? null,
      totalDurationMs: data?.total_duration ? Math.round(data.total_duration / 1e6) : null,
      raw: data,
    };
  }

  /**
   * @param {{ model?: string, messages?: any[], tools?: any[], options?: any, signal?: AbortSignal, onToken?: (chunk: string) => void|Promise<void> }} [params]
   */
  async function chatStream({
    model = settings.ollama.defaultModel,
    messages,
    tools,
    options,
    signal,
    onToken,
  } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new OllamaError('chatStream requires a non-empty messages array', {
        code: 'INVALID_INPUT',
      });
    }

    /** @type {Record<string, any>} */
    const body = {
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
    const { signal: composedSignal, cancel, isTimeout, rearm } = withTimeout(signal, requestTimeoutMs);
    logger.debug('[ollama] chatStream request', {
      url: url('/api/chat'),
      model,
      messageCount: messages.length,
      toolCount: tools?.length ?? 0,
      timeoutMs: requestTimeoutMs,
      idleTimeoutMs: streamIdleTimeoutMs,
    });
    let response;
    try {
      response = await fetchImpl(url('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: composedSignal,
      });
      logger.debug('[ollama] chatStream response received', {
        status: response.status,
        contentType: response.headers?.get?.('content-type') ?? null,
      });
    } catch (err) {
      cancel();
      throw normalizeFetchError(err, {
        isTimeout: isTimeout(),
        aborted: composedSignal.aborted,
        timeoutMessage: `Ollama request timed out after ${requestTimeoutMs}ms`,
        failurePrefix: 'Ollama POST /api/chat failed',
      });
    }

    if (!response.ok) {
      cancel();
      await response.text?.().catch(() => '');
      throw new OllamaError(`Ollama POST /api/chat failed with ${response.status}`, {
        status: response.status,
        code: 'HTTP_ERROR',
      });
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
      cancel();
      throw new OllamaError('Ollama streaming response has no readable body', {
        code: 'NO_BODY',
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulatedContent = '';
    // Tool calls can arrive spread across several NDJSON chunks; accumulate
    // them all. Some Ollama builds re-emit the complete list on the final
    // done chunk, so dedupe by call signature rather than trusting order.
    const toolCalls = [];
    const seenToolCallSigs = new Set();
    const addToolCalls = (calls) => {
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
    let evalCount = null;
    let promptEvalCount = null;
    let totalDurationNs = null;
    let doneReason = null;
    let isDone = false;

    const handleLine = async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new OllamaError('Ollama returned malformed NDJSON chunk', {
          code: 'INVALID_JSON',
          cause: err,
        });
      }

      if (parsed.model) modelName = parsed.model;
      const msg = parsed.message || {};
      const deltaContent = typeof msg.content === 'string' ? msg.content : '';
      if (deltaContent) {
        accumulatedContent += deltaContent;
        try {
          await onToken?.(deltaContent);
        } catch (err) {
          logger.warn?.('[ollama] onToken handler threw', { error: err?.message });
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
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
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
          { code: 'TIMEOUT', cause: err },
        );
      }
      if (err?.name === 'AbortError' || composedSignal.aborted) {
        throw new OllamaError('Ollama stream aborted', { code: 'ABORTED', cause: err });
      }
      throw new OllamaError(`Ollama stream read failed: ${err.message}`, {
        cause: err,
        code: 'STREAM_ERROR',
      });
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
      role: 'assistant',
      content: accumulatedContent,
      toolCalls,
      done: isDone,
      doneReason,
      evalCount,
      promptEvalCount,
      totalDurationMs: totalDurationNs ? Math.round(totalDurationNs / 1e6) : null,
    };
  }

  return {
    baseUrl,
    healthCheck,
    listModels,
    chat,
    chatStream,
  };
}

let defaultClient = null;
export function getOllamaClient() {
  if (!defaultClient) defaultClient = createOllamaClient();
  return defaultClient;
}

export function __resetOllamaClientForTests() {
  defaultClient = null;
}
