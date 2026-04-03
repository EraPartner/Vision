---
title: System Design Trade-offs Analysis
type: architecture-doc
status: active
date: 2026-04-02
tags: [system-design, trade-offs, architecture, decisions, analysis]
description: Analysis of key architectural trade-offs made in Vision, including alternatives considered and rationale for decisions
aliases: [trade-offs, design decisions, architecture analysis, alternatives]
related_code: ["apps/node-backend/src/", "apps/frontend/src/"]
---

# System Design Trade-offs Analysis

> [!abstract] Purpose
> This document analyzes the key architectural trade-offs made in Vision, documenting alternatives considered and the rationale behind each decision. Designed for **architects** reviewing design choices, **developers** understanding constraints, and **computer scientists** studying real-world engineering trade-offs.

---

## 1. Monorepo vs. Separate Repositories

**Decision:** Bun workspaces monorepo with `apps/frontend/` and `apps/node-backend/`

| Aspect | Monorepo (Chosen) | Separate Repos |
|--------|-------------------|----------------|
| Code sharing | Shared config, types | Duplication or npm packages |
| Atomic commits | Single commit for full-stack changes | Cross-repo coordination |
| Build coordination | Single `bun run dev` | Separate dev servers |
| CI/CD | Single pipeline | Multiple pipelines |
| Onboarding | One `git clone` | Multiple clones |
| Scale | Works well for 2 apps | Better for large teams |

**Trade-off:** Monorepo adds complexity for large teams but simplifies development for a single-developer project.

---

## 2. No External State Management Library

**Decision:** React Query + React Context only (no Redux, Zustand, Jotai)

| Aspect | React Query + Context (Chosen) | Redux/Zustand |
|--------|-------------------------------|---------------|
| Bundle size | Smaller (~15KB for React Query) | Larger (~20-30KB additional) |
| Learning curve | Lower (standard React patterns) | Higher (actions, reducers, stores) |
| Server state | Built-in caching, dedup, refetch | Manual implementation needed |
| Global state | Context for infrequent updates | Centralized store |
| Debugging | React DevTools sufficient | Redux DevTools needed |
| Boilerplate | Minimal | Significant (Redux) |

**Trade-off:** Context can cause unnecessary re-renders if not carefully structured. Mitigated by splitting contexts (7 separate contexts instead of one mega-context).

---

## 3. PostgreSQL Table Inheritance vs. JSONB

**Decision:** PostgreSQL table inheritance for investments (separate tables per asset class)

| Aspect | Table Inheritance (Chosen) | JSONB Columns | Single Table |
|--------|---------------------------|---------------|--------------|
| Type safety | Strong (each table has its own schema) | Weak (schema in application) | Strong but many NULLs |
| Query performance | Fast (smaller tables, targeted indexes) | Slower (JSONB operators) | Fast but wide table |
| Schema evolution | Add child table for new asset class | Flexible but unstructured | ALTER TABLE for new columns |
| ORM compatibility | Requires view layer | Native support | Native support |
| Storage efficiency | Optimal (no NULL columns) | Compact | Wasteful (many NULLs) |

**Trade-off:** Inheritance requires a compatibility view (`investments`) for application queries and INSTEAD OF triggers for writes. Adds complexity but provides optimal storage and query performance.

**See:** [[docs/adr/004-postgresql-table-inheritance|ADR-004]]

---

## 4. Materialized Views vs. Real-Time Aggregation

**Decision:** Materialized views for dashboard aggregations, refreshed on data changes

| Aspect | Materialized Views (Chosen) | Real-Time Queries | Redis Cache |
|--------|----------------------------|-------------------|-------------|
| Read performance | Instant (pre-computed) | Slow (aggregates on every request) | Fast (in-memory) |
| Data freshness | Eventually consistent (1s debounce) | Always current | Eventually consistent |
| Write overhead | Refresh on mutation | None | Invalidate on mutation |
| Complexity | CONCURRENTLY refresh + coalescing | Simple queries | External dependency |
| Storage | Database storage | No extra storage | Redis memory |

**Trade-off:** Dashboard data can be up to 1 second stale after a transaction change. Acceptable for a personal finance app where real-time precision isn't critical.

**See:** [[docs/adr/005-materialized-views|ADR-005]]

---

## 5. Server-Side Rendering vs. Client-Side Rendering

**Decision:** Client-side rendering (Vite SPA) with Electron shell

| Aspect | CSR + Electron (Chosen) | SSR (Next.js) |
|--------|------------------------|---------------|
| Initial load | Fast (local file) | Fast (pre-rendered) |
| SEO | Not needed (desktop app) | Excellent |
| Complexity | Simple Vite config | Next.js framework |
| Offline support | Full (Electron + local DB) | Partial |
| Interactivity | Immediate | Hydration needed |

**Trade-off:** No SEO benefit needed since this is a desktop application. CSR is simpler and provides immediate interactivity.

---

## 6. Express vs. Fastify/Hono

**Decision:** Express.js for the backend API

