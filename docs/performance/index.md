---
title: Performance Documentation Index
type: performance-index
status: active
date: 2026-04-25
last_modified: 2026-09-04
tags: [performance, index, optimization, startup, offline-resilience]
description: Performance optimization strategies including caching, materialized views, chart downsampling, and offline-aware startup optimization.
aliases: [performance, optimization, speed]
---

# Performance Documentation

> [!abstract] Overview
> Performance optimization strategies for Vision. Covers caching layers, database optimizations, and frontend rendering improvements.

## All Performance Docs

```dataview
TABLE WITHOUT FILE title AS "Topic", description AS "Description", date AS "Updated"
FROM "docs/performance"
WHERE type = "performance"
SORT title ASC
```

## Recent Optimizations

**2026-09-04: WOFF2-only faces and nested AI tool charts** — Vision now declares its eight static
Inter/Fraunces faces in one WOFF2-only stylesheet, so production builds no longer emit unused
legacy WOFF copies. The existing build plugin still injects hashed preloads for Inter 400 and
Fraunces 600. `ToolResultCard` now lazy-loads the Recharts-backed `ToolResultChart` only for
line, bar, or pie results; ordinary AI chat, table, JSON, and error messages do not download the
chart renderer. Runtime Zod validation and the application-wide Belgian tax profile remain in the
boot graph by explicit product decision.

**2026-08-31: route-only Radix packages removed from the boot vendor chunk** — `[[apps/frontend/vite.config.ts]]` now assigns the 15 primitives used by the application shell or preloaded Dashboard route to the stable `radix-ui` chunk. Seven route-only primitives follow Rollup's route-level splitting instead of being hoisted solely because they share the `@radix-ui` namespace. Back-to-back production builds of the same tree measured 435.02 to 428.62 KiB gzip for the boot graph. Total compressed assets increased from 961.09 to 963.26 KiB because natural splitting adds small chunk overhead; this measured trade-off keeps 6.40 KiB off the critical boot path. The existing Lucide icon chunk remains because removing it increased both fragmentation and total asset size. The broader worktree still exceeds the 420/940 KiB guards, so those regressions remain visible rather than being hidden by a budget increase.

**2026-08-25: default Dashboard route and critical fonts preloaded at build time** — `[[apps/frontend/src/build-support/defaultRoutePreload.ts]]` walks the production chunk graph and injects only the Dashboard's static closure not already covered by the entry graph. The same build-bundle pass resolves the hashed Inter 400 and Fraunces 600 WOFF2 assets and emits font preloads with the deployment base. At that time, other weights and WOFF fallbacks remained CSS-discovered; the 2026-09-04 optimization above later removed every WOFF fallback. This removes serial route and critical-font discovery round trips on a cold web visit. Dynamic locale, AI chat, and motion-feature chunks stay lazy. Fresh root and `/vision/` production builds measured a 399.76 KiB gzip boot graph and 914.35/914.30 KiB gzip total JavaScript/CSS assets; the 420 KiB preload and 940 KiB total guards both pass. The latency benefit is primarily for remote web deployments; it is smaller on Electron or a local-area network.

