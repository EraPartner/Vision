---
title: ADR-024 Local LLM Chat Integration
type: adr
status: Accepted
date: 2026-04-19
tags: [adr, ai, llm, ollama, chat, privacy, tool-calling]
description: Local-only AI chat for natural-language financial queries using Ollama with tool-calling architecture
aliases: [adr-024, ai chat, ollama, local llm, financial chat, natural language queries]
---

# ADR-024: Local LLM Chat Integration

## Status
Accepted

## Date
2026-04-19

## Context

Vision holds rich financial data (transactions, portfolio, planned transactions, Belgian tax) in Postgres. Users want to query this data with natural language — "biggest expense category in 2025?", "best-performing investment YTD?", "how much did I spend on subscriptions last month?" — without leaving the app.

**Privacy constraint (non-negotiable):** Vision is a local-first personal finance tool. Financial data must never be transmitted to third-party AI providers (OpenAI, Anthropic, Google, etc.). All AI processing must run on the user's own machine.

**Architectural fork:** Given a local LLM, two approaches to bridge natural language and structured data:

1. **Text-to-SQL** — LLM generates SQL directly against a read-only view. Flexible but vulnerable to hallucinated schema, incorrect numbers, SQL injection surface, and requires strict sandboxing (row limits, allowlists, read-only DB role).
2. **Tool-calling** — LLM selects from a fixed registry of pre-built query tools. Backend validates args, runs the query via existing repositories, returns ground-truth numbers to the LLM for narration. Less flexible, safer, predictable.

Small local models (3B–8B parameters, the realistic range for consumer hardware) are unreliable at SQL generation but competent at tool-calling when given tight JSON Schemas. A hallucinated number in a financial app is worse than no answer.

## Decision

