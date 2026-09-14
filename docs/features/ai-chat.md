---
title: Feature - AI Chat
type: feature
status: active
date: 2026-09-14
updated: 2026-09-14
last_modified: 2026-09-14
tags:
  [
    feature,
    ai,
    chat,
    ollama,
    llm,
    natural-language,
    frontend,
    backend,
    phase-1,
    phase-10,
  ]
description: Local AI chat with background streaming via module-level store; conversations persist in URL (`?c=<id>`), sidebar shows live indicator for active streams, streams survive navigation and component unmount
aliases:
  [
    ai-chat,
    ai chat,
    ollama-chat,
    natural-language-queries,
    financial chat,
    llm chat,
  ]
related_code:
  [
    "apps/node-backend/src/routes/ai.js",
    "apps/node-backend/src/services/aiChatService.js",
    "apps/node-backend/src/repositories/aiChatRepository.js",
    "apps/node-backend/src/integrations/ollama/client.js",
    "packages/types/src/aiChat.js",
    "packages/types/src/aiChat.d.ts",
    "apps/frontend/src/pages/AIChatPage.tsx",
    "apps/frontend/src/features/ai-chat/",
    "apps/frontend/src/hooks/useAIChat.ts",
    "apps/frontend/src/lib/aiChatStreamStore.ts",
    "apps/node-backend/tests/aiChatService.test.js",
    "apps/node-backend/tests/aiChatTools.test.js",
  ]
---

# Feature: AI Chat

> [!abstract] Overview
> Natural-language chat remains local via Ollama. The separate investigation panel adds recoverable,
> evidence-backed local work and an optional consent-bound OpenAI API route. Nothing uses cloud
> inference unless that route is enabled and the exact payload has been previewed and granted.

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
- Interrupted, stopped, and stalled streams retain their partial answer, label
  its state, and offer a one-click retry of the same request.
- Graceful offline handling when Ollama is unreachable.
- Quick or detailed EN/NL investigations across Budgeting, Portfolio, and Research.
- Structured facts, deterministic calculations, interpretations, gaps, conflicts, and evidence.
- Local documents plus separately enabled public-provider or public-web research.
- Exact cloud-payload preview, revocable grants, and deletable local disclosure metadata.
- Optional scoped reversible references replace explicitly marked selected-text literals with
  one-job random tokens and restore allowlisted answer text locally.
- Four visible model privacy profiles: fully local, public-question cloud planning, selected-summary
  cloud planning, and final cloud synthesis from exact selected evidence.
- Each profile states its capability, exact cloud data, privacy boundary, and local retention. A
  visible delete action removes the recoverable investigation and its selected evidence.
- Quick and detailed depth profiles state their compute/output difference and explicitly do not
  widen the selected model or research disclosure boundary.
- The OpenAI route offers a server-approved API model picker. Each model has its own configured
  prices, and the selected identifier is visible in the payload preview and consent digest.
- Durable partial jobs that resume without repeating completed tool steps.

## Investigation resource profile

Only one investigation executes at a time. It receives bounded tool results and passages, not the
complete database. Local work reuses the backend and Ollama. Optional cloud work creates one
short-lived macOS Seatbelt-sandboxed process and removes its empty temporary directory afterward.
Public web queries and provider symbols are entered separately. The two cloud-planning profiles keep
evidence and final synthesis local. The distinct selected-evidence profile skips local planning,
retrieval, and model inference, then asks OpenAI for the final structured answer using only the exact
manually selected evidence shown in the consent preview. Containers are not required for the accepted
realistic threat model; see [[docs/adr/145-bounded-ai-research-orchestration|ADR-145]] and
[[docs/adr/146-explicit-selected-evidence-cloud-synthesis|ADR-146]].
Investigation inputs, checkpoints, and results remain in the recoverable local job until it is
deleted. Disclosure history is separate and retains only the payload digest and policy metadata.
Quick local investigations use the deterministic plan and one synthesis call. Detailed local work
adds one bounded planning call. This avoids doubling local model CPU for routine questions.
The picker is API-only. ChatGPT subscriptions and ChatGPT usage credits do not fund Responses API
requests and are not reused as authentication.
The AI settings page stores a preferred OpenAI model for new investigations. An explicit choice in
the investigation panel overrides that preference. If the saved model is no longer in the server
catalog, Vision falls back to the operator default and never sends the stale identifier. See
[[docs/adr/148-user-default-openai-model|ADR-148]].

