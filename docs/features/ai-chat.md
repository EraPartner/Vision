---
title: Feature - AI Chat
type: feature
status: active
date: 2026-04-20
tags: [feature, ai, chat, ollama, llm, natural-language, frontend, backend, phase-10]
description: Local AI chat page for natural-language queries over financial data, powered by Ollama with tool-calling (30 tools across 6 domains)
aliases: [ai-chat, ai chat, ollama-chat, natural-language-queries, financial chat, llm chat]
related_code: ["apps/node-backend/src/routes/ai.js", "apps/node-backend/src/services/aiChatService.js", "apps/node-backend/src/integrations/ollama/client.js", "apps/frontend/src/pages/AIChatPage.tsx", "apps/frontend/src/features/ai-chat/", "apps/frontend/src/hooks/useAIChat.ts"]
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
| `ChatMessageList` | Frontend Component | Renders ordered messages; handles autoscroll |
| `ChatBubble` | Frontend Component | User vs assistant styling |
| `ChatComposer` | Frontend Component | Textarea, send, model selector |
| `ToolResultCard` | Frontend Component | Renders tool payload as table or Recharts (line/bar/pie) |
| `OllamaStatusBanner` | Frontend Component | Unreachable warning + setup guide link |
| `useAIChat` | Frontend Hook | Conversations CRUD + SSE send |
| `useOllamaStatus` | Frontend Hook | Health + model list |
| `/api/ai/chat` | API Endpoint | SSE stream for chat exchanges |
| `/api/ai/conversations` | API Endpoint | Conversation CRUD |
| `/api/ai/status` | API Endpoint | Ollama reachability |
| `/api/ai/models` | API Endpoint | Available models from Ollama |
| `aiChatService` | Backend Service | Prompt build, tool loop, persistence |
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
| New conversation | Click "New chat" | Creates `ai_conversations` row, navigates to it |
| Send message | Enter in composer (Shift+Enter = newline) | Streams assistant response via SSE |
| Abort generation | Click "Stop" during streaming | Client aborts, server marks message aborted |
| Rename conversation | Double-click title or pencil icon | PATCH `/api/ai/conversations/:id` |
| Delete conversation | Trash icon + confirm | DELETE cascades messages |
| Switch model | Select in composer dropdown | Persists on conversation; next send uses new model |

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

- **Ollama unreachable** — `GET /api/ai/status` returns `{ok: false}`; frontend shows `OllamaStatusBanner` with setup-guide link; composer disabled.
- **Model not pulled** — Ollama returns 404 on chat request; surface "Model not installed. Run `ollama pull <model>` or pick another." in the banner.
- **Context window overflow** — service trims history to last N turns + tool-result summaries; adds a `system` note when truncation happens.
- **LLM picks an unknown tool name** — dispatcher returns a structured error back to the LLM as a `tool` message; LLM retries or apologizes.
- **LLM emits invalid args** — Zod rejection returned as `tool` error; LLM retries with corrected args (up to 2 retries before giving up).
- **User aborts mid-stream** — `req.on('close')` handler marks in-flight assistant message aborted; client discards partial render.
- **Rate limit tripped** — 429 with `Retry-After`; composer shows cooldown hint.
- **Long tool result** — capped to 500 rows; LLM informed in `tool_result.meta.truncated = true` so it can mention the cap.
- **Schema drift** — tool integration tests in CI catch repository signature changes before merge.

## Privacy & Security

- **No external API calls** — enforced by service-layer conventions and CI test spying on outbound HTTP.
- **Parameterized queries only** — tools go through existing repositories; no dynamic SQL built from LLM output.
- **Audit log** — every `tool_call` + `tool_result` persisted in `ai_messages`.
- **Input validation** — Zod on both chat message body and tool args.
- **Rate limiting** — 30 req/min on `/api/ai/chat`.

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