### 1. Local LLM via Ollama
- Integrate with **Ollama** (http://localhost:11434 default) as the sole LLM provider.
- Ollama is **user-installed**, app auto-detects. No Docker bundling, no install bloat.
- `OLLAMA_URL` env var overridable to point at a LAN/remote Ollama instance for power users.
- No external LLM APIs reachable from the service layer — enforced by code review and tests spying on outbound HTTP.

### 2. Tool-Calling Architecture
- LLM receives user message + system prompt + tool registry (JSON Schema).
- LLM emits `{tool: "name", args: {...}}`.
- Backend validates args against Zod schema, dispatches to existing repositories, returns `{ok, data, meta, renderAs}` payload.
- LLM narrates the result in natural language. System prompt: **"Never cite figures not returned by a tool."**
- Tool registry is the only path to data — no raw SQL, no schema exposure to the LLM.

### 3. User Picks Model
- Settings page exposes a dropdown of 3–4 vetted models (e.g., Llama 3.1 8B Instruct, Qwen 2.5 7B, Llama 3.2 3B) with RAM/size badges.
- Hardware varies across users; no forced default beyond a recommendation.
- Per-conversation model override supported (stored on `ai_conversations.model`).

### 4. Persistent Conversations
- New tables `ai_conversations` and `ai_messages` in Postgres.
- Users can list, rename, delete, resume past chats.
- Each `ai_message` stores role (`user`/`assistant`/`tool`/`system`), content, and when relevant tool name, args, and result JSONB. Acts as an audit log.

### 5. SSE Token Streaming
- `POST /api/ai/chat` returns a Server-Sent Events stream.
- Events: `token`, `tool_call`, `tool_result`, `done`, `error`.
- Reuses the existing SSE pattern from CSV import ([apps/node-backend/src/routes/import.js](apps/node-backend/src/routes/import.js)).
- Client uses a dedicated `apiClient.streamChat()` helper with `AbortController` support.

### 6. English Only (v1)
- LLM is prompted in English regardless of user's active UI locale.
- UI chrome remains i18n (en/nl) — labels, errors, buttons translated.
- Dutch LLM support deferred until quality can be validated per model.

### 7. Full Data Scope
- All four domains queryable via tools: transactions & categories, portfolio, planned/recurring transactions, Belgian tax.
- Rate limit: 30 req/min on `/api/ai/chat`; standard limits on CRUD endpoints.
- No per-domain opt-in gating in v1 (single-user local app; user owns the data).

## Consequences

### Positive

- **Privacy preserved** — no financial data ever leaves the machine.
- **Ground-truth numbers** — every figure in the response traces back to a tool call with validated args; no hallucinated math.
- **Safe surface** — no dynamic SQL from untrusted LLM output; tool registry is the only entry to the data layer.
- **Reuses existing infrastructure** — repositories, SSE pattern, Recharts, TanStack Query, i18n system.
- **Per-message audit trail** — `ai_messages.tool_name`/`tool_args`/`tool_result` captures exactly what the LLM asked for and got.
- **Small install footprint** — no bundled model weights; user manages Ollama lifecycle.

### Neutral

- **Tool registry is the bottleneck** — new query types require a new tool + schema + test. Deliberate trade-off for safety.
- **Hardware dependency** — response quality and latency depend on the user's machine. First-token latency 1–5s is normal on Apple Silicon with 7B–8B models.
- **Model choice** — user picks; some models will tool-call better than others. Documented in the setup guide.

### Negative

- **Requires Ollama installed** — setup friction for first-time users. Mitigation: `OllamaStatusBanner` on the chat page with a link to the setup guide.
- **Context window** — long conversations must be trimmed; history beyond last N turns summarized or dropped.
- **Streaming abort edge cases** — aborted requests need cleanup (`req.on('close')` handler marks the in-flight assistant message).

## Alternatives Considered

### Alternative A — External LLM (OpenAI/Anthropic)
- Rejected. Violates the privacy constraint. Not viable for this product.

### Alternative B — Text-to-SQL with a local model
- Rejected for v1. Small-model SQL quality is inconsistent; mitigations (row limits, read-only role, allowlists, syntax validation, result sanitization) recreate most of the tool-calling surface anyway. Tool-calling offers the same UX with stronger guarantees.

### Alternative C — RAG over the database
- Rejected for v1. Embeddings over financial rows add complexity without obvious benefit when the access pattern is aggregate-heavy. Revisit if free-form search over memos/notes becomes a priority.

### Alternative D — Bundled Ollama via Docker
- Rejected. Increases install size significantly, couples the app to Docker Desktop on macOS, and duplicates functionality for users who already run Ollama.

## Implementation

### Code Changes

1. **Backend — new route, service, integration layer:**
   - `apps/node-backend/src/routes/ai.js` — `POST /api/ai/chat` (SSE), conversation CRUD, Ollama status + model list
   - `apps/node-backend/src/services/aiChatService.js` — orchestrator (history load, prompt build, tool loop, persistence)
   - `apps/node-backend/src/integrations/ollama/client.js` — HTTP wrapper (`healthCheck`, `listModels`, `chatStream`)
   - `apps/node-backend/src/integrations/ollama/prompts.js` — system prompt with tool-call instructions
   - `apps/node-backend/src/services/aiChat/tools/` — tool registry (expenses, portfolio, planned, tax)
   - `apps/node-backend/src/repositories/aiChatRepository.js` — conversation + message CRUD

2. **Database — migration:**
   - `alembic/versions/xxxx_add_ai_chat_tables.py` — `ai_conversations`, `ai_messages`, indexed by conversation + created_at

3. **Frontend — new page, hooks, UI components:**
   - `apps/frontend/src/pages/AIChatPage.tsx` — page shell
   - `apps/frontend/src/features/ai-chat/` — chat components
   - `apps/frontend/src/hooks/useAIChat.ts`, `useOllamaStatus.ts` — data hooks
   - `apps/frontend/src/lib/api.ts` — SSE-aware `streamChat` helper
   - `apps/frontend/src/components/layout/AppSidebar.tsx` — global "AI Chat" nav entry above the workspace switcher
   - `apps/frontend/src/pages/SettingsPage.tsx` — Ollama URL + model dropdown

4. **Configuration:**
   - `OLLAMA_URL` (default `http://localhost:11434`)
   - `OLLAMA_DEFAULT_MODEL` (e.g., `llama3.1:8b`)
   - `AI_CHAT_RATE_LIMIT` (default 30/min)

### Testing

```bash
# Unit — tool schema validation, Ollama client retry/abort/stream parsing, prompt builder trimming
# Integration — real Postgres + mock Ollama, full chat loop, message persistence
# E2E (Playwright) — open /ai-chat, send query, assert SSE tokens, assert ToolResultCard renders table + chart
# Security — rate limit trip, unknown tool rejection, no outbound HTTP to external LLM hosts
# Offline — Ollama unreachable → banner + friendly error, no crash
```

## Updates

### 2026-05-04: SSE Close-Event Tracking Fix

**Issue discovered:** In early implementations, the SSE writer listened to both `req.on('close')` and `res.on('close')` to detect client disconnect. However, Node.js Readable streams (which `req` is) emit `close` ~1ms after the request body is consumed by upstream middleware (e.g., `express.json()`). This happens *before* any SSE event is written, causing the writer's `closed` flag to be set prematurely. Result: every `writer.write(...)` call became a no-op, and clients received only the 2KB padding comment before the stream silently died. Server-side `runChatTurn` still completed and persisted messages, making the symptom appear only on page reload/refetch.

**Fix:** Removed `req.on('close', onClose)` listener from `createSseWriter()`. Kept only `res.on('close', onClose)`. The `res` `close` event already covers both client disconnects and normal end-of-response, and fires at the correct time in the response lifecycle. Updated JSDoc to document the reasoning. See `apps/node-backend/src/lib/sse.js` and [[docs/reference/code-patterns|Code Patterns: SSE Writer]].

**Testing:** Existing test mocks never simulated `req.on('close')` firing, so the regression was not caught by unit tests. Integration tests pass without new coverage needed (the mock behavior already matched the corrected implementation).

## Related

- [[docs/features/ai-chat|AI Chat Feature]] — feature spec
- [[docs/security/ai-data-access|AI Data Access Policy]] — tool allowlist, rate limits, no-external-calls guarantee
- [[docs/integrations/ollama|Ollama Integration]] — client patterns, health check, model discovery
- [[docs/api/ai|AI API]] — endpoint contracts
- [[docs/adr/006-three-layer-architecture|ADR-006: Three-Layer Architecture]] — pattern this feature follows
- [[docs/adr/007-streaming-imports|ADR-007: Streaming Imports]] — SSE pattern reused
- [[docs/adr/index|All ADRs]]