### Scoped reversible references

Selected-summary planning and selected-evidence synthesis show an optional marker hint. A user can
write `[[vision-ref:type|value]]` in the selected summary or selected evidence. Types are `account`,
`recipient`, `investment`, `holding`, `category`, `document`, `subject`, `amount`, and `date`.
Preview replaces each marker with a typed random token, warns with the number of scoped references,
and returns the tokenized `outboundRequest` used for both the grant and investigation.

The mapping stays in PostgreSQL as AES-256-GCM ciphertext under the installation's
`AI_REFERENCE_MAPPING_KEY`. An unclaimed preview is usable for 15 minutes and can be claimed by one
job only; a claimed map expires after 30 days. The provider-form answer is checkpointed before local
restoration. If Vision restarts at that point, it validates the checkpoint and restores from it
without repeating cloud or local generation. Successful `result_json` contains the restored local
answer. Deleting the investigation also deletes its reference scope and encrypted entries.

Only answer display text is restored. Evidence IDs, labels, locators, kinds, dates, availability,
and schema structure stay provider-authored and token-free. An unknown, malformed, expired,
cross-job, or undecryptable token fails the job visibly. Vision never shows a partly restored answer.
The feature is pseudonymization, not anonymity: unmarked amounts, dates, holdings, and behavioral
patterns still cross the exact selected disclosure boundary. See
[[docs/adr/151-scoped-reversible-ai-references|ADR-151]].

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
  ├── routes/ai.js             (SSE pass-through + CRUD + terminal events)
  ├── services/aiChatService.js (orchestrator; emits public stream events)
  ├── integrations/ollama/client.js (HTTP wrapper, stream)
  └── services/aiChat/tools/*  (registry → existing repositories)

Shared contract
  └── @vision/types/aiChat     (runtime event names + TypeScript payload shapes)
```

### Client-Side Stream State Model

**aiChatStreamStore** — module-level singleton holding in-flight chat streams, keyed by conversation ID. Streams are **not tied to React component lifecycle**; navigating away does not abort the stream.

- **subscribe(listener)** — for `useSyncExternalStore` subscriptions; triggers re-render on state changes.
- **getState(conversationId)** — snapshot of a stream's state: `{isStreaming, status, assistantDraft, toolMessages, userMessage, error, lastRequest}`. `status` distinguishes active, manually stopped, interrupted, and inactivity-timeout drafts.
- **getActiveConversationIds()** — readonly list of conversation IDs with active streams; used by sidebar to show live indicators.
- **send(body, queryClient, onError)** — orchestrates SSE request: starts stream, accumulates events, on completion invalidates TanStack Query cache so persisted messages hydrate.
- **cancel(conversationId)** — aborts the in-flight fetch, marks the retained draft as stopped, and suppresses an error toast for this user-requested action.
- **clear(conversationId)** — removes stream from store (called after completion when cache is hydrated).

**useSendChatMessage(conversationId)** — thin subscriber on top of `aiChatStreamStore` via `useSyncExternalStore`; returns `{send, cancel, ...state}`.

**useStreamingConversationIds()** — subscribes to active stream set; used by `ChatConversationList` to render pulsing indicator on conversations with active responses.

### Components Involved

| Component                     | Type                  | Description                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIChatPage`                  | Frontend Page         | Page shell with a display-scale conversation heading; hosts conversation list, message stream, composer; manages URL state (`?c=<id>`) and auto-selects active stream on mount                                                                                                                                                           |
| `ChatConversationList`        | Frontend Component    | List conversations; on-hover action menu; shows pulsing indicator for active streams via `useStreamingConversationIds()`                                                                                                                                                                                                                 |
| `ChatMessageList`             | Frontend Component    | Renders ordered messages; shows thinking indicator when streaming w/no content yet; retains and labels stopped/interrupted/timed-out drafts with Retry; handles autoscroll — the view follows the stream only while it is pinned to the bottom, so scrolling up mid-answer is not overridden; re-pins on conversation switch and on send |
| `ChatBubble`                  | Frontend Component    | User vs assistant styling                                                                                                                                                                                                                                                                                                                |
| `ChatComposer`                | Frontend Component    | Textarea, send, model selector, tools toggle (wrench icon)                                                                                                                                                                                                                                                                               |
| `ToolResultCard`              | Frontend Component    | Renders table and JSON payloads; maps tool failures to localized validation, unavailable-action, or generic copy while logging the structured diagnostic; lazy-loads `ToolResultChart` only for line/bar/pie results                                                                                                                     |
| `ToolResultChart`             | Frontend Component    | Recharts-backed line/bar/pie renderer behind a nested lazy boundary, so ordinary chat and non-chart tool results do not download Recharts                                                                                                                                                                                                |
| `OllamaStatusBanner`          | Frontend Component    | Unreachable warning + setup guide link                                                                                                                                                                                                                                                                                                   |
| `aiChatStreamStore`           | Frontend Store        | Module-level singleton holding in-flight streams keyed by conversation ID; survives component unmount                                                                                                                                                                                                                                    |
| `useAIChat`                   | Frontend Hooks        | `useConversations`, `useConversation`, `useCreateConversation`, `useRenameConversation`, `useDeleteConversation`, `useSendChatMessage`, `useStreamingConversationIds`                                                                                                                                                                    |
| `useSendChatMessage`          | Frontend Hook         | Subscribes to stream state via `useSyncExternalStore`; returns `{send, cancel, isStreaming, status, assistantDraft, userMessage, toolMessages, error, lastRequest}`                                                                                                                                                                      |
| `useStreamingConversationIds` | Frontend Hook         | Returns readonly list of conversation IDs with active streams; used by sidebar indicator                                                                                                                                                                                                                                                 |
| `useOllamaStatus`             | Frontend Hook         | Health + model list                                                                                                                                                                                                                                                                                                                      |
| `/api/ai/chat`                | API Endpoint          | SSE stream for chat exchanges; accepts optional `useTools` in body                                                                                                                                                                                                                                                                       |
| `/api/ai/conversations`       | API Endpoint          | Conversation CRUD; POST creates empty conversation before streaming (avoids PENDING bookkeeping)                                                                                                                                                                                                                                         |
| `/api/ai/status`              | API Endpoint          | Ollama reachability                                                                                                                                                                                                                                                                                                                      |
| `/api/ai/models`              | API Endpoint          | Available models from Ollama                                                                                                                                                                                                                                                                                                             |
| `aiChatService.runChatTurn`   | Backend Service       | Prompt build, tool loop (respects `useTools`), persistence                                                                                                                                                                                                                                                                               |
| `ollamaClient`                | Backend Integration   | HTTP client, streaming, abort-aware                                                                                                                                                                                                                                                                                                      |
| `aiChat/tools/*`              | Backend Tool Registry | Pre-built safe queries over existing repositories                                                                                                                                                                                                                                                                                        |
| `aiChatRepository`            | Backend Repository    | `ai_conversations` + `ai_messages` CRUD                                                                                                                                                                                                                                                                                                  |

## Data Model

### Database Tables

- `ai_conversations` — `id UUID`, `title TEXT`, `model TEXT`, `created_at`, `updated_at`
- `ai_messages` — `id UUID`, `conversation_id UUID FK`, `role TEXT` (`user`/`assistant`/`tool`/`system`), `content TEXT`, `tool_name TEXT?`, `tool_args JSONB?`, `tool_result JSONB?`, `created_at`

Index: `ai_messages(conversation_id, created_at)` for ordered retrieval.

Conversation history has no automatic time-based retention. Deleting a
conversation is the explicit user-controlled retention action and cascades its
messages; the application does not silently remove model, tool, or audit
context. Revisit an opt-in retention setting if the AI tables exceed 10% of a
workspace database or add more than 30 seconds to a measured backup, with
preview and export before deletion.

### API Endpoints

| Endpoint                    | Methods            | Description                                                             |
| --------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `/api/ai/status`            | GET                | Ollama health + configured URL                                          |
| `/api/ai/models`            | GET                | List available models from the configured Ollama instance               |
| `/api/ai/conversations`     | GET, POST          | List conversations; create a new one                                    |
| `/api/ai/conversations/:id` | GET, PATCH, DELETE | Read (incl. messages), rename, delete                                   |
| `/api/ai/chat`              | POST               | Run one chat turn and return the completed JSON payload                 |
| `/api/ai/chat/stream`       | POST (SSE)         | Stream events: `token`, `tool_call`, `tool_result`, `complete`, `error` |

The frontend, backend service, and route use the shared `@vision/types/aiChat` contract. It also owns the supported tool-result envelope and `renderAs` vocabulary. The service emits public `user_message`, `token`, `tool_call`, and `tool_result` frames directly. The route passes them through and adds the canonical terminal `complete` or `error`. The frontend updates stream state directly from `complete`.

## Tool Registry (30 tools across 6 domains)

Tools are declared with JSON Schema params. Backend validates args before dispatch with the hand-rolled helpers in `services/aiChat/tools/_validate.js` (`parseDate`, `parseEnum`, `parsePositiveInt`) — not Zod, despite what this page said before 2026-08-11. `parsePositiveInt` delegates to the shared `validateId` (see [[docs/security/input-validation#parsePositiveInt (AI-chat tool arguments)|Input Validation]]), so a malformed `categoryId`/`recipientId`/`plannedId` is an error the model can correct rather than a silent hit on the wrong record. Results capped at 500 rows by default. Each tool returns `{ok, data, meta}`; optional `meta.renderAs ∈ {"table", "line", "bar", "pie"}` drives the `ToolResultCard` rendering. Omitting the hint uses the JSON fallback.

### Expenses (11 tools)

- `getSpendByCategory(from, to, topN?)` — top categories by total spend in date range
- `getTopRecipients(from, to, topN?)` — most-spent recipients
- `getMonthlySpend(from, to, groupBy?: "month" | "quarter")` — canonical monthly or quarterly income, spend, and net totals in the configured reporting currency
- `getNetCashflow(from, to, groupBy?: "month" | "quarter")` — the same canonical cash-flow series plus total income, expenses, and net; internal transfers follow the application policy and refunds remain positive inflows
- `getTransactionsInRange(from, to, categoryId?, recipientId?, limit?)` — raw transactions, optionally filtered
- `getMonthlyCategoryBreakdown(from, to, topN?)` — top N categories per month (time series)
- `searchTransactions(query, from?, to?, limit?)` — full-text search over transaction memos/recipients
- `getLargestTransactions(from, to, topN?, direction?)` — biggest expenses/income/both in range
- `getSpendTrendForCategory(categoryId, months?)` — monthly trend for a single category
- `getYearOverYearComparison(year, prevYear?)` — category-level spending YoY with pct change
- `getUncategorisedTransactions(limit?)` — transactions missing a category assignment

### Portfolio (6 tools)

- `getPortfolioHoldings(assetClass?)` — canonical current holdings, including non-unit assets, in the configured reporting currency
- `getReturnsForRange(from, to, assetClass?)` — compatibility-named income-flow tool; returns income minus recorded fees and taxes as `netIncome`, not investment performance
- `getDividendIncome(from, to)` — canonical dividend income per holding in the configured reporting currency
- `getAssetAllocation()` — canonical current-value allocation by asset class
- `getUnrealizedGains(assetClass?)` — canonical unrealized gain against the remaining open-position basis after partial sales
- `getBestWorstPerformers(from, to, topN?, assetClass?)` — compatibility-named ranking by `netIncome`, not price performance

### Planned / Recurring (4 tools)

- `getUpcomingPlanned(horizonDays?)` — upcoming recurring/planned transactions
- `getSubscriptionTotal(period: "monthly" | "yearly")` — total subscription spend
- `getLoanSchedule(plannedId)` — loan repayment schedule details
- `getProjectedBalance(horizonDays?)` — bank balance + upcoming planned = projected balance

### Belgian Tax (3 tools)

- `getTaxableIncomeSummary(year)` — approximate positive ledger inflows and portfolio income; refunds are identified as potentially non-taxable
- `getCapitalGainsForYear(year)` — gross sale proceeds and canonical realized gain as separate fields, including inactive historical investments; non-unit assets expose unsupported realized gain as `null`
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

| Action                    | Trigger                                                        | Result                                                                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New conversation          | Click "New chat"                                               | POST `/api/ai/conversations` creates empty conversation; sets URL param `?c=<id>` and selects it                                                                                                                                                                                          |
| Auto-title                | Send first message to new conversation                         | Backend renames conversation from `"New conversation"` to first message (≤60 chars, truncated)                                                                                                                                                                                            |
| Send message              | Enter in composer (Shift+Enter = newline)                      | POST `/api/ai/conversations` if no selection; then POST `/api/ai/chat/stream` (SSE). Stream runs in background store and survives page navigation. Sidebar shows pulsing indicator on active conversation. On completion, TanStack Query cache invalidated so persisted messages hydrate. |
| Abort generation          | Click "Stop" during streaming                                  | Calls `cancel()` on store; aborts fetch via stored abort controller; keeps the partial client draft, labels it stopped, and offers Retry without showing an error toast                                                                                                                   |
| Retry incomplete response | Click "Retry" under a stopped, interrupted, or timed-out draft | Regenerates the latest incomplete turn with the same model and tool settings. The server reuses the persisted user row instead of appending the prompt again; the new generation replaces the retained draft.                                                                             |
| Rename conversation       | Double-click title or pencil icon                              | PATCH `/api/ai/conversations/:id`                                                                                                                                                                                                                                                         |
| Delete conversation       | Trash icon + confirm                                           | DELETE cascades messages; if selected, clears URL param and `selectedId` **before** mutation to prevent race-condition refetch 404s                                                                                                                                                       |
| Switch model              | Select in composer dropdown                                    | Persists on conversation; next send uses new model                                                                                                                                                                                                                                        |
| Toggle tools              | Click wrench icon in composer                                  | Toggles `useTools` state; when OFF, next sends pass `useTools: false` to backend, disabling tool-calling                                                                                                                                                                                  |
| Switch conversation       | Click in list                                                  | Updates URL param `?c=<id>` (or removes if deselecting); re-subscribes to new conversation's stream state; prior stream continues running in background                                                                                                                                   |
| Load older conversations  | Click **Load more** below the sidebar list                     | Fetches the next 50-row page; the API keeps a full `total` count and the list appends the page without replacing newer conversations                                                                                                                                                      |
| Navigate away & return    | Browser back/forward or sidebar nav                            | URL param `?c=<id>` restored; if stream was in-flight, sidebar indicator still visible; auto-selects stream (effect watches `streamingIds`) so user can see it complete                                                                                                                   |
| Deep-link to conversation | Open `?c=<id>` in new tab/bookmark                             | Page loads, hydrates URL state, fetches conversation detail, shows messages + any in-flight streaming                                                                                                                                                                                     |

## Configuration

### Settings

| Setting                     | Type   | Default                  | Description                                              |
| --------------------------- | ------ | ------------------------ | -------------------------------------------------------- |
| `aiDefaultModel`            | string | Operator Ollama default  | Model pre-selected on new local conversations            |
| `openAiDefaultModel`        | string | Operator OpenAI default  | Approved model pre-selected on new OpenAI investigations |
| `aiChat.ollamaUrl`          | string | `http://localhost:11434` | Ollama host (read from `OLLAMA_URL` env; editable in UI) |
| `ollama.numCtx`             | number | `8192`                   | Ollama context window passed to every chat request       |
| `aiChat.contextBudgetChars` | number | `24000`                  | Approximate prompt-history character budget              |
| `aiChat.maxToolResultChars` | number | `6000`                   | Per-tool-result character cap in model context           |

### Environment Variables

- `OLLAMA_URL` — base URL for the Ollama HTTP API
- `OLLAMA_DEFAULT_MODEL` — fallback model if user hasn't set one
- `OLLAMA_NUM_CTX` — Ollama context window sent as `options.num_ctx` (default 8192)
- `AI_CHAT_RATE_LIMIT` — per-minute cap on `/api/ai/chat` (default 30)
- `AI_CHAT_MAX_HISTORY` — hard upper bound on prior messages considered (default 30)
- `AI_CHAT_CONTEXT_BUDGET_CHARS` — approximate character budget for prior messages (default 24000)
- `AI_CHAT_MAX_TOOL_RESULT_CHARS` — per-result model-context cap (default 6000)

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
- **Context window overflow** — the service first applies the message-count ceiling, then admits history newest-first under an approximate character budget after reserving the system prompt and current user request. The newest history item is shortened instead of dropped when only part fits. Ollama receives the configured `num_ctx` for both streaming and non-streaming calls.
- **LLM picks an unknown tool name** — dispatcher returns a structured error back to the LLM as a `tool` message; LLM retries or apologizes.
- **LLM emits invalid args** — `ToolValidationError` returned as a `tool` error `{code: 'VALIDATION_ERROR', field, message}` naming the field and the received value; LLM retries with corrected args (up to 2 retries before giving up).
- **Tool failure shown in the transcript** — `ToolResultCard` never renders the backend's raw
  string, field, message, code, or serialized error object. Known validation and unknown-tool
  codes map to localized user guidance; every other failure uses `aiChat.toolFailed`. The original
  diagnostic remains in the frontend error log with the tool name for troubleshooting.
- **User aborts mid-stream** — clicking "Stop" calls `cancel()` on the store, which aborts the fetch via stored controller; server-side `res.on('close')` stops provider work and does not persist an incomplete assistant row. The client retains any partial preview, labels the turn stopped, and offers Retry. Cancellation does not produce an error toast.
- **Connection drops mid-stream** — the store retains the partial preview, labels it interrupted, shows the normal localized error toast, and offers Retry with the original request body.
- **Hung-open connection** — a client watchdog aborts after 120 seconds without a data-bearing Server-Sent Events (SSE) frame. Every parsed data frame, including an unrecognized forward-compatible event, resets the inactivity window. The draft is labeled timed out and can be retried.
- **Retry semantics** — `retryLastTurn: true` requires an existing conversation. Model turns are serialized per conversation, so a retry submitted while the original request is finishing waits and then re-reads persisted history. The service finds the latest persisted user row, rebuilds model context from before that turn, and does not append or re-emit the user row. If an assistant response exists by then, it rejects the retry with `TURN_ALREADY_COMPLETE`; the frontend refreshes the transcript and retires the frozen draft so the completed persisted answer is shown.
- **Late completion after cancel or retry** — a per-conversation generation counter ignores events and promise rejection from an older request, so stale work cannot overwrite the newer stream state.
- **Rate limit tripped** — 429 with `Retry-After`; composer shows cooldown hint.
- **Long tool result** — query output remains capped to 500 rows. Before model replay, an oversized result keeps its `ok`, `meta`, and `error` envelope and replaces `data` with truncation metadata plus a bounded preview. The full result remains persisted for the application and audit trail.
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
- `[ai] streamChat event` — per Server-Sent Events frame (`user_message`, `token`, `tool_call`, `tool_result`, `complete`, `error`).
- `AI tool returned an error` — records the tool name and original tool-result diagnostic that the
  transcript intentionally replaces with localized safe copy.

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
- [[docs/api/ai-research|AI Research API]] — investigations, documents, and disclosure records
- [[docs/adr/145-bounded-ai-research-orchestration|ADR-145: Bounded AI Research Orchestration]]
- [[docs/adr/147-allowlisted-openai-model-selection|ADR-147: Allowlisted OpenAI Model Selection]]
- [[docs/adr/151-scoped-reversible-ai-references|ADR-151: Scoped Reversible AI References]]
- [[docs/features/transactions|Transactions]] — data surfaced by expense tools
- [[docs/features/portfolio|Portfolio & Investments]] — data surfaced by portfolio tools
- [[docs/features/plannedTransactions|Planned Transactions]] — data surfaced by planned tools
- [[docs/features/belgian-tax|Belgian Tax]] — data surfaced by tax tools
