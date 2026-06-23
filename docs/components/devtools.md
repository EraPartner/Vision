---
title: Devtools Components
type: component
status: active
date: 2026-06-18
tags: [components, frontend, devtools, observability, admin-mode, request-tracking, metrics, inspector]
description: Observability UI components for API request tracking and query metrics. Includes ApiInspector floating panel, RequestList with virtualization, RequestDetail pane, MetricsPanel with aggregates, and InspectorToggle button. Shipped as a lazy chunk, gated by dev build flags or the runtime Admin Mode toggle.
aliases: [devtools components, inspector, api inspector, request inspector]
---

# Devtools Components

> [!abstract] Overview
> React components for the observability layer, providing real-time API request tracking, query metrics visualization, and interactive inspector panel. Activated in dev builds or via the runtime Admin Mode toggle.

## Root Component: DevtoolsRoot

**File:** `[[apps/frontend/src/components/devtools/DevtoolsRoot.tsx]]`

Orchestrator component that initializes and mounts all devtools UI elements.

### Responsibilities

1. Initializes `queryClient` metrics subscription via `initQueryMetrics(queryClient)`
2. Registers global keyboard shortcut via `registerInspectorHotkey()`
3. Renders `<ReactQueryDevtools>` (TanStack DevTools integration at bottom-left)
4. Renders `<InspectorToggle>` floating button (bottom-right)
5. Conditionally renders `<ApiInspector>` panel when inspector is open

### Props

None — DevtoolsRoot is a pure orchestrator with no props.

### Usage

```tsx
// In App.tsx, wrapped in Suspense and DEV guard
{import.meta.env.DEV && (
  <Suspense fallback={null}>
    <DevtoolsRoot />
  </Suspense>
)}
```

---

## Inspector Panel: ApiInspector

**File:** `[[apps/frontend/src/components/devtools/ApiInspector.tsx]]`

Floating panel (520×480px, z-index 9999) with tabbed interface for request history and metrics.

### Props

```typescript
type ApiInspectorProps = {
  // No props — reads state from hooks
};
```

### State

- `activeTab`: 'requests' | 'metrics' — Selected tab
- `selectedRequestId`: string | null — Selected request for detail pane

### Tabs

| Tab | Component | Content |
|-----|-----------|---------|
| **Requests** | `<RequestList>` + `<RequestDetail>` | Virtualized request list with detail split-pane |
| **Metrics** | `<MetricsPanel>` | Aggregated query statistics and slow-request tracking |

### Styling

- Uses shadcn tokens for automatic dark/light theme integration
- `bg-background`, `border`, `text-foreground` for theme consistency
- 520×480px fixed size with smooth drags
- Positioned absolutely in top-right area

---

## Request List: RequestList

**File:** `[[apps/frontend/src/components/devtools/RequestList.tsx]]`

Virtualized list of API requests with filtering and row selection.

### Props

```typescript
type RequestListProps = {
  requests: ApiRequest[];
  selectedRequestId: string | null;
  onSelectRequest: (id: string) => void;
};
```

### Features

- **Virtualization:** @tanstack/react-virtual for smooth scrolling of 100+ requests
- **Filter input:** Search by endpoint or method
- **Column headers:** Method (color-coded), Endpoint, Status, Duration
- **In-flight animation:** Shows `…` ellipsis for requests still pending
- **Row highlighting:** Selected row uses `bg-accent` background

### Columns

| Column | Content | Details |
|--------|---------|---------|
| **Method** | HTTP method badge | GET/POST/PATCH/DELETE with distinct colors |
| **Endpoint** | API path | Truncated with tooltip on hover |
| **Status** | HTTP status code | Color-coded (2xx green, 4xx orange, 5xx red, pending gray) |
| **Duration** | Response time in ms | Shows `…` for in-flight requests |

### Usage

```tsx
<RequestList
  requests={requestLog}
  selectedRequestId={selectedId}
  onSelectRequest={setSelectedId}
/>
```

---

## Request Detail: RequestDetail

**File:** `[[apps/frontend/src/components/devtools/RequestDetail.tsx]]`

Split-pane detail view for the selected request showing full metadata.

### Props

```typescript
type RequestDetailProps = {
  request: ApiRequest | null;
  isLoading: boolean;
};
```

### Content Sections

| Section | Data |
|---------|------|
| **Identity** | Endpoint, Method, Request ID |
| **Response** | Status code, Duration (ms), Attempt count |
| **Error** | Error code and message (if error phase) |
| **Timing** | Start time, end time, total duration |

### Styling

