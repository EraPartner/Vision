---
title: Performance Documentation Index
type: performance-index
status: active
date: 2026-04-16
tags: [performance, index, optimization]
description: Performance optimization strategies including caching, materialized views, and chart downsampling
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