---
title: Feature - AI Chat
type: feature
status: active
date: 2026-05-03
updated: 2026-08-26
last_modified: 2026-08-26
tags: [feature, ai, chat, ollama, llm, natural-language, frontend, backend, phase-1, phase-10]
description: Local AI chat with background streaming via module-level store; conversations persist in URL (`?c=<id>`), sidebar shows live indicator for active streams, streams survive navigation and component unmount
aliases: [ai-chat, ai chat, ollama-chat, natural-language-queries, financial chat, llm chat]
related_code: ["apps/node-backend/src/routes/ai.js", "apps/node-backend/src/services/aiChatService.js", "apps/node-backend/src/repositories/aiChatRepository.js", "apps/node-backend/src/integrations/ollama/client.js", "apps/frontend/src/pages/AIChatPage.tsx", "apps/frontend/src/features/ai-chat/", "apps/frontend/src/hooks/useAIChat.ts", "apps/frontend/src/lib/aiChatStreamStore.ts", "apps/node-backend/tests/aiChatService.test.js", "apps/node-backend/tests/aiChatTools.test.js"]
---

# Feature: AI Chat

> [!abstract] Overview
> Natural-language chat over the user's financial data. All processing is local via Ollama — no data leaves the machine. Responses include text, tables, and charts grounded in tool-call results against existing repositories.

## Feature Overview

### User Story

> As a Vision user, I want to ask questions about my finances in plain English (e.g., "what was my biggest expense category in 2025?") so that I can explore my data without building custom reports — with full privacy because the AI runs locally.

### Key Capabilities

- Ask natural-language questions across transactions, portfolio, planned transactions, and Belgian tax data.
- Responses render as text with inline tables and charts (reuses Recharts).
- Conversations are persisted — list, rename, resume, delete.
- Pick an Ollama model per conversation (dropdown of vetted models).
- **Tools toggle** — wrench-icon button in the composer; when off (`useTools: false`), the backend disables all tool-calling and returns text-only answers.
- **Thinking indicator** — animated "Thinking..." dots appear in a bot bubble while streaming but no content received yet; replaced by first token or tool result on arrival.
- **Background streaming** — in-flight chat requests survive navigation; user can leave the AI chat page, browse elsewhere, and the stream keeps running. Sidebar shows live activity indicator on conversations with active streams.
- **URL-backed conversation selection** — conversation ID persists in URL search param `?c=<id>`, enabling deep-linking and restoring selection on page reload.
- Accessible globally via a sidebar entry above the Budget/Portfolio workspace switcher.
- SSE token streaming for progressive response display.
- Graceful offline handling when Ollama is unreachable.

## Architecture

```
Frontend /ai-chat
  ├── aiChatStreamStore         (module-level singleton; survives unmount)
  │    ├── streams map          (conversation_id → StreamState)
  │    ├── aborts map           (conversation_id → abort fn)
  │    ├── subscribe()          (for useSyncExternalStore)
  │    └── send()               (orchestrates SSE, handles events, invalidates cache)
  ├── ChatConversationList      (left sidebar — list/rename/delete/new; shows streaming indicator)
  ├── ChatMessageList           (center — ordered messages)
  │    └── ChatBubble
  │    └── ToolResultCard       (table or Recharts block)
  ├── ChatComposer              (textarea + send + model select)
  └── OllamaStatusBanner        (shown when unreachable)

Backend /api/ai
  ├── routes/ai.js             (SSE endpoint + CRUD)
  ├── services/aiChatService.js (orchestrator)
  ├── integrations/ollama/client.js (HTTP wrapper, stream)
  └── services/aiChat/tools/*  (registry → existing repositories)
```

### Client-Side Stream State Model

**aiChatStreamStore** — module-level singleton holding in-flight chat streams, keyed by conversation ID. Streams are **not tied to React component lifecycle**; navigating away does not abort the stream.

- **subscribe(listener)** — for `useSyncExternalStore` subscriptions; triggers re-render on state changes.
- **getState(conversationId)** — snapshot of a stream's state: `{isStreaming, assistantDraft, toolMessages, userMessage, error}`.
- **getActiveConversationIds()** — readonly list of conversation IDs with active streams; used by sidebar to show live indicators.
- **send(body, queryClient, onError)** — orchestrates SSE request: starts stream, accumulates events, on completion invalidates TanStack Query cache so persisted messages hydrate.
- **cancel(conversationId)** — aborts in-flight fetch and clears streaming flag.
- **clear(conversationId)** — removes stream from store (called after completion when cache is hydrated).

