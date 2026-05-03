---
title: ADR-048 AI Chat Module-Level Stream Store
type: adr
status: Accepted
date: 2026-05-03
tags: [adr, ai, streaming, state-management, architecture, frontend, useSyncExternalStore]
description: Decouple AI chat SSE stream lifetime from React component lifecycle via module-level singleton store
aliases: [adr-048, stream store, background streaming, module-level store]
related_adr: [024]
---

# ADR-048: AI Chat Module-Level Stream Store

## Status
Accepted

## Date
2026-05-03

## Context

From ADR-024, Vision's AI Chat integrates Ollama for local natural-language financial queries. Streaming responses arrive via Server-Sent Events (SSE) over `POST /api/ai/chat/stream`.

**Problem:** In v1, stream state (preview text, tool messages, streaming flag) lived inside `useSendChatMessage` hook state. When a user navigated away from the AI chat page (e.g., to Budget, Portfolio, or Settings), the component unmounted, the SSE fetch aborted, and in-flight messages were lost.

**User impact:** Mid-response navigation forced users to re-send the message, wasting compute and breaking the continuity of multi-turn conversations.

**Root cause:** React component lifecycle (mount → unmount) should not govern the lifetime of an independent server-side operation. The SSE stream is a first-class async task with its own lifecycle—start, stream events, complete—orthogonal to UI state.

## Decision

### 1. Module-Level Singleton Store
Create `apps/frontend/src/lib/aiChatStreamStore.ts` — a class instantiated once at module load, persisting for the app's lifetime. The store holds:
- **streams** map: `conversationId → StreamState` (in-flight preview + state)
- **aborts** map: `conversationId → abort controller` (for cancellation)
- **listeners** set: subscriber callbacks (for `useSyncExternalStore`)
- **activeIdsCache**: memoized list of conversations with active streams

### 2. Store API
- **`subscribe(listener)`** — register a callback; invoked on any state change; returns unsubscribe fn.
- **`getState(conversationId)`** — snapshot of stream preview (assistantDraft, toolMessages, userMessage, error, isStreaming).
- **`getActiveConversationIds()`** — readonly list of conversation IDs currently streaming; used by sidebar.
- **`send(body, queryClient, onError)`** — orchestrates SSE: starts stream, accumulates events, handles completion, invalidates TanStack Query cache.
- **`cancel(conversationId)`** — aborts fetch, clears streaming flag.
- **`clear(conversationId)`** — removes stream from store (called post-completion).

### 3. React Hook Integration
`useSendChatMessage(conversationId)` becomes a **thin subscriber**:
```typescript
const subscribe = useCallback((listener) => aiChatStreamStore.subscribe(listener), []);
const getSnapshot = useCallback(() => aiChatStreamStore.getState(conversationId), [conversationId]);
const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
```

When component unmounts, subscription is unsubscribed but the store's stream keeps running. On remount (e.g., returning to chat page), hook re-subscribes and rehydrates preview.

### 4. Conversation Pre-Creation
Before streaming, client POSTs `/api/ai/conversations` to create an empty conversation:
```typescript
const created = await createMut.mutateAsync({});
conversationId = created.conversation.id;
await send({ conversationId, message, ... });
```

This ensures the stream key is always a real conversation ID—no PENDING bookkeeping. Server-side `ai_conversations` table is the source of truth.

### 5. URL-Backed Selection
`AIChatPage` uses `useSearchParams()` to persist selected conversation in URL:
- `?c=<id>` on page load hydrates selection.
- User clicks conversation → updates URL param.
- User navigates away & returns → URL param restored (deep-linkable).
- If stream is in-flight and URL has no selection, effect auto-selects stream (via `useStreamingConversationIds()`).

### 6. Streaming Indicator
`ChatConversationList` calls `useStreamingConversationIds()` (another hook over the store) to get active stream IDs, rendering a pulsing dot on matching rows. Sidebar is always visible, so user sees live activity even when not on the chat page.

## Consequences

### Positive
- **Uninterrupted streaming** — users can navigate freely while in-flight responses complete.
- **Clear separation of concerns** — stream lifecycle independent of component lifecycle; easier to reason about.
- **Deep-linking** — conversation ID in URL is shareable and persistent.
- **Live activity visibility** — sidebar indicator shows streaming even on other pages.
- **Reuses React patterns** — `useSyncExternalStore` is the standard hook for external stores (Redux, Zustand, etc.).
- **No breaking changes** — `useSendChatMessage` API unchanged; hook still returns `{send, cancel, ...state}`.

### Negative
- **Module-level global state** — adds a singleton. Not as testable as pure functions, but store is deterministic and subscribers are explicit.
- **Store complexity** — manage listeners, memoization, and event flows manually (though the class is ~180 lines and straightforward).
- **Cache invalidation** — on stream completion, TanStack Query cache must be invalidated *after* store preview is cleared; ordering matters.

### Neutral
- **Server-side unchanged** — backend SSE endpoint and persistence logic unaffected. Server still aborts on `res.on('close')`, which only fires on tab close or full network loss.
- **E2E testing** — tests can still mock `apiClient.streamChat()` and verify preview state transitions; store testing is deterministic.

## Related
- [[docs/adr/024-local-llm-chat|ADR-024: Local LLM Chat Integration]] — original design decision for Ollama integration and SSE streaming.
- [[docs/features/ai-chat|Feature: AI Chat]] — user-facing behavior and interactions.
- [[apps/frontend/src/lib/aiChatStreamStore.ts|aiChatStreamStore implementation]].
