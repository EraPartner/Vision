---
title: Ollama Integration
type: integration
status: active
date: 2026-04-19
tags: [integration, ollama, llm, local-ai, streaming, tool-calling]
description: HTTP client wrapper around local Ollama for AI chat — health, model discovery, chat/stream, abort support
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

Singleton factory: `getOllamaClient()` — reads `settings.ollama.baseUrl`. Returns a frozen object.

| Method | Returns | Notes |
|--------|---------|-------|
| `healthCheck()` | `{ ok, baseUrl, latencyMs }` | Never throws — returns `ok:false` on network error |
| `listModels()` | `{ models: [...] }` | Throws `OllamaError` with `code: 'OLLAMA_UNREACHABLE'` when down |
| `chat({ model, messages, tools, signal })` | `{ message, usage, toolCalls }` | Non-streaming — full response in one shot |
| `chatStream({ model, messages, tools, signal, onToken, onToolCall })` | `{ message, usage, toolCalls }` | Streams tokens via callbacks; resolves with final assembled response |

All methods accept an `AbortSignal` so the service layer can cancel on client disconnect.

### `healthCheck()`

Hits `GET /` (Ollama's banner endpoint) with a 2s timeout. Returns:

```js
{ ok: true,  baseUrl: 'http://localhost:11434', latencyMs: 12 }
{ ok: false, baseUrl: 'http://localhost:11434', error: 'connect ECONNREFUSED' }
```

### `chatStream()`

Sends `POST /api/chat` with `stream: true`. Parses NDJSON chunks into:

- Text chunks → `onToken(delta)` per line
- Tool-call chunks → `onToolCall({ name, args })` once args finalize
- Final chunk → resolves promise with aggregated `{ message, usage, toolCalls }`

## Error Model

`OllamaError extends Error` with `code` field. Codes:

| Code | Meaning |
|------|---------|
| `OLLAMA_UNREACHABLE` | Connection refused or DNS failure |
| `OLLAMA_TIMEOUT` | Deadline exceeded |
| `OLLAMA_MODEL_NOT_FOUND` | Requested model not installed |
| `OLLAMA_BAD_RESPONSE` | Malformed NDJSON / unexpected schema |
| `OLLAMA_ABORTED` | AbortSignal fired — normal for client disconnect |

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

See [[docs/security/ai-data-access|AI Data Access]] for the allowlist policy and [[apps/node-backend/src/services/aiChat/tools/index.js|tools/index.js]] for the registry.

## Context Window Management

- Load at most `aiChat.maxHistoryMessages` (default 20) prior messages.
- Trim tool-result payloads in history — keep the assistant summary, drop the raw JSON rows.
- If the estimated token count exceeds the model's limit, drop oldest pairs first.

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `OLLAMA_URL` | `http://localhost:11434` | Base URL |
| `OLLAMA_DEFAULT_MODEL` | `llama3.2:3b` | Fallback model |
| `OLLAMA_REQUEST_TIMEOUT_MS` | 600000 | Per-chat deadline |

## Offline Handling

When Ollama is unreachable:

- `GET /api/ai/status` returns `{ ok: false, ... }` — the frontend shows a banner.
- `GET /api/ai/models` returns 502.
- `POST /api/ai/chat` returns 502 with `code: OLLAMA_UNREACHABLE`.
- `POST /api/ai/chat/stream` emits an `error` SSE frame then `res.end()`.

The rest of Vision remains fully functional — the AI chat feature is always available when Ollama is configured (no runtime feature flag gates).

## No External Calls

The Ollama client talks **only** to the configured local `OLLAMA_URL`. The service layer, tool dispatcher, and repository calls perform no outbound HTTP. This is enforced by:

- A unit test spying on `global.fetch` and asserting every call targets `OLLAMA_URL`.
- The `/docs/security/ai-data-access` guarantee.

## Related

- [[docs/features/ai-chat|Feature: AI Chat]]
- [[docs/adr/024-local-llm-chat|ADR-024: Local LLM Chat]]
- [[docs/api/ai|AI Chat API]]
- [[docs/security/ai-data-access|AI Data Access Security]]