**useSendChatMessage(conversationId)** — thin subscriber on top of `aiChatStreamStore` via `useSyncExternalStore`; returns `{send, cancel, ...state}`.

**useStreamingConversationIds()** — subscribes to active stream set; used by `ChatConversationList` to render pulsing indicator on conversations with active responses.

### Components Involved

| Component | Type | Description |
|-----------|------|-------------|
| `AIChatPage` | Frontend Page | Page shell with a display-scale conversation heading; hosts conversation list, message stream, composer; manages URL state (`?c=<id>`) and auto-selects active stream on mount |
| `ChatConversationList` | Frontend Component | List conversations; on-hover action menu; shows pulsing indicator for active streams via `useStreamingConversationIds()` |
| `ChatMessageList` | Frontend Component | Renders ordered messages; shows thinking indicator when streaming w/no content yet; handles autoscroll — the view follows the stream only while it is pinned to the bottom, so scrolling up mid-answer is not overridden; re-pins on conversation switch and on send |
| `ChatBubble` | Frontend Component | User vs assistant styling |
| `ChatComposer` | Frontend Component | Textarea, send, model selector, tools toggle (wrench icon) |
| `ToolResultCard` | Frontend Component | Renders tool payload as table or Recharts (line/bar/pie) with semantic, tabular numeric axis labels |
| `OllamaStatusBanner` | Frontend Component | Unreachable warning + setup guide link |
| `aiChatStreamStore` | Frontend Store | Module-level singleton holding in-flight streams keyed by conversation ID; survives component unmount |
| `useAIChat` | Frontend Hooks | `useConversations`, `useConversation`, `useCreateConversation`, `useRenameConversation`, `useDeleteConversation`, `useSendChatMessage`, `useStreamingConversationIds` |
| `useSendChatMessage` | Frontend Hook | Subscribes to stream state via `useSyncExternalStore`; returns `{send, cancel, isStreaming, assistantDraft, userMessage, toolMessages, error}` |
| `useStreamingConversationIds` | Frontend Hook | Returns readonly list of conversation IDs with active streams; used by sidebar indicator |
| `useOllamaStatus` | Frontend Hook | Health + model list |
| `/api/ai/chat` | API Endpoint | SSE stream for chat exchanges; accepts optional `useTools` in body |
| `/api/ai/conversations` | API Endpoint | Conversation CRUD; POST creates empty conversation before streaming (avoids PENDING bookkeeping) |
| `/api/ai/status` | API Endpoint | Ollama reachability |
| `/api/ai/models` | API Endpoint | Available models from Ollama |
| `aiChatService.runChatTurn` | Backend Service | Prompt build, tool loop (respects `useTools`), persistence |
| `ollamaClient` | Backend Integration | HTTP client, streaming, abort-aware |
| `aiChat/tools/*` | Backend Tool Registry | Pre-built safe queries over existing repositories |
| `aiChatRepository` | Backend Repository | `ai_conversations` + `ai_messages` CRUD |

## Data Model

### Database Tables

- `ai_conversations` — `id UUID`, `title TEXT`, `model TEXT`, `created_at`, `updated_at`
- `ai_messages` — `id UUID`, `conversation_id UUID FK`, `role TEXT` (`user`/`assistant`/`tool`/`system`), `content TEXT`, `tool_name TEXT?`, `tool_args JSONB?`, `tool_result JSONB?`, `created_at`

Index: `ai_messages(conversation_id, created_at)` for ordered retrieval.

