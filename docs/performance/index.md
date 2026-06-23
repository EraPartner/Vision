---
title: Performance Documentation Index
type: performance-index
status: active
date: 2026-04-25
last_modified: 2026-05-29
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

| Strategy | Documentation | Impact |
|----------|---------------|--------|
| **Server-Computed Responses** | [[docs/adr/008-performance-page-server-computed-response|ADR-008]] | Pre-computed metrics on backend reduce client overhead |
| **In-Memory Caching** | [[docs/performance/caching-strategies|Caching Strategies]] | Reduces API calls for exchange rates and prices |
| **Materialized Views** | [[docs/performance/materialized-views|Materialized Views]] | Pre-computed dashboard aggregations |
| **Chart Downsampling** | [[docs/performance/chart-downsampling|Chart Downsampling]] | LTTB algorithm for large time-series data |
| **Database Indexes** | [[docs/adr/002-database-schema|Schema Indexes]] | Optimized query performance |
| **Virtual Scrolling** | [[docs/components/shared-components|VirtualDataTable]] | Efficient rendering of large tables |

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