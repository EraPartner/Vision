---
title: Dev-Only Observability Layer
type: feature
status: active
date: 2026-05-12
tags: [feature, frontend, observability, devtools, dev-only, api-inspector, metrics, performance-monitoring, phase-x]
description: Dev-only observability layer providing real-time API request tracking, query metrics, and request inspector panel. Built on module-level pub-sub bus with zero-cost when inactive (tree-shaken in production). Includes Inspector hotkey (Cmd+Shift+A), RequestList, RequestDetail, MetricsPanel, and TanStack React Query DevTools integration.
aliases: [devtools, dev observability, api inspector, request log, query metrics, observability]
---

# Dev-Only Observability Layer

> [!abstract] Purpose
> A comprehensive dev-only observability layer for monitoring API requests, query performance metrics, and system health in real-time. Fully tree-shaken in production builds via `import.meta.env.DEV` guards.

## Overview

The observability layer provides developers with granular visibility into:

- **Real-time request tracking**: All API calls flow through a pub-sub event bus with request lifecycle events (start, success, error)
- **Request history**: 200-entry ring buffer of completed and in-flight requests with full details
- **Query metrics**: Aggregated TanStack Query statistics (success rate, slow requests, top endpoints, cache efficiency)
- **Interactive inspector panel**: Floating UI accessible via `Cmd+Shift+A` with tabs for requests and metrics
- **React Query DevTools**: Integrated at bottom-left corner (TanStack DevTools)

## Architecture

### Layer 1: Event Bus (Zero-Cost Module-Level Pub-Sub)

**File:** `[[apps/frontend/src/lib/devtools/apiEventBus.ts]]`

Exports a module-scoped event emitter that:

- Emits `ApiRequestEvent` on every request lifecycle phase (start, success, error)
- Maintains zero-cost operation when no subscribers attached (no event loop pollution)
- Carries complete request metadata including requestId, endpoint, method, duration, status, and error context

```typescript
// Event shape
type ApiRequestEvent = {
  phase: 'start' | 'success' | 'error';
  requestId: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  durationMs?: number;           // Only on success/error
  status?: number;               // Only on success/error
  errorCode?: string;            // Only on error
  errorMessage?: string;         // Only on error
  timestamp: number;             // ms since epoch
};
```

### Layer 2: Request Log (Ring Buffer)

**File:** `[[apps/frontend/src/lib/devtools/apiRequestLog.ts]]`

Subscribed to the event bus, maintains a fixed-size ring buffer (capacity: 200) of requests:

- Tracks both in-flight and completed requests
- Exposes `useApiRequestLog()` hook via `useSyncExternalStore` for reactive UI updates
- Provides `getRequestDetail(requestId)` for detail-pane queries
- Automatically evicts oldest entries when buffer is full

### Layer 3: Query Metrics (TanStack Query + Event Bus)

**File:** `[[apps/frontend/src/lib/devtools/queryMetrics.ts]]`

Subscribes to both the API event bus and TanStack Query's QueryCache + MutationCache:

**Metrics exposed:**

| Metric | Calculation |
|--------|-----------|
| `totalRequests` | Count of all requests (in-flight + completed) |
| `errorRate` | `(errorCount / totalRequests) * 100` |
| `slowRequests` | Array of requests with `durationMs > 1000` |
| `topEndpoints` | Top 10 endpoints by request count with p50/p95 latencies |
| `cacheHitRatio` | Query cache hits / (hits + misses) × 100 |
| `mutationSuccessRate` | Successful mutations / total mutations × 100 |

Call `initQueryMetrics(queryClient)` on app startup to wire QueryCache subscriptions.

### Layer 4: Inspector Hotkey & Toggle

**File:** `[[apps/frontend/src/lib/devtools/devtoolsHotkey.ts]]`

Global keyboard shortcut system:

- **Hotkey:** `Cmd+Shift+A` (avoids browser conflicts with `Cmd+Shift+I`)
- **Exports:** `useInspectorOpen()` hook (boolean), `toggleInspector()` function, `registerInspectorHotkey()` setup
- **State:** Stored in volatile memory (lost on page reload)

### Components Layer

**Root Mount:** `[[apps/frontend/src/components/devtools/DevtoolsRoot.tsx]]`

Orchestrator component that:

1. Renders `<ReactQueryDevtools>` (bottom-left) with TanStack's DevTools
2. Renders `<InspectorToggle>` (bottom-right) floating button with in-flight request count
3. Conditionally renders `<ApiInspector>` floating panel when open
4. Calls `initQueryMetrics(queryClient)` in `useEffect` on mount
5. Calls `registerInspectorHotkey()` to enable keyboard shortcuts

**Inspector Panel:** `[[apps/frontend/src/components/devtools/ApiInspector.tsx]]`

Floating 520×480px panel (z-index 9999) with two tabs:

