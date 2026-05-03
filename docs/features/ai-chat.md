---
title: Feature - AI Chat
type: feature
status: active
date: 2026-05-03
updated: 2026-05-03
tags: [feature, ai, chat, ollama, llm, natural-language, frontend, backend, phase-1, phase-10]
description: Local AI chat page for natural-language queries over financial data, powered by Ollama with tool-calling (30 tools across 6 domains); now with tools opt-out toggle, thinking indicator, debug logging, auto-title from first message, and streaming state reset on conversation switch
aliases: [ai-chat, ai chat, ollama-chat, natural-language-queries, financial chat, llm chat]
related_code: ["apps/node-backend/src/routes/ai.js", "apps/node-backend/src/services/aiChatService.js", "apps/node-backend/src/repositories/aiChatRepository.js", "apps/node-backend/src/integrations/ollama/client.js", "apps/frontend/src/pages/AIChatPage.tsx", "apps/frontend/src/features/ai-chat/", "apps/frontend/src/hooks/useAIChat.ts", "apps/node-backend/tests/aiChatService.test.js", "apps/node-backend/tests/aiChatTools.test.js"]
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
- Accessible globally via a sidebar entry above the Budget/Portfolio workspace switcher.
- SSE token streaming for progressive response display.
- Graceful offline handling when Ollama is unreachable.

## Architecture

```
Frontend /ai-chat
  ├── ChatConversationList  (left sidebar — list/rename/delete/new)
  ├── ChatMessageList       (center — ordered messages)
  │    └── ChatBubble
  │    └── ToolResultCard   (table or Recharts block)
  ├── ChatComposer          (textarea + send + model select)
  └── OllamaStatusBanner    (shown when unreachable)

Backend /api/ai
  ├── routes/ai.js          (SSE endpoint + CRUD)
  ├── services/aiChatService.js      (orchestrator)
  ├── integrations/ollama/client.js  (HTTP wrapper, stream)
  └── services/aiChat/tools/*        (registry → existing repositories)
```

### Components Involved

| Component | Type | Description |
|-----------|------|-------------|
| `AIChatPage` | Frontend Page | Page shell; hosts conversation list, message stream, composer |
| `ChatMessageList` | Frontend Component | Renders ordered messages; shows thinking indicator when streaming w/no content yet; handles autoscroll |
| `ChatBubble` | Frontend Component | User vs assistant styling |
| `ChatComposer` | Frontend Component | Textarea, send, model selector, tools toggle (wrench icon) |
| `ToolResultCard` | Frontend Component | Renders tool payload as table or Recharts (line/bar/pie) |
| `OllamaStatusBanner` | Frontend Component | Unreachable warning + setup guide link |
| `useAIChat` | Frontend Hook | Conversations CRUD + SSE send (respects `useTools` state) |
| `useOllamaStatus` | Frontend Hook | Health + model list |
| `/api/ai/chat` | API Endpoint | SSE stream for chat exchanges; accepts optional `useTools` in body |
| `/api/ai/conversations` | API Endpoint | Conversation CRUD |
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

Tools are declared with JSON Schema params. Backend validates args via Zod before dispatch. Results capped at 500 rows by default. Each tool returns `{ok, data, meta, renderAs}` where `renderAs ∈ {"table", "line", "bar", "pie"}` drives the `ToolResultCard` rendering.

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
| New conversation | Click "New chat" | Creates `ai_conversations` row with title `"New conversation"`, navigates to it |
| Auto-title | Send first message to new conversation | Backend renames conversation from `"New conversation"` to first message (≤60 chars, truncated) |
| Send message | Enter in composer (Shift+Enter = newline) | Streams assistant response via SSE with `useTools` value from toggle state; clears streaming state on conversation switch |
| Abort generation | Click "Stop" during streaming | Client aborts in-flight fetch, server stops writing SSE frames, no `done` event sent |
| Rename conversation | Double-click title or pencil icon | PATCH `/api/ai/conversations/:id` |
| Delete conversation | Trash icon + confirm | DELETE cascades messages; if selected, clears `selectedId` **before** mutation to prevent race-condition refetch 404s |
| Switch model | Select in composer dropdown | Persists on conversation; next send uses new model |
| Toggle tools | Click wrench icon in composer | Toggles `useTools` state; when OFF, next sends pass `useTools: false` to backend, disabling tool-calling |
| Switch conversation | Click in list | Triggers streaming state reset: aborts any in-flight fetch, clears user/assistant draft/tool messages, allowing clean render of the next conversation |

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
- **Streaming state on conversation switch** — when a user switches conversations in the list while a prior conversation is streaming, `AIChatPage` calls `reset()` from `useSendChatMessage`, which aborts the in-flight fetch, clears `abortRef` and `isStreamingRef`, and resets state to `INITIAL_STREAM`. This prevents the prior conversation's user bubble, tool messages, or assistant draft from appearing in the new conversation's empty state.
- **Ollama unreachable** — `GET /api/ai/status` returns `{ok: false}`; frontend shows `OllamaStatusBanner` with setup-guide link; composer disabled.
- **Model not pulled** — Ollama returns 404 on chat request; surface "Model not installed. Run `ollama pull <model>` or pick another." in the banner.
- **Context window overflow** — service trims history to last N turns + tool-result summaries; adds a `system` note when truncation happens.
- **LLM picks an unknown tool name** — dispatcher returns a structured error back to the LLM as a `tool` message; LLM retries or apologizes.
- **LLM emits invalid args** — Zod rejection returned as `tool` error; LLM retries with corrected args (up to 2 retries before giving up).
- **User aborts mid-stream** — clicking "Stop" calls `cancel()`, which aborts the in-flight fetch via `abortRef`; `req.on('close')` handler marks the assistant message aborted in the DB; client discards partial render.
- **Rate limit tripped** — 429 with `Retry-After`; composer shows cooldown hint.
- **Long tool result** — capped to 500 rows; LLM informed in `tool_result.meta.truncated = true` so it can mention the cap.
- **Schema drift** — tool integration tests in CI catch repository signature changes before merge.
- **Delete race condition** — when deleting a selected conversation, frontend clears `selectedId` **before** awaiting the mutation to prevent the UI from refetching the deleted conversation. Backend uses `removeQueries` before `invalidateQueries` to ensure no overlapping detail-fetch requests trigger 404 spam in logs.
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
- **Input validation** — Zod on both chat message body and tool args.
- **Rate limiting** — 30 req/min on `/api/ai/chat`.
- **Message length limit** — 4000 characters enforced both in frontend (`ChatComposer.tsx`) and backend (routes/ai.js).
- **Tools opt-out** — frontend `useTools` toggle allows users to disable tool-calling per-message; when `false`, backend skips tool schemas and returns text-only responses.

See [[docs/security/ai-data-access|AI Data Access Policy]] for the full security posture.

## Related

- [[docs/adr/024-local-llm-chat|ADR-024: Local LLM Chat Integration]] — design decision record
- [[docs/integrations/ollama|Ollama Integration]] — HTTP client and patterns
- [[docs/security/ai-data-access|AI Data Access Policy]] — tool allowlist, rate limits
- [[docs/api/ai|AI API]] — endpoint contracts
- [[docs/features/transactions|Transactions]] — data surfaced by expense tools
- [[docs/features/portfolio|Portfolio & Investments]] — data surfaced by portfolio tools
- [[docs/features/plannedTransactions|Planned Transactions]] — data surfaced by planned tools
- [[docs/features/belgian-tax|Belgian Tax]] — data surfaced by tax tools