### API Endpoints

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/ai/status` | GET | Ollama health + configured URL |
| `/api/ai/models` | GET | List available models from the configured Ollama instance |
| `/api/ai/conversations` | GET, POST | List conversations; create a new one |
| `/api/ai/conversations/:id` | GET, PATCH, DELETE | Read (incl. messages), rename, delete |
| `/api/ai/chat` | POST (SSE) | Stream events: `token`, `tool_call`, `tool_result`, `done`, `error` |

## Tool Registry (30 tools across 6 domains)

Tools are declared with JSON Schema params. Backend validates args before dispatch with the hand-rolled helpers in `services/aiChat/tools/_validate.js` (`parseDate`, `parseEnum`, `parsePositiveInt`) — not Zod, despite what this page said before 2026-08-11. `parsePositiveInt` delegates to the shared `validateId` (see [[docs/security/input-validation#parsePositiveInt (AI-chat tool arguments)|Input Validation]]), so a malformed `categoryId`/`recipientId`/`plannedId` is an error the model can correct rather than a silent hit on the wrong record. Results capped at 500 rows by default. Each tool returns `{ok, data, meta, renderAs}` where `renderAs ∈ {"table", "line", "bar", "pie"}` drives the `ToolResultCard` rendering.

### Expenses (11 tools)

- `getSpendByCategory(from, to, topN?)` — top categories by total spend in date range
- `getTopRecipients(from, to, topN?)` — most-spent recipients
- `getMonthlySpend(from, to, groupBy?: "month" | "quarter")` — monthly or quarterly spend totals
- `getNetCashflow(from, to, groupBy?: "month" | "quarter")` — income vs expenses grouped by month or quarter; returns per-period income, expenses, net; meta includes totalIncome, totalExpenses, totalNet
- `getTransactionsInRange(from, to, categoryId?, recipientId?, limit?)` — raw transactions, optionally filtered
- `getMonthlyCategoryBreakdown(from, to, topN?)` — top N categories per month (time series)
- `searchTransactions(query, from?, to?, limit?)` — full-text search over transaction memos/recipients
- `getLargestTransactions(from, to, topN?, direction?)` — biggest expenses/income/both in range
- `getSpendTrendForCategory(categoryId, months?)` — monthly trend for a single category
- `getYearOverYearComparison(year, prevYear?)` — category-level spending YoY with pct change
- `getUncategorisedTransactions(limit?)` — transactions missing a category assignment

### Portfolio (6 tools)

- `getPortfolioHoldings(at?)` — current holdings with quantity, cost basis, market value
- `getReturnsForRange(from, to, assetClass?)` — realized returns by asset class
- `getDividendIncome(from, to)` — dividend/distribution income per holding
- `getAssetAllocation(at?)` — portfolio allocation by asset class
- `getUnrealizedGains(assetClass?)` — unrealized P&L per holding (costBasis vs marketValue)
- `getBestWorstPerformers(from, to, topN?, assetClass?)` — top/bottom performers by return %

### Planned / Recurring (4 tools)

- `getUpcomingPlanned(horizonDays?)` — upcoming recurring/planned transactions
- `getSubscriptionTotal(period: "monthly" | "yearly")` — total subscription spend
- `getLoanSchedule(plannedId)` — loan repayment schedule details
- `getProjectedBalance(horizonDays?)` — bank balance + upcoming planned = projected balance

### Belgian Tax (3 tools)

- `getTaxableIncomeSummary(year)` — taxable income, exemptions, Belgian-specific calculations
- `getCapitalGainsForYear(year)` — realized capital gains by asset class
- `getDeductibles(year)` — deductible expenses and records

### Insights (6 tools)

- `getBankBalances()` — current balance per account + total net position
- `getSpendingPace(period?: "monthly" | "yearly")` — current-month vs 6-month average, projected total; when yearly, multiplies 6-month average and projected total by 12
- `getRecipientInsights(limit?, recipientId?)` — when recipientId is omitted, recipients ranked by frequency; when provided, filters to just that one recipient's stats (freq, totalSpend, totalIncome, avgSpend, lastDate)
- `getRecurringDetected(minOccurrences?)` — auto-detected recurring patterns from transaction history (different from user-created planned transactions); minOccurrences default 3 (min 2, max 20); returns recipient, pattern, consistency%, occurrences, averageAmount, predictedNext, confidence, isAlreadyPlanned
- `getWatchlist(assetClass?)` — watchlist investments filtered by asset class
- `getCategories(search?)` — all categories with IDs for LLM to resolve name→ID

## User Interface

### Screens

1. **AI Chat Main View** — split layout: conversation list (left), active conversation message stream + composer (center/right).
2. **Empty State** — shown when no conversation is selected; prompts user to start a new chat with suggested queries.
3. **Settings — AI Chat Section** — Ollama URL input + default model dropdown + health probe.

### Interactions

| Action | Trigger | Result |
|--------|---------|--------|
| New conversation | Click "New chat" | POST `/api/ai/conversations` creates empty conversation; sets URL param `?c=<id>` and selects it |
| Auto-title | Send first message to new conversation | Backend renames conversation from `"New conversation"` to first message (≤60 chars, truncated) |
| Send message | Enter in composer (Shift+Enter = newline) | POST `/api/ai/conversations` if no selection; then POST `/api/ai/chat/stream` (SSE). Stream runs in background store and survives page navigation. Sidebar shows pulsing indicator on active conversation. On completion, TanStack Query cache invalidated so persisted messages hydrate. |
| Abort generation | Click "Stop" during streaming | Calls `cancel()` on store; aborts fetch via stored abort controller; server stream ended but incomplete message persisted as aborted |
| Rename conversation | Double-click title or pencil icon | PATCH `/api/ai/conversations/:id` |
| Delete conversation | Trash icon + confirm | DELETE cascades messages; if selected, clears URL param and `selectedId` **before** mutation to prevent race-condition refetch 404s |
| Switch model | Select in composer dropdown | Persists on conversation; next send uses new model |
| Toggle tools | Click wrench icon in composer | Toggles `useTools` state; when OFF, next sends pass `useTools: false` to backend, disabling tool-calling |
| Switch conversation | Click in list | Updates URL param `?c=<id>` (or removes if deselecting); re-subscribes to new conversation's stream state; prior stream continues running in background |
| Navigate away & return | Browser back/forward or sidebar nav | URL param `?c=<id>` restored; if stream was in-flight, sidebar indicator still visible; auto-selects stream (effect watches `streamingIds`) so user can see it complete |
| Deep-link to conversation | Open `?c=<id>` in new tab/bookmark | Page loads, hydrates URL state, fetches conversation detail, shows messages + any in-flight streaming |

## Configuration

### Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `aiChat.defaultModel` | string | `llama3.1:8b` | Model pre-selected on new conversations |
| `aiChat.ollamaUrl` | string | `http://localhost:11434` | Ollama host (read from `OLLAMA_URL` env; editable in UI) |

