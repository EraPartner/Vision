---
title: AI Chat API
type: api
status: active
date: 2026-05-03
updated: 2026-06-11
tags: [api, ai, chat, ollama, sse, streaming, llm, phase-1, idle-timeout, tool-call-accumulation]
description: Local AI chat endpoints — Ollama status, model discovery, conversation CRUD, chat turn (JSON + SSE) with tools opt-out toggle and 30 tool-calling tools. All responses use camelCase field names. June 2026: streaming uses per-chunk idle timeout (OLLAMA_STREAM_IDLE_TIMEOUT_MS) instead of a fixed total budget; tool calls accumulated across all NDJSON chunks and deduped.
aliases: [ai api, chat api, ollama api, ai endpoints]
---

# AI Chat API

> [!abstract] Overview
> All `/api/ai/*` endpoints proxy to a **local Ollama** instance. No data leaves the machine. When `AI_CHAT_ENABLED` is `false` every endpoint returns `503 { "ok": false, "error": { "code": "AI_CHAT_DISABLED", "message": "AI chat is disabled" } }`.

## Endpoint Map

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ai/status` | Ollama reachability + default model |
| GET | `/api/ai/models` | Installed models (pass-through) |
| GET | `/api/ai/conversations` | List conversations (newest first) |
| POST | `/api/ai/conversations` | Create empty conversation |
| GET | `/api/ai/conversations/:id` | Conversation + messages |
| PATCH | `/api/ai/conversations/:id` | Rename |
| DELETE | `/api/ai/conversations/:id` | Delete (cascades messages) |
| POST | `/api/ai/chat` | One-shot chat turn (JSON) |
| POST | `/api/ai/chat/stream` | Chat turn as SSE stream |

All error responses use `{detail: string}` with optional `{code: string}` for typed service errors.

## GET /api/ai/status

Ollama reachability + configured defaults.

**Response 200:**
```json
{
  "ok": true,
  "baseUrl": "http://localhost:11434",
  "latencyMs": 12,
  "defaultModel": "llama3.2:3b",
  "enabled": true
}
```

When Ollama is unreachable the route still returns 200 with `{"ok": false, ...}` — callers render a banner rather than treating it as a server error.

## GET /api/ai/models

Pass-through of `GET /api/tags` from Ollama.

**Response 200:**
```json
{
  "models": [
    { "name": "llama3.2:3b", "size": 2100000000, "modified": "2026-04-10T08:12:00Z" }
  ]
}
```

**Response 502** when Ollama is down:
```json
{ "ok": false, "error": { "code": "OLLAMA_UNREACHABLE", "message": "Ollama not reachable: connect ECONNREFUSED" } }
```

## GET /api/ai/conversations

List conversations newest-first. All fields use camelCase (e.g., `createdAt`, `updatedAt`).

**Response 200:** canonical collection body `{ items, total }`, where each item is `{ id, title, model, createdAt, updatedAt }`. The list is unpaginated, so `total` is the row count. There is no message count in the payload — the list query selects only these five columns.

## POST /api/ai/conversations

Create an empty conversation. Optional `title` (≤200 chars) and `model`.

**Body:**
```json
{ "title": "Tax questions", "model": "llama3.2:3b" }
```

**Response 201:** 
```json
{
  "conversation": { "id": "...", "title": "...", "model": "...", "createdAt": "...", "updatedAt": "..." },
  "messages": []
}
```

**400** when `title` > 200 chars or `model` is empty string.

## GET /api/ai/conversations/:id

Conversation with messages. `id` must be a UUID. All timestamps and nested fields use camelCase (e.g., `createdAt`, `conversationId`, `toolName`, `toolArgs`, `toolResult`).

**Response 200:**
```json
{
  "conversation": { "id": "...", "title": "...", "model": "...", "createdAt": "...", "updatedAt": "..." },
  "messages": [
    { "id": "...", "conversationId": "...", "role": "user", "content": "...", "createdAt": "..." },
    { "id": "...", "conversationId": "...", "role": "assistant", "content": "...", "createdAt": "..." },
    { "id": "...", "conversationId": "...", "role": "tool", "toolName": "getSpendByCategory", "toolArgs": {...}, "toolResult": {...}, "createdAt": "..." }
  ]
}
```

**400** — invalid UUID. **404** — not found.

## PATCH /api/ai/conversations/:id

Rename. Body: `{ "title": "..." }` (required, trimmed, ≤200 chars).

**Response 200:** Updated conversation row. **400** / **404** as above.

## DELETE /api/ai/conversations/:id

Delete a conversation. Messages cascade via FK.

**Response 204** on success. **404** when not found.

> [!info] Frontend coordination
> Frontend clears `selectedId` **before** awaiting `deleteMut.mutateAsync()` to prevent a race where in-flight `useConversation(deletedId)` queries trigger 404s. Backend hook uses `removeQueries` for the detail key before `invalidateQueries` on the list key with `exact: true` to prevent prefix-matching and re-triggering nested detail fetches.

## POST /api/ai/chat

Non-streaming chat turn — runs the tool loop to completion then returns the full turn.

**Body:**
```json
{
  "conversationId": "uuid-or-null",
  "message": "biggest expense category in 2025?",
  "model": "llama3.2:3b",
  "useTools": true
}
```

- `message` required; trimmed; ≤4000 chars.
- `conversationId` null → creates a new conversation.
- `model` optional; falls back to `ollama.defaultModel`.
- `useTools` optional boolean (default `true`); when `false`, the backend passes `tools: undefined` to Ollama, disabling all tool-calling and returning text-only responses.

**Response 200:**
```json
{
  "conversation": { "id": "...", "title": "...", "model": "...", "createdAt": "...", "updatedAt": "..." },
  "userMessage":      { "id": "...", "conversationId": "...", "role": "user", "content": "...", "createdAt": "..." },
  "toolMessages":     [{ "id": "...", "conversationId": "...", "role": "tool", "toolName": "...", "toolArgs": {...}, "toolResult": {...}, "createdAt": "..." }],
  "assistantMessage": { "id": "...", "conversationId": "...", "role": "assistant", "content": "...", "createdAt": "..." },
  "usage":      { "evalCount": 123, "promptEvalCount": 456, "totalDurationMs": 579 },
  "iterations": 2
}
```

**400** — validation error. Typed service errors map to their native status + code:

| HTTP | `code` | Meaning |
|------|--------|---------|
| 400 | `VALIDATION_ERROR` | Zod validation on tool args |
| 404 | `CONVERSATION_NOT_FOUND` | `conversationId` does not exist |
| 502 | `OLLAMA_UNREACHABLE` | Ollama down mid-turn |
| 504 | `OLLAMA_TIMEOUT` | Tool loop exceeded deadline |
| 500 | `AI_CHAT_ERROR` | Fallback |

## POST /api/ai/chat/stream

Same contract as `/chat` but streamed over Server-Sent Events. Uses backpressure-aware writer (Phase 3.2) to prevent unbounded memory growth.

**Request headers / body:** identical to `/chat`. **Response:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`.