| Aspect | Express (Chosen) | Fastify | Hono |
|--------|-----------------|---------|------|
| Ecosystem | Largest (middleware, plugins) | Growing | Smaller |
| Performance | Good | Excellent | Excellent |
| Learning curve | Lowest | Moderate | Moderate |
| Maturity | Most mature | Mature | Newer |
| TypeScript | Community support | Native | Native |

**Trade-off:** Express is slower than Fastify/Hono but has the largest ecosystem and lowest learning curve. Performance is not a bottleneck for a single-user desktop app.

---

## 7. Bun vs. Node.js Runtime

**Decision:** Bun as the runtime and package manager

| Aspect | Bun (Chosen) | Node.js + npm |
|--------|-------------|---------------|
| Speed | Faster startup, faster installs | Slower |
| Compatibility | Near-complete Node.js compatibility | Complete |
| Package management | Built-in | npm/pnpm/yarn needed |
| Ecosystem | Growing | Mature |
| Tooling | Built-in test runner, bundler | External tools needed |

**Trade-off:** Bun is newer and may have edge-case compatibility issues. Mitigated by using well-tested npm packages and thorough testing.

---

## 8. Streaming Imports vs. Batch Imports

**Decision:** Both — standard batch import and streaming import with SSE

| Aspect | Batch Import | Streaming Import (SSE) |
|--------|-------------|----------------------|
| User feedback | Wait until complete | Real-time progress |
| Implementation | Simple | Complex (SSE protocol) |
| Large file handling | Blocks until done | Non-blocking, resumable |
| Memory usage | Loads entire file | Streaming line-by-line |

**Trade-off:** Streaming adds complexity (SSE protocol, progress callbacks, abort handling) but provides better UX for large imports. Standard batch import kept for simplicity.

**See:** [[docs/adr/007-streaming-imports|ADR-007]]

---

## 9. No Authentication Layer

**Decision:** No authentication — single-user desktop app

| Aspect | No Auth (Chosen) | With Auth |
|--------|-----------------|-----------|
| Complexity | Minimal | Significant |
| Security | Desktop isolation | Network exposure |
| Multi-user | Not supported | Supported |
| Deployment | Local-first | Cloud-ready |

**Trade-off:** Limits the app to single-user local deployment. Adding auth later would require significant refactoring (tenant isolation, session management, token validation).

**Scaling path:** Add workspace isolation via `tenant_id` column, JWT authentication, and role-based access control.

---

## 10. Hardcoded Fallback Rates vs. External API Only

**Decision:** Multi-source rates with hardcoded fallback (~40 currencies)

| Aspect | Multi-Source + Fallback (Chosen) | External API Only |
|--------|--------------------------------|-------------------|
| Reliability | High (fallback always available) | Dependent on API uptime |
| Accuracy | Good (hardcoded rates may be stale) | Always current |
| Offline support | Partial (fallback rates) | None |
| Complexity | Moderate (merge logic) | Simple |

**Trade-off:** Hardcoded rates may be stale but ensure the app works even when all external APIs are down. The `warmCache()` function refreshes rates on startup.

---

## 11. LTTB Downsampling vs. Other Algorithms

**Decision:** LTTB (Largest-Triangle-Three-Buckets) for chart downsampling

| Algorithm | Visual Fidelity | Performance | Complexity |
|-----------|----------------|-------------|------------|
| **LTTB (Chosen)** | Excellent | O(n) | Moderate |
| Min-Max | Good | O(n) | Simple |
| Random sampling | Poor | O(n) | Simple |
| Every Nth point | Poor | O(n) | Simple |
| Douglas-Peucker | Excellent | O(n log n) | Complex |

**Trade-off:** LTTB provides the best balance of visual fidelity and performance. Douglas-Peucker produces slightly better results but is more complex and slower.

**See:** [[docs/reference/algorithms|Algorithms Reference]]

---

## 12. SHA-256 Hash vs. Field-Based Deduplication

**Decision:** Both — SHA-256 for imported transactions, field-based for manual

| Aspect | SHA-256 Hash | Field-Based |
|--------|-------------|-------------|
| Collision resistance | Extremely high | Moderate |
| Speed | Fast (crypto module) | Fast (SQL comparison) |
| Storage | Stores hash string | No extra storage |
| Flexibility | Fixed hash input | Adjustable field matching |

**Trade-off:** SHA-256 provides strong deduplication guarantees for imported data. Field-based matching is more flexible for manual transactions where the exact input format may vary.

---

## Summary of Trade-off Philosophy

Vision's design philosophy prioritizes:

1. **Simplicity over sophistication** — Choose the simplest solution that works
2. **Local-first over cloud-first** — Desktop app with local database
3. **Developer experience over marginal performance** — Express over Fastify, no auth
4. **Graceful degradation** — Fallback chains for all external dependencies
5. **Eventual consistency over strong consistency** — Materialized views, debounced saves
6. **Single-user optimization** — No multi-user complexity until needed

---

## Related Documentation

- [[docs/adr/index|Architecture Decision Records]]
- [[docs/architecture/deep-dive|Architecture Deep Dive]]
- [[docs/reference/database-query-patterns|Database Query Patterns]]
- [[docs/reference/algorithms|Algorithms Reference]]