### Environment Variables

- `OLLAMA_URL` — base URL for the Ollama HTTP API
- `OLLAMA_DEFAULT_MODEL` — fallback model if user hasn't set one
- `AI_CHAT_RATE_LIMIT` — per-minute cap on `/api/ai/chat` (default 30)

## Edge Cases

- **New conversation auto-title** — when a conversation is created with title `"New conversation"` and the first message is sent, the backend renames it from the user's message (up to 60 characters, with ellipsis truncation). If the first message is empty or only whitespace, the title remains `"New conversation"`.
- **Pre-create before streaming** — when user sends a message without a selected conversation, `AIChatPage` first calls `createMut.mutateAsync()` to POST `/api/ai/conversations`, then sets URL `?c=<id>` and calls `send()`. This ensures the stream key is always a real conversation ID — no PENDING bookkeeping needed.
- **Module-level stream store** — `aiChatStreamStore` holds in-flight streams outside the React tree. When a user navigates away from the chat page or switches conversations, the stream **continues running in the background**. On return, `useSendChatMessage` re-subscribes and rehydrates the preview. This is safe because:
  - The stream does not hold a component ref, so unmount does not abort.
  - The server-side `res.on('close')` handler only fires if the browser tab fully closes (not on SPA navigation).
  - On completion, TanStack Query invalidates cache, so persisted messages hydrate fresh.
