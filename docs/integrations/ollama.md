---
title: Ollama Integration
type: integration
status: active
date: 2026-08-30
updated: 2026-08-25
tags: [integration, ollama, llm, local-ai, streaming, tool-calling, idle-timeout, tool-call-accumulation]
description: HTTP client wrapper around local Ollama for AI chat — health, model discovery, chat/stream, abort support. June 2026: per-chunk idle timeout replaces single total budget; tool calls accumulated and deduped across NDJSON chunks; request/response logs downgraded to debug.
aliases: [ollama, ollama-client, local-llm]
related_code: ["apps/node-backend/src/integrations/ollama/client.js", "apps/node-backend/src/integrations/ollama/prompts.js", "apps/node-backend/src/services/aiChatService.js"]
---

# Ollama Integration

> [!abstract] Overview
> Thin HTTP wrapper around a user-installed Ollama instance. No SDK dependency — all calls are direct `fetch` against `${OLLAMA_URL}`. Powers the [[docs/features/ai-chat|AI Chat feature]].

## Responsibilities

- Detect Ollama reachability at `OLLAMA_URL` (default `http://localhost:11434`).
- List installed models for the settings dropdown.
- Run a chat turn against `/api/chat` with tools declared and history supplied.
- Stream tokens for progressive UI rendering.
- Cancel in-flight requests on client disconnect.

## Client API

Singleton factory: `getOllamaClient()` — creates and caches a client using `settings.ollama.url` on first use.

| Method                                                             | Returns                                                                        | Notes                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `healthCheck()`                                                    | `{ reachable, baseUrl, modelCount? }` or `{ reachable, baseUrl, error, code }` | Never throws — returns `reachable:false` on failure                   |
| `listModels({ signal })`                                           | normalized model array                                                         | Throws a coded `OllamaError` on failure                               |
| `chat({ model, messages, tools, options, signal })`                | normalized content, tool calls, and usage fields                               | Non-streaming — full response in one shot, with raw response attached |
| `chatStream({ model, messages, tools, options, signal, onToken })` | normalized content, tool calls, and usage fields                               | Streams token callbacks; resolves with the assembled response         |

`listModels`, `chat`, and `chatStream` accept an `AbortSignal` so callers can cancel in-flight work. `healthCheck` uses its fixed health timeout and accepts no options.

### `healthCheck()`

Hits `GET /api/tags` with `OLLAMA_HEALTH_TIMEOUT_MS` (default 3 seconds). Returns:

```js
{ reachable: true,  baseUrl: 'http://localhost:11434', modelCount: 2 }
{ reachable: false, baseUrl: 'http://localhost:11434', error: 'connect ECONNREFUSED', code: 'NETWORK_ERROR' }
```

### `chatStream()`

Sends `POST /api/chat` with `stream: true`. Parses NDJSON chunks into:

- Text chunks → `onToken(delta)` per line
- Tool-call chunks → accumulated into a deduped array across all NDJSON chunks (see below)
- Final chunk → resolves with flat normalized fields: `{ model, role, content, toolCalls, done, doneReason, evalCount, promptEvalCount, totalDurationMs }`

#### Streaming timeout model (June 2026)

Two separate budgets apply:

1. **`requestTimeoutMs`** (`OLLAMA_REQUEST_TIMEOUT_MS`, default 600 000 ms) — deadline for the connect + prompt-eval phase, i.e. receiving the first chunk. If no chunk arrives in this window the request is aborted with `TIMEOUT`.
2. **`streamIdleTimeoutMs`** (`OLLAMA_STREAM_IDLE_TIMEOUT_MS`, default 120 000 ms) — inactivity window between chunks. The timer re-arms on every received chunk. A stream that is actively generating tokens can run for as long as the model needs; only a genuine gap of 2 minutes without a chunk triggers `TIMEOUT`.

This means total generation time is unbounded: a large model on CPU finishing a long context will not be cut off mid-generation.

#### Tool-call accumulation and deduplication (June 2026)

`chatStream` accumulates `tool_calls` from **all** NDJSON chunks into a single array. Some Ollama builds emit the complete list again on the final `done` chunk; the client deduplicates by `(id, function.name, function.arguments)` signature using a `Set<string>` of `JSON.stringify([id, name, args])`. This ensures:

- Multiple tool calls spread across separate chunks are all captured.
- Re-emissions on the final chunk do not produce duplicates.

Prior behavior (replacing `toolCalls` on each chunk) silently dropped all but the last chunk's calls when a model emitted them incrementally.

#### Logging (June 2026)