**Backpressure Handling (Phase 3.2):**
- Server uses `createSseWriter(req, res)` [[apps/node-backend/src/lib/sse.js]] to track client lifecycle and propagate TCP write buffer backpressure.
- When Node.js signals write buffer is full (`res.writableNeedDrain`), `await writer.write()` pauses the token-streaming loop until the kernel drains pending data, preventing memory exhaustion.
- If client disconnects mid-stream, the server stops writing immediately and no further frames are emitted.

### Event Sequence

For a turn that invokes one tool then streams the assistant reply:

```text
event: user_message
data: { "message": { "id": "...", "role": "user", ... } }

event: token
data: "The "

event: token
data: "biggest "

event: tool_call
data: { "name": "getSpendByCategory", "args": { "from": "2025-01-01", "to": "2025-12-31" } }

event: tool_result
data: { "message": { "role": "tool", "toolName": "getSpendByCategory", "toolResult": {...} } }

event: token
data: "category "

event: done
data: {
  "conversation": {...},
  "assistantMessage": {...},
  "usage": {...},
  "iterations": 2
}
```

### Event Reference

| Event | Payload | When |
|-------|---------|------|
| `user_message` | `{ message }` | Persisted user row (camelCase fields) — first event |
| `token` | `"delta"` (string) | Assistant content chunk |
| `tool_call` | `{ name, args }` | Model requested a tool — before dispatch |
| `tool_result` | `{ message }` | Tool row persisted (camelCase fields; result in `message.toolResult`) |
| `done` | `{ conversation, assistantMessage, usage, iterations }` | Terminal success (all fields camelCase) |
| `error` | `{ detail, code? }` | Terminal failure — `code` present for `AiChatServiceError` |

> [!info] Disconnect
> Route registers `res.on('close')` to detect client disconnect and abort the `AbortController`. Mid-turn Ollama calls are cancelled; no further SSE frames are written. The assistant message is already persisted in the DB before `done` fires, so a late disconnect does not leak orphans. (Note: listening on `req.on('close')` is unsafe—Node's Readable streams emit `close` after the request body is consumed by middleware, before SSE events are emitted.)

> [!warning] Error semantics
> On `error` the server emits the frame and calls `res.end()`. No `done` follows. Internal error messages are not leaked — generic failures surface as `"Failed to stream AI chat message"`.

## Validation

| Field | Rule |
|-------|------|
| `conversationId` | UUID v4 pattern or null |
| `message` | non-empty string, ≤4000 chars |
| `model` | non-empty string or omitted |
| `useTools` | optional boolean (default `true`) |
| `title` (CRUD) | non-empty string (PATCH), ≤200 chars |

`MAX_MESSAGE_LENGTH = 4000`, `MAX_TITLE_LENGTH = 200` — hardcoded in [[apps/node-backend/src/routes/ai.js|routes/ai.js]].

## Rate Limiting

| Endpoint | Limit |
|----------|-------|
| `POST /api/ai/chat` | 30 req/min |
| `POST /api/ai/chat/stream` | 30 req/min |
| Other `/api/ai/*` | standard |

Chat endpoints are per-IP rate-limited because each request fans out to Ollama + one or more repo queries.

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `AI_CHAT_ENABLED` | `true` | Kill switch — disables all endpoints |
| `OLLAMA_URL` | `http://localhost:11434` | Base URL for Ollama |
| `OLLAMA_DEFAULT_MODEL` | `llama3.1:8b` | Fallback when the request omits `model` |
| `OLLAMA_REQUEST_TIMEOUT_MS` | `600000` | Time-to-first-chunk budget (connect + prompt-eval phase only) |
| `OLLAMA_STREAM_IDLE_TIMEOUT_MS` | `120000` | Per-chunk inactivity window for streaming; re-arms on every chunk; total generation time is unbounded |
| `AI_CHAT_MAX_HISTORY` | `30` | Messages retained when building prompt context |

See [[docs/reference/environment-variables|Environment Variables]].

## Related

- [[docs/features/ai-chat|Feature: AI Chat]]
- [[docs/adr/024-local-llm-chat|ADR-024: Local LLM Chat]]
- [[docs/integrations/ollama|Ollama Integration]]
- [[docs/security/ai-data-access|AI Data Access Security]]
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]