**2026-05-29: recharts no longer eagerly preloaded** — Removed the `recharts → 'charts'` `manualChunks` rule from `[[apps/frontend/vite.config.ts]]`. Previously, forcing recharts into a named chunk caused Rollup to drag it (114 kB gzip) into the initial `modulepreload` graph via a shared module imported by `AppSettingsContext`. Recharts is used exclusively by `ToolResultCard.tsx`, which is only reachable through the lazy-loaded `AIChatPage`. Without the manual chunk rule, Rollup keeps recharts inside the `AIChatPage` async bundle and it no longer appears in `dist/index.html` as a `modulepreload`. Verified via production build. Remediates [[docs/reference/codebase-audit-2026-05#performance.5|performance.5]].

**2026-05-29: Yahoo Finance Batched Quote Fetch** — `PROVIDERS.yahoo` in [[apps/node-backend/src/services/prices/priceProviderRegistry.js]] now issues a single `yahooFinance.quote([symbols])` batch call for all Yahoo-backed investments instead of N per-symbol `Promise.all` calls. A ~30-holding portfolio drops from ~30 outbound HTTP requests to 1, reducing latency and Yahoo API pressure. The per-symbol chart-close fallback is retained for symbols unresolved by the batch and for whole-batch failure. See [[docs/integrations/price-providers#yahoo-finance|Yahoo Finance Provider]].

**2026-05-03: Offline-Aware Startup Optimization** — Backend now probes internet reachability at startup via new [[apps/node-backend/src/lib/network.js]] module (TCP to 1.1.1.1:443, 1.5s timeout, 30s cache). When offline is detected, skips all external data fetches (ECB rates, Yahoo quotes, Kinesis trendlines, historical backfills) that would each burn 5–15s on per-call timeouts. Result: `/health/detailed` ready status reached ~15 seconds sooner when offline; graceful degradation via cached/DB data. Scheduled hourly/12h refreshes also force-probe connectivity before fetching, avoiding unnecessary waits. See [[docs/architecture/backend-architecture#Network Reachability Module|Network Reachability Module]], [[docs/integrations/price-providers#Startup Behavior When Offline|Price Providers - Startup Offline]], [[docs/integrations/currency-conversion#Error Handling|Currency Conversion - Startup Offline]].

**2026-04-25: Frontend Component Memoization & Lazy-Loading (Phase 12)** — Statistics page: all 8 chart components (MonthlyChart, NetTrendChart, YearlyComparisonChart, TopRecipientsChart, CategoryPieChart, CategoryTrendChart, RecipientInsightsTab, SankeyTab, SavedChartsSection) now lazy-loaded via `React.lazy()` + `Suspense` per tab, reducing initial bundle size. All 6 chart components + SavedChartsSection wrapped with `React.memo()` to prevent re-renders when parent state changes. `chartCardProps` memoized with `useMemo()` to stabilize children props. DashboardSettingsDialog: all 6 tab components wrapped with `React.memo()`. Stable callbacks for `aiDefaultModel` and `adminMode` changes via `useCallback` + functional updater pattern (no dependency on `localAppSettings`) to prevent memoized children from re-rendering. Async file I/O on import service: replaced `fs.readFileSync` with `await fs.promises.readFile()` for consistency with adapter pattern. Backend: added `LIMIT 10000` guard on unbounded fallback query path in `infoRepo.statistics`. See [[docs/features/statistics|Statistics Feature]] and [[docs/components/statistics|Statistics Components]].

**2026-04-25: Parallelized Cache Warming & Forecast Accuracy Persistence (Phase 10)** — Refactored `warmInfoCaches()` in `[[apps/node-backend/src/routes/info.js|info.js]]` to run net-worth and portfolio-performance cache warmers in parallel via `Promise.allSettled()` instead of sequentially. Reduces startup overhead when both caches are pre-warmed. Additionally, replaced sequential `for await` loop in forecast accuracy persistence (`[[apps/node-backend/src/services/calculations/forecast/index.js|index.js]]` lines ~293-303) with `await Promise.all(backtest.map(...))` to persist per-method accuracy records in parallel. Extracted `parseIntClamped()` helper in `[[apps/node-backend/src/routes/aggregations.js|aggregations.js]]` to consolidate repeated parseInt-with-clamp validation logic across 4 query parameters (months, mc_paths, history_months, limit_months). See [[docs/reference/code-patterns#HTTP Request Parameter Parsing Pattern|HTTP Request Parameter Parsing Pattern]].

**2026-04-23: SSE Backpressure for Streaming Endpoints (Phase 3.2)** — New `[[apps/node-backend/src/lib/sse.js|sse.js]]` utility provides backpressure-aware streaming for `POST /api/import/csv/stream` and `POST /api/ai/chat/stream`. When a client consumes events slower than they are produced, the server's write buffer becomes full. Previously, the server would keep writing to an unbounded Node.js TCP buffer, eventually exhausting memory. Now, `createSseWriter()` and `drainIfNeeded()` pause the server loop whenever `res.writableNeedDrain` signals a full buffer, giving the kernel time to drain. Import and AI services now use async callbacks that await the SSE writer's `write()` promise, propagating backpressure all the way into the batch/token loop. See [[docs/reference/code-patterns#SSE Backpressure Pattern|SSE Backpressure Pattern]].

**2026-04-23: Adaptive Import Concurrency & Rate Limiter Cleanup** — Import concurrency (`RESOLVE_CONCURRENCY` and `IMPORT_BATCH_SIZE`) is now adaptive: `Math.max(2, Math.floor(poolMax / 2))` instead of hardcoded 20. Automatically scales with `DB_POOL_SIZE` and `DB_MAX_OVERFLOW` env vars (default: 5 with stock poolMax=10). Removed dead global API rate limiter code; explained why global limits don't fit single-user self-hosted model. See [[docs/security/rate-limiting|Rate Limiting]], [[docs/features/import|CSV Import]], and [[docs/reference/code-patterns#Import Batch Concurrency Pattern|Import Batch Concurrency Pattern]].

**2026-04-23: Phase 3.1 Batch FX Optimization** — Refactored monolithic 1445-line `infoRepository.js` into 7 domain modules with new `batchConvertGroupsWithHistoricalRateFallback()` helper that combines N row groups into 1 `convertRowsToEur()` call. Eliminated 4 redundant `exchange_rates` queries across info endpoints. `getCashflowComparison` (3 queries saved), `getBankBalances` (1 query saved). Converted related queries from sequential to parallel via `Promise.all()`. See [[docs/reference/repository-layer|Repository Layer Reference]].

**2026-04-20: Phase 0 Quick-Wins** — Frontend context memoization (AppSettings, Language), disabled React Query window-focus refetch, added explicit image dimensions for CLS prevention, database covering index on hot path (transactions), prepared-statement plan cache for frequent queries (`getBanks`, `getTransactionCount`, key transactionRepository methods), post-import materialized-view refresh, and async file I/O on Electron startup.

**2026-04-16: Performance Page Rewrite** — Moved all computations (metrics, heatmap, breakdown) from client to backend. Page now makes single API request instead of 4 sequential calls. Payload reduced 30-40x for filtered periods. See [[docs/adr/008-performance-page-server-computed-response|ADR-008]].

## Optimization Strategies

| Strategy                      | Documentation                                            | Impact               |
| ----------------------------- | -------------------------------------------------------- | -------------------- |
| **Server-Computed Responses** | [[docs/adr/008-performance-page-server-computed-response | ADR-008]]            | Pre-computed metrics on backend reduce client overhead |
| **In-Memory Caching**         | [[docs/performance/caching-strategies                    | Caching Strategies]] | Reduces API calls for exchange rates and prices        |
| **Materialized Views**        | [[docs/performance/materialized-views                    | Materialized Views]] | Pre-computed dashboard aggregations                    |
| **Chart Downsampling**        | [[docs/performance/chart-downsampling                    | Chart Downsampling]] | LTTB algorithm for large time-series data              |
| **Database Indexes**          | [[docs/adr/002-database-schema                           | Schema Indexes]]     | Optimized query performance                            |
| **Virtual Scrolling**         | [[docs/components/shared-components                      | VirtualDataTable]]   | Efficient rendering of large tables                    |

## Accepted Scale Boundaries

Some low-frequency paths deliberately preserve simpler or more complete
semantics until production measurements justify extra complexity:

- Statistics category/recipient/tag pivots remain all-time by default. A
  five-minute, inflight-deduplicated statistics cache absorbs repeat visits and
  is synchronously invalidated by transaction reconciliation/refresh and
  category or recipient mutation funnels; tag-only changes fall back to the
  five-minute time-to-live. A rolling default would silently hide older history,
  so revisit the cold-query shape only if a representative dataset shows p95
  above 500 ms, more than 50,000 intermediate aggregate rows, or more than 25
  MiB of process-memory growth per miss. Exact per-date foreign-exchange
  conversion remains binding.
- CategoryPivotTable retains the all-years default and browser auto-sized
  columns. Windowing its period columns would change widths and scroll geometry
  because body values participate in automatic table layout. Revisit with a
  user-visible fixed-width or latest-year design only if an instrumented
  supported dataset exceeds 5,000 mounted cells or a 100 ms React commit p95.
- Transaction sorts by memo, currency, effective recipient name, or effective
  category label retain their expression sort over the filtered result. A
  semantics-preserving stored-key or equivalent indexed redesign is deferred
  until sort-aware application telemetry or a representative PostgreSQL
  benchmark shows a 250 ms p95 for one of those sorts, or non-date ordering
  exceeds 5% of transaction-list calls. Date/id ordering remains the indexed
  default.
- The cold Electron splash starts loading immediately after settings, runtime
  selection, and localized strings are ready. Native application-menu, dock-menu,
  and accent subscription setup follows the splash request, so platform integration
  no longer delays the first app-controlled frame. The pre-change installed Demo
  trace recorded 20 ms for initialization, 90 ms for window creation, and about
  198 ms from main-process logger startup through splash-load completion. Electron
  framework initialization remains outside the app-owned timing marks.
- The frontend keeps Recharts behind a nested lazy boundary inside the already-lazy AI chat route,
  so only chart-shaped tool results download it. The critical Inter and Fraunces fonts are
  preloaded by the production build, legacy WOFF copies are not emitted, and
  runtime Zod validation plus the application-wide Belgian tax profile stay in
  the boot graph because they enforce shared contracts and settings. Revisit provider deferral if
  the existing boot-graph budget fails because of either retained dependency.
- The desktop package retains `archiver` for backup creation. Its former
  redundant direct transitive dependencies have already been removed; replacing
  the mature writer solely to reduce an ASAR index of roughly 2,100 files would
  trade backup compatibility for a measured low-single-digit-millisecond
  startup concern. Revisit if packaged `node_modules` exceeds 10,000 ASAR
  entries, ASAR-open profiling exceeds 25 ms p95, or those modules add more than
  25 MiB to the installed application.

## Cache Layers

Vision implements a multi-layer caching strategy:

1. **Browser Cache** - Static assets and API responses
2. **React Query Cache** - Client-side data caching
3. **In-Memory Cache** - Exchange rates and price feeds (backend)
4. **Materialized Views** - Pre-computed aggregations (PostgreSQL)
5. **Read-Through Cache** - Asset price history with DB fallback
6. **Performance Snapshots** - Daily portfolio performance cache

See [[docs/performance/caching-strategies|Caching Strategies]] for details.

## Related Documentation

- [[docs/adr/002-database-schema|Database Schema]] - Indexes and constraints
- [[docs/architecture/backend-architecture|Backend Architecture]] - Service layer design
- [[docs/features/portfolio|Portfolio Feature]] - Performance-sensitive features
