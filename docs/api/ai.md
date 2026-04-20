---
title: AI Chat API
type: api
status: active
date: 2026-04-20
tags: [api, ai, chat, ollama, sse, streaming, llm]
description: Local AI chat endpoints — Ollama status, model discovery, conversation CRUD, chat turn (JSON + SSE) with 30 tool-calling tools
aliases: [ai api, chat api, ollama api, ai endpoints]
---

# AI Chat API

> [!abstract] Overview
> All `/api/ai/*` endpoints proxy to a **local Ollama** instance. No data leaves the machine. When `aiChat.enabled` is `false` every endpoint returns `503 {"detail": "AI chat is disabled"}`.

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
{ "detail": "Ollama not reachable: connect ECONNREFUSED", "code": "OLLAMA_UNREACHABLE" }
```

## GET /api/ai/conversations

List conversations newest-first.

**Response 200:** Array of `{ id, title, model, createdAt, updatedAt, messageCount }`.

## POST /api/ai/conversations

Create an empty conversation. Optional `title` (≤200 chars) and `model`.

**Body:**
```json
{ "title": "Tax questions", "model": "llama3.2:3b" }
```

**Response 201:** Full conversation record with empty messages array.

**400** when `title` > 200 chars or `model` is empty string.

## GET /api/ai/conversations/:id

Conversation with messages. `id` must be a UUID.

**Response 200:**
```json
{
  "conversation": { "id": "...", "title": "...", "model": "...", "updatedAt": "..." },
  "messages": [
    { "id": "...", "role": "user", "content": "...", "createdAt": "..." },
    { "id": "...", "role": "assistant", "content": "...", "createdAt": "..." },
    { "id": "...", "role": "tool", "toolName": "getSpendByCategory", "toolArgs": {...}, "toolResult": {...}, "createdAt": "..." }
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

## POST /api/ai/chat

Non-streaming chat turn — runs the tool loop to completion then returns the full turn.

**Body:**
```json
{
  "conversationId": "uuid-or-null",
  "message": "biggest expense category in 2025?",
  "model": "llama3.2:3b"
}
```

- `message` required; trimmed; ≤8000 chars.
- `conversationId` null → creates a new conversation.
- `model` optional; falls back to `ollama.defaultModel`.

**Response 200:**
```json
{
  "conversation": { "id": "...", "title": "...", "model": "...", "updatedAt": "..." },
  "userMessage":      { "id": "...", "role": "user", "content": "...", "createdAt": "..." },
  "toolMessages":     [{ "role": "tool", "toolName": "...", "toolArgs": {...}, "toolResult": {...} }],
  "assistantMessage": { "id": "...", "role": "assistant", "content": "...", "createdAt": "..." },
  "usage":      { "promptTokens": 123, "completionTokens": 456, "totalTokens": 579 },
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

Same contract as `/chat` but streamed over Server-Sent Events. Mirror of the CSV-import SSE pattern.

**Request headers / body:** identical to `/chat`. **Response:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`.

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
| `user_message` | `{ message }` | Persisted user row — first event |
| `token` | `"delta"` (string) | Assistant content chunk |
| `tool_call` | `{ name, args }` | Model requested a tool — before dispatch |
| `tool_result` | `{ message }` | Tool row persisted (result in `message.toolResult`) |
| `done` | `{ conversation, assistantMessage, usage, iterations }` | Terminal success |
| `error` | `{ detail, code? }` | Terminal failure — `code` present for `AiChatServiceError` |

> [!info] Disconnect
> Route registers `req.on('close')` → `AbortController.abort()`. Mid-turn Ollama calls are cancelled; no further SSE frames are written. The assistant message is already persisted in the DB before `done` fires, so a late disconnect does not leak orphans.

> [!warning] Error semantics
> On `error` the server emits the frame and calls `res.end()`. No `done` follows. Internal error messages are not leaked — generic failures surface as `"Failed to stream AI chat message"`.

## Validation

| Field | Rule |
|-------|------|
| `conversationId` | UUID v4 pattern or null |
| `message` | non-empty string, ≤8000 chars |
| `model` | non-empty string or omitted |
| `title` (CRUD) | non-empty string (PATCH), ≤200 chars |

`MAX_MESSAGE_LENGTH = 8000`, `MAX_TITLE_LENGTH = 200` — hardcoded in [[apps/node-backend/src/routes/ai.js|routes/ai.js]].

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
| `OLLAMA_DEFAULT_MODEL` | `llama3.2:3b` | Fallback when the request omits `model` |
| `AI_CHAT_MAX_HISTORY` | 20 | Messages retained when building prompt context |

See [[docs/reference/environment-variables|Environment Variables]].

## Related

- [[docs/features/ai-chat|Feature: AI Chat]]
- [[docs/adr/024-local-llm-chat|ADR-024: Local LLM Chat]]
- [[docs/integrations/ollama|Ollama Integration]]
- [[docs/security/ai-data-access|AI Data Access Security]]
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]