- Monospace font for IDs and codes
- Code-block styling for error messages
- Copy-to-clipboard button for Request ID

### Empty State

Shows "Select a request to view details" when `request` is null.

---

## Metrics Panel: MetricsPanel

**File:** `[[apps/frontend/src/components/devtools/MetricsPanel.tsx]]`

Dashboard view of aggregated query metrics with stat cards and tables.

### Props

```typescript
type MetricsPanelProps = {
  // No props — reads from useQueryMetrics() hook
};
```

### Stat Cards

| Card | Metric | Calculation |
|------|--------|------------|
| **Total Requests** | Count of all requests | All in-flight + completed |
| **Error Rate** | Percentage of errors | `(errorCount / totalRequests) * 100` |
| **Cache Hit Ratio** | Query cache efficiency | `(hits / (hits + misses)) * 100` |
| **Mutation Success** | Successful mutations | `successCount / totalMutations` |

### Sections

**Slow Requests (>1s):**
- Table of requests exceeding 1000ms
- Columns: Method, Endpoint, Duration, Timestamp
- Helps identify performance bottlenecks

**Top Endpoints:**
- Table of top 10 endpoints by request count
- Columns: Endpoint, Request Count, p50 Latency, p95 Latency
- Shows latency percentiles for capacity planning

---

## Inspector Toggle Button: InspectorToggle

**File:** `[[apps/frontend/src/components/devtools/InspectorToggle.tsx]]`

Bottom-right floating button for opening/closing the inspector panel.

### Props

```typescript
type InspectorToggleProps = {
  // No props — reads inspector state from hook
};
```

### Features

- **In-flight counter:** Displays badge with number of pending requests
- **Pulse animation:** Amber pulse when requests are in-flight
- **Highlight state:** Border highlight when inspector is open
- **Click handler:** Toggle `useInspectorOpen()` state

### Styling

- Fixed position at bottom-right (z-index 9998, below inspector)
- Emerald background with white icon
- Smooth transitions for hover/active states

---

## Hooks

### useApiRequestLog

**Source:** `[[apps/frontend/src/lib/devtools/apiRequestLog.ts]]`

Returns the ring buffer of API requests with subscription updates.

```typescript
const requests = useApiRequestLog();
// Returns: ApiRequest[] (max 200 entries)
```

### useQueryMetrics

**Source:** `[[apps/frontend/src/lib/devtools/queryMetrics.ts]]`

Returns aggregated TanStack Query metrics.

```typescript
const metrics = useQueryMetrics();
// Returns: {
//   totalRequests: number;
//   errorRate: number; // 0-100
//   slowRequests: ApiRequest[];
//   topEndpoints: Array<{ endpoint: string; count: number; p50: number; p95: number; }>;
//   cacheHitRatio: number; // 0-100
//   mutationSuccessRate: number; // 0-100
// }
```

### useInspectorOpen

**Source:** `[[apps/frontend/src/lib/devtools/devtoolsHotkey.ts]]`

Returns inspector open state.

```typescript
const [isOpen, setIsOpen] = useInspectorOpen();
```

---

## Integration Points

### API Client Integration

All requests automatically participate via `[[apps/frontend/src/lib/api/client.ts]]`:

- Every request through `apiRequest()` emits lifecycle events (start, success, error)
- Request ID (UUID) is set as `X-Request-Id` header for backend correlation
- No changes needed to 38 domain hooks — observability is automatic

### React Query Integration

QueryCache and MutationCache subscriptions automatically wire metrics:

```typescript
// In DevtoolsRoot
useEffect(() => {
  initQueryMetrics(queryClient);
}, [queryClient]);
```

---

## Performance Considerations

| Concern | Mitigation |
|---------|-----------|
| **Ring buffer memory** | Max 200 entries (~100KB) |
| **Virtualization lag** | @tanstack/react-virtual renders only visible rows |
| **Event bus overhead** | Zero cost when inspector closed (no subscribers) |
| **Metrics computation** | Incremental updates on each event |
| **Lazy chunk** | Devtools ship in a separate chunk fetched only when the gate renders it (dev build or Admin Mode on) — no load cost until activated |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+A` (Mac) | Toggle inspector open/closed |
| `Ctrl+Shift+A` (Windows/Linux) | Toggle inspector open/closed |

---

## Related Documentation

- [[docs/features/dev-observability|Dev-Only Observability Feature]] — Architecture and design decisions
- [[docs/reference/code-patterns#devtools-integration-pattern|Code Patterns — Devtools Integration]]
- [[docs/components/index|Components Index]]