- **Streaming indicator in sidebar** — `ChatConversationList` calls `useStreamingConversationIds()` to get the set of active streams. Pulsing indicator renders on matching conversation rows via `motion-safe:animate-pulse` CSS class.
- **URL-backed selection** — `AIChatPage` reads `?c=<id>` from URL on mount; if absent and a stream is in-flight, an effect auto-selects that stream (`streamingIds[0]`). This enables deep-linking and restores selection on page reload.
- **Conversation switch does not abort prior stream** — when user clicks a new conversation in the list, the sidebar updates `selectedId` via `setSelectedId` (which updates URL), but the prior conversation's stream **keeps running in the background**. The new conversation's message list renders clean because `useSendChatMessage(selectedId)` is keyed to the new `selectedId`.
- **Ollama unreachable** — `GET /api/ai/status` returns `{ok: false}`; frontend shows one `OllamaStatusBanner` with a localized setup hint and guide link, without repeating the failure in the page header or exposing the raw connection error as primary UI copy; composer disabled. Loading and ready states still appear in the header.
- **Model not pulled** — Ollama returns 404 on chat request; surface "Model not installed. Run `ollama pull <model>` or pick another." in the banner.
- **Context window overflow** — service trims history to last N turns + tool-result summaries; adds a `system` note when truncation happens.
- **LLM picks an unknown tool name** — dispatcher returns a structured error back to the LLM as a `tool` message; LLM retries or apologizes.
- **LLM emits invalid args** — `ToolValidationError` returned as a `tool` error `{code: 'VALIDATION_ERROR', field, message}` naming the field and the received value; LLM retries with corrected args (up to 2 retries before giving up).
- **Tool failure without detail** — `ToolResultCard` uses the localized `aiChat.toolFailed` fallback instead of hardcoded English.
- **User aborts mid-stream** — clicking "Stop" calls `cancel()` on the store, which aborts the fetch via stored controller; server-side `res.on('close')` handler detects the abort and marks the assistant message as aborted in the DB; client discards partial preview and clears streaming flag.
- **Rate limit tripped** — 429 with `Retry-After`; composer shows cooldown hint.
- **Long tool result** — capped to 500 rows; LLM informed in `tool_result.meta.truncated = true` so it can mention the cap.
- **Schema drift** — tool integration tests in CI catch repository signature changes before merge.
- **Delete race condition** — when deleting a selected conversation, frontend clears `selectedId` (removes URL param) **before** awaiting the mutation to prevent the UI from refetching the deleted conversation. Backend uses `removeQueries` before `invalidateQueries` to ensure no overlapping detail-fetch requests trigger 404 spam in logs.
- **Tools disabled** — when `useTools: false` is sent, the backend skips tool schema building and passes `tools: undefined` to Ollama; the model returns text only, bypassing the entire tool loop.
- **Response field casing** — all repository responses use camelCase (e.g., `createdAt`, `conversationId`, `toolName`, `toolArgs`, `toolResult`); this matches the frontend's `ChatMessage` and `Conversation` types. Previously, snake_case DB rows caused `message.toolResult` to be undefined.

## Debugging

**Backend logs** (debug level):
- `[aiChat] iteration start` — logged per tool-loop iteration; includes conversation ID, iteration count, model, message count, `useTools` flag, and tool schema count.
- `[aiChat] iteration ollama returned` — after Ollama succeeds; includes ms elapsed, tool call count, and content length.
- `[aiChat] iteration ollama failed` — on Ollama error; includes ms elapsed, error code, and message.

**Frontend logs** (browser console, debug level):
- `[ai] streamChat start` — sent when beginning SSE fetch.
- `[ai] streamChat response` — logged on stream open with event target details.
- `[ai] streamChat event` — per SSE event (user_message, token, tool_call, tool_result, done, error).

Enable via browser DevTools (Console tab) or server-side log aggregation.

## Privacy & Security

- **No external API calls** — enforced by service-layer conventions and **CI test** (spies on `global.fetch` when Ollama client is injected) in `aiChatService.test.js`.
- **Read-only tool registry** — enforced by **CI denylist check** verifying no tool calls write methods (`create()`, `update()`, `delete()`, etc.) or imports the Postgres pool directly.
- **Parameterized queries only** — tools go through existing repositories; no dynamic SQL built from LLM output.
- **Audit log** — every `tool_call` + `tool_result` persisted in `ai_messages`.
- **Input validation** — Zod on the chat message body; `tools/_validate.js` on tool args, with ids on the shared `validateId` accept set.
- **Rate limiting** — 30 req/min on `/api/ai/chat`.
- **Message length limit** — 4000 characters enforced both in frontend (`ChatComposer.tsx`) and backend (routes/ai.js).
- **Tools opt-out** — frontend `useTools` toggle allows users to disable tool-calling per-message; when `false`, backend skips tool schemas and returns text-only responses.

See [[docs/security/ai-data-access|AI Data Access Policy]] for the full security posture.

## Related

- [[docs/adr/024-local-llm-chat|ADR-024: Local LLM Chat Integration]] — original Ollama integration and SSE streaming design
- [[docs/adr/048-ai-chat-module-level-stream-store|ADR-048: AI Chat Module-Level Stream Store]] — decoupling stream lifetime from component lifecycle
- [[docs/integrations/ollama|Ollama Integration]] — HTTP client and patterns
- [[docs/security/ai-data-access|AI Data Access Policy]] — tool allowlist, rate limits
- [[docs/api/ai|AI API]] — endpoint contracts
- [[docs/features/transactions|Transactions]] — data surfaced by expense tools
- [[docs/features/portfolio|Portfolio & Investments]] — data surfaced by portfolio tools
- [[docs/features/plannedTransactions|Planned Transactions]] — data surfaced by planned tools
- [[docs/features/belgian-tax|Belgian Tax]] — data surfaced by tax tools
