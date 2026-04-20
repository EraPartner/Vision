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
  const timer = setTimeout(() => {
    controller.abort(new OllamaError('Ollama request timed out', { code: 'TIMEOUT' }));
  }, timeoutMs);

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
  }

  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
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

export function createOllamaClient({
  baseUrl = settings.ollama.url,
  requestTimeoutMs = settings.ollama.requestTimeoutMs,
  healthTimeoutMs = settings.ollama.healthTimeoutMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!fetchImpl) {
    throw new OllamaError('No fetch implementation available');
  }

  const url = (path) => `${baseUrl}${path}`;

  async function request(path, { method = 'GET', body, signal, timeoutMs = requestTimeoutMs } = {}) {
    const { signal: composedSignal, cancel } = withTimeout(signal, timeoutMs);
    try {
      const response = await fetchImpl(url(path), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: composedSignal,
      });

      if (!response.ok) {
        const payload = await response.text().catch(() => '');
        throw new OllamaError(
          `Ollama ${method} ${path} failed with ${response.status}`,
          { status: response.status, code: 'HTTP_ERROR' },
        );
      }

      return await readJson(response);
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      if (err?.name === 'AbortError') {
        throw new OllamaError('Ollama request aborted', { code: 'ABORTED', cause: err });
      }
      throw new OllamaError(`Ollama ${method} ${path} failed: ${err.message}`, {
        cause: err,
        code: 'NETWORK_ERROR',
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

    const body = {
      model,
      messages,
      stream: false,
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (options) body.options = options;

    const data = await request('/api/chat', {
      method: 'POST',
      body,
      signal,
    });

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

    const body = {
      model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (options) body.options = options;

    const { signal: composedSignal, cancel } = withTimeout(signal, requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(url('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: composedSignal,
      });
    } catch (err) {
      cancel();
      if (err?.name === 'AbortError') {
        throw new OllamaError('Ollama request aborted', { code: 'ABORTED', cause: err });
      }
      throw new OllamaError(`Ollama POST /api/chat failed: ${err.message}`, {
        cause: err,
        code: 'NETWORK_ERROR',
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
    let toolCalls = [];
    let modelName = model;
    let evalCount = null;
    let promptEvalCount = null;
    let totalDurationNs = null;
    let doneReason = null;
    let isDone = false;

    const handleLine = (line) => {
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
          onToken?.(deltaContent);
        } catch (err) {
          logger.warn?.('[ollama] onToken handler threw', { error: err?.message });
        }
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        toolCalls = msg.tool_calls;
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
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          handleLine(line);
          if (isDone) break;
        }
      }
      if (buffer.length > 0) handleLine(buffer);
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      if (err?.name === 'AbortError') {
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