Request and response log lines inside `chatStream` were downgraded from `info` to `debug` to match the request-logging convention used elsewhere in the backend. They remain fully available when `LOG_LEVEL=debug`.

## Error Model

`OllamaError extends Error` with `code` field. Codes:

| Code            | Meaning                                                 |
| --------------- | ------------------------------------------------------- |
| `NETWORK_ERROR` | Connection refused, DNS failure, or another fetch error |
| `TIMEOUT`       | Request or stream-idle deadline exceeded                |
| `ABORTED`       | AbortSignal fired — normal for client disconnect        |
| `HTTP_ERROR`    | Ollama returned a non-success HTTP status               |
| `INVALID_JSON`  | Non-JSON response or malformed NDJSON chunk             |
| `INVALID_INPUT` | Chat was called without a message array                 |
| `NO_BODY`       | Streaming response had no readable body                 |
| `STREAM_ERROR`  | Stream reading failed for another reason                |

The service layer maps these to `AiChatServiceError` with the appropriate HTTP status (see [[docs/api/ai|AI Chat API]] error table).

## Tool-Calling Protocol

The service builds a `tools` array in Ollama's native function-calling format:

```json
{
  "type": "function",
  "function": {
    "name": "getSpendByCategory",
    "description": "Total spend per category over a date range.",
    "parameters": { "type": "object", "properties": {...}, "required": [...] }
  }
}
```

The model emits `tool_calls: [{ function: { name, arguments } }]`. The dispatcher validates `arguments` against the tool's JSON Schema and invokes the matching repository call. Result is fed back as a `role: "tool"` message in the next iteration.

Persisted history stores final assistant text and tool-result rows, but not the assistant `tool_calls` frame that originally preceded each result. Replayed history can therefore contain an orphan `role: "tool"` message. Ollama accepts this lenient shape. A future stricter provider requires either a history adapter or persistence of the original assistant tool-call frames.

See [[docs/security/ai-data-access|AI Data Access]] for the allowlist policy and [[apps/node-backend/src/services/aiChat/tools/index.js|tools/index.js]] for the registry.

## Context Window Management

- Load at most `aiChat.maxHistoryMessages` (default 30) prior message rows.
- Replay persisted tool-result JSON in full.
- No token-size budget or Ollama `num_ctx` option is currently applied. The message-count limit is therefore only a coarse bound; size-aware trimming remains tracked follow-up work.

## Configuration

| Env                             | Default                  | Purpose                                                                                    |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `OLLAMA_URL`                    | `http://localhost:11434` | Base URL                                                                                   |
| `OLLAMA_DEFAULT_MODEL`          | `llama3.1:8b`            | Fallback model                                                                             |
| `OLLAMA_REQUEST_TIMEOUT_MS`     | `600000`                 | Time-to-first-chunk budget (connect + prompt-eval phase)                                   |
| `OLLAMA_STREAM_IDLE_TIMEOUT_MS` | `120000`                 | Max inactivity between chunks; timer re-arms per chunk; total generation time is unbounded |
| `OLLAMA_HEALTH_TIMEOUT_MS`      | `3000`                   | `healthCheck()` connection timeout                                                         |

Native macOS mode fixes the default to `http://127.0.0.1:11434` in the backend child environment.
It does not use `host.docker.internal`. The optional Docker provider may use its existing host
bridge when Ollama runs outside the container.

## Offline Handling

When Ollama is unreachable:

- `GET /api/ai/status` returns `{ ok: false, ... }` — the frontend shows a banner.
- `GET /api/ai/models` returns 502.
- `POST /api/ai/chat` returns 502 with the coded provider error, normally `NETWORK_ERROR` for an unreachable host.
- `POST /api/ai/chat/stream` emits an `error` SSE frame then `res.end()`.

The rest of Vision remains fully functional. AI chat is available when Ollama is configured and `AI_CHAT_ENABLED` is true; disabling that flag makes the AI routes return 503.

## No External Calls

The Ollama client talks **only** to the configured local `OLLAMA_URL`. The service layer, tool dispatcher, and repository calls perform no outbound HTTP. This is enforced by:

- A unit test spying on `global.fetch` and asserting every call targets `OLLAMA_URL`.
- The `/docs/security/ai-data-access` guarantee.

## Related

- [[docs/features/ai-chat|Feature: AI Chat]]
- [[docs/adr/024-local-llm-chat|ADR-024: Local LLM Chat]]
- [[docs/api/ai|AI Chat API]]
- [[docs/security/ai-data-access|AI Data Access Security]]