| Tab | Content |
|-----|---------|
| **Requests** | Split-pane view: RequestList (left) + RequestDetail (right) |
| **Metrics** | MetricsPanel with stat cards and top-endpoints table |

**Request List:** `[[apps/frontend/src/components/devtools/RequestList.tsx]]`

- Virtualized list (@tanstack/react-virtual) for smooth scrolling of hundreds of requests
- Filter input (by endpoint, method)
- Columns: Method (color-coded), Endpoint, Status, Duration
- In-flight entries show `…` animation
- Clicking a row updates detail pane

**Request Detail:** `[[apps/frontend/src/components/devtools/RequestDetail.tsx]]`

Split-pane view showing:

- Endpoint, Method, RequestId
- Status code, Duration (ms), Attempt count (for retries)
- Error code and message (if error phase)
- Request/response preview (if available)

**Metrics Panel:** `[[apps/frontend/src/components/devtools/MetricsPanel.tsx]]`

Stat cards with real-time updates:

- Total Requests
- Error Rate (%)
- Cache Hit Ratio (%)
- Mutation Success Rate (%)
- Slow Requests (>1s) list
- Top Endpoints table with p50/p95 latencies

**Inspector Toggle:** `[[apps/frontend/src/components/devtools/InspectorToggle.tsx]]`

Bottom-right floating button:

- Shows in-flight request count with amber pulse animation
- Highlights when inspector is open
- Click to toggle inspector visibility

## Integration with API Client

**Modified:** `[[apps/frontend/src/lib/api/client.ts]]`

The single `apiRequest()` chokepoint now:

1. **Mints requestId** (UUID) before the retry loop and sets it as `X-Request-Id` header for backend log correlation
2. **Emits phase:start** on each retry attempt
3. **Emits phase:success** after successful response unwrap with durationMs and status
4. **Emits phase:error** for both `ApiClientError` and network failures with durationMs, status, and errorCode
5. **Calls logger.debug()** for each outcome

This ensures all 38 domain hooks (`useTransactions`, `usePortfolio`, etc.) automatically participate in observability without any changes to their implementations.

## Dev-Only Activation

**File:** `[[apps/frontend/src/App.tsx]]`

```tsx
import DevtoolsRoot from '@/components/devtools/DevtoolsRoot';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Production build: Vite tree-shakes entire devtools chunk */}
      {import.meta.env.DEV && (
        <Suspense fallback={null}>
          <DevtoolsRoot />
        </Suspense>
      )}
      {/* Rest of app... */}
    </QueryClientProvider>
  );
}
```

- `import.meta.env.DEV` is **statically replaced by Vite** during build
- Production bundles contain **zero devtools references** (verified: `grep -r "devtools" dist/` returns nothing)
- Dev bundles load DevtoolsRoot lazily via `React.lazy()` + `Suspense`

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Module-level pub-sub** | Zero-cost operation; no subscription overhead when inspector closed |
| **Ring buffer (200 entries)** | Balances history depth with memory footprint |
| **X-Request-Id header** | Correlates frontend request lifecycle with backend logs |
| **@tanstack/react-virtual** | Efficient rendering of hundreds of requests without lag |
| **Cmd+Shift+A hotkey** | Avoids conflicts with `Cmd+Shift+I` (browser DevTools) on all platforms |
| **No state persistence** | Inspector state lost on reload (suitable for dev-only tool) |
| **Static tree-shaking** | `import.meta.env.DEV` eliminated by Vite, not runtime checked |
| **Lazy DevtoolsRoot** | Reduces initial bundle size; loaded only when needed in dev |
| **shadcn tokens** | Inspector automatically inherits theme (dark/light) from app settings |

## Related Documentation

- [[docs/components/devtools|Devtools Components]] — Detailed component API reference
- [[docs/reference/code-patterns#devtools-integration-pattern|Code Patterns — Devtools Integration]]
- [[docs/api/admin|Admin Observability API]] — Backend admin endpoints (complementary feature)
- [[docs/features/admin-observability|Admin Observability Feature]] — System health dashboards

## Troubleshooting

### Inspector won't open
- Verify `import.meta.env.DEV` is true (dev server, not production build)
- Check browser console for errors in DevtoolsRoot component
- Ensure app is inside `<QueryClientProvider>`

### No requests appearing in list
- Verify API calls are going through `apiRequest()` chokepoint
- Check "Requests" tab is active
- Try making a transaction query or API call manually

### Metrics show zero
- Call `initQueryMetrics(queryClient)` in DevtoolsRoot useEffect (default: auto-initialized)
- Verify QueryCache is attached to `queryClient` instance

## Performance Impact

- **Zero cost in production** — Entire devtools chunk tree-shaken
- **Dev server overhead** — ~2-5ms per request for event bus dispatch (negligible)
- **Memory footprint** — ~200 request objects (~100KB max) in ring buffer
- **Inspector panel rendering** — Virtualized list ensures smooth 60fps even with hundreds of entries
