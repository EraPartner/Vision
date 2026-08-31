---
title: Observability Layer (API Inspector)
type: feature
status: active
date: 2026-06-18
tags:
  [
    feature,
    frontend,
    observability,
    devtools,
    api-inspector,
    admin-mode,
    metrics,
    performance-monitoring,
    phase-x,
  ]
description: Observability layer providing real-time API request tracking, query metrics, and request inspector panel. Built on a module-level pub-sub bus, shipped as a lazy chunk that loads only when activated. Enabled in dev builds (import.meta.env.DEV / VITE_DEVTOOLS) or at runtime via the Admin Mode toggle (works in the packaged Electron app and release image). Includes Inspector hotkey (Cmd+Shift+A), RequestList, RequestDetail, MetricsPanel, and TanStack React Query DevTools integration.
aliases:
  [
    devtools,
    dev observability,
    api inspector,
    request log,
    query metrics,
    observability,
  ]
---

# Observability Layer (API Inspector)

> [!abstract] Purpose
> A comprehensive observability layer for monitoring API requests, query performance metrics, and system health in real-time. Available in dev builds and — via the **Admin Mode** runtime toggle — in any build including the packaged Electron app. Shipped as a lazy chunk that is only fetched once activated, so it costs nothing until enabled.

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
  phase: "start" | "success" | "error";
  requestId: string;
  endpoint: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  durationMs?: number; // Only on success/error
  status?: number; // Only on success/error
  errorCode?: string; // Only on error
  errorMessage?: string; // Only on error
  timestamp: number; // ms since epoch
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

| Metric                | Calculation                                              |
| --------------------- | -------------------------------------------------------- |
| `totalRequests`       | Count of all requests (in-flight + completed)            |
| `errorRate`           | `(errorCount / totalRequests) * 100`                     |
| `slowRequests`        | Array of requests with `durationMs > 1000`               |
| `topEndpoints`        | Top 10 endpoints by request count with p50/p95 latencies |
| `cacheHitRatio`       | Query cache hits / (hits + misses) × 100                 |
| `mutationSuccessRate` | Successful mutations / total mutations × 100             |

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

| Tab          | Content                                                     |
| ------------ | ----------------------------------------------------------- |
| **Requests** | Split-pane view: RequestList (left) + RequestDetail (right) |
| **Metrics**  | MetricsPanel with stat cards and top-endpoints table        |

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

### Backend log correlation

The backend `requestId` middleware seeds an `AsyncLocalStorage` request context
after it validates or generates the `X-Request-Id` value. The shared logger adds
that ambient `requestId` to service, repository, scheduler, and route log
metadata created by the same asynchronous request chain. Logs outside an HTTP
request omit the field. A call that supplies an explicit `requestId` keeps that
value, which supports process-level error handlers without duplicate fields.

This makes the request ID shown by the API Inspector usable to filter backend
container logs without passing the Express request object through domain code.

## Activation

**File:** `[[apps/frontend/src/App.tsx]]`

The devtools are always built as a lazily-loaded chunk and gated at render time.
They appear when **any** of these is true:

- `import.meta.env.DEV` — local Vite dev server
- `import.meta.env.VITE_DEVTOOLS === 'true'` — Docker dev build (build arg from
  `docker-compose.dev.yml`)
- `appSettings.adminMode` — the user's **Admin Mode** toggle (Settings → About),
  evaluated at runtime. This is the only path that works in the packaged Electron
  app and the public release image, which run a normally-built bundle with no
  `VITE_DEVTOOLS` build arg.

```tsx
const isDevtoolsBuildEnabled =
  import.meta.env.DEV || import.meta.env.VITE_DEVTOOLS === "true";

const DevtoolsRoot = lazy(() =>
  import("@/components/devtools/DevtoolsRoot").then((m) => ({
    default: m.DevtoolsRoot,
  })),
);

function DevtoolsGate() {
  // Reads the Zustand store directly — no provider needed, so it works above the
  // settings context providers where the devtools mount.
  const adminMode = useSettingsStore((s) => s.appSettings.adminMode);
  if (!isDevtoolsBuildEnabled && !adminMode) return null;
  return (
    <Suspense fallback={null}>
      <DevtoolsRoot />
    </Suspense>
  );
}
```

- The devtools live in a **separate lazy chunk** (`React.lazy()` + `Suspense`)
  that is only fetched the first time the gate renders it — so users who never
  enable Admin Mode pay no load cost.
- The build-flag paths (`import.meta.env.DEV` / `VITE_DEVTOOLS`) keep the
  inspector always-on for local and Docker dev work.

## Design Decisions

| Decision                      | Rationale                                                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Module-level pub-sub**      | Zero-cost operation; no subscription overhead when inspector closed                                                                                                         |
| **Ring buffer (200 entries)** | Balances history depth with memory footprint                                                                                                                                |
| **X-Request-Id header**       | Correlates frontend request lifecycle with backend logs                                                                                                                     |
| **@tanstack/react-virtual**   | Efficient rendering of hundreds of requests without lag                                                                                                                     |
| **Cmd+Shift+A hotkey**        | Avoids conflicts with `Cmd+Shift+I` (browser DevTools) on all platforms                                                                                                     |
| **No state persistence**      | Inspector state lost on reload (suitable for an opt-in observability tool)                                                                                                  |
| **Runtime + build gating**    | Build flags (`import.meta.env.DEV` / `VITE_DEVTOOLS`) keep it always-on in dev; the runtime `adminMode` toggle exposes it in any build, including the packaged Electron app |
| **Lazy DevtoolsRoot**         | Separate chunk fetched only when the gate renders it — zero load cost until dev build or Admin Mode is on                                                                   |
| **shadcn tokens**             | Inspector automatically inherits theme (dark/light) from app settings                                                                                                       |

## Related Documentation

- [[docs/components/devtools|Devtools Components]] — Detailed component API reference
- [[docs/reference/code-patterns#devtools-integration-pattern|Code Patterns — Devtools Integration]]
- [[docs/api/admin|Admin Observability API]] — Backend admin endpoints (complementary feature)
- [[docs/features/admin-observability|Admin Observability Feature]] — System health dashboards

## Troubleshooting

### Inspector won't open

- In a production/Electron build, enable **Admin Mode** (Settings → About) — the
  floating "API" toggle appears bottom-right once it is on
- In dev, verify `import.meta.env.DEV` is true (dev server) or `VITE_DEVTOOLS=true`
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

- **Zero cost until activated** — The devtools live in a separate lazy chunk that
  is only fetched when the gate renders it (dev build or Admin Mode on); users who
  never enable Admin Mode never download it
- **Dev server overhead** — ~2-5ms per request for event bus dispatch (negligible)
- **Memory footprint** — ~200 request objects (~100KB max) in ring buffer
- **Inspector panel rendering** — Virtualized list ensures smooth 60fps even with hundreds of entries
