---
title: Architecture Deep Dive
type: architecture-doc
status: active
date: 2026-04-02
tags: [architecture, design-patterns, system-design, deep-dive]
description: Comprehensive architectural analysis of Vision's design patterns, data flow, and system organization
aliases: [architecture deep dive, system design, design patterns, architectural patterns]
---

# Architecture Deep Dive

> [!abstract] Purpose
> This document provides a comprehensive architectural analysis of Vision, covering design patterns, data flow, system organization, and the rationale behind key architectural decisions. Designed for **computer scientists**, **senior developers**, and **architects**.

---

## System Topology

```
┌─────────────────────────────────────────────────────────────┐
│                        Electron Shell                        │
│  ┌──────────────────────┐    ┌───────────────────────────┐  │
│  │   Chromium Renderer   │    │   Node.js Backend          │  │
│  │   (React 18 + Vite)   │◄──►│   (Express + Bun)          │  │
│  │                      │ IPC│                            │  │
│  │  ┌────────────────┐  │    │  ┌──────────────────────┐  │  │
│  │  │ React Contexts │  │    │  │  Routes (Express)    │  │  │
│  │  │ React Query    │  │    │  │  Services (Business) │  │  │
│  │  │ Components     │  │    │  │  Repositories (Data) │  │  │
│  │  └────────────────┘  │    │  └──────────┬───────────┘  │  │
│  └──────────────────────┘    └─────────────┼──────────────┘  │
└────────────────────────────────────────────┼─────────────────┘
                                             │
                                    ┌────────▼────────┐
                                    │   PostgreSQL     │
                                    │   (Local/Remote) │
                                    └─────────────────┘
```

---

## Design Patterns

### 1. Repository Pattern (Backend)

**Purpose:** Abstract data access behind a consistent interface.

```
Repository Interface:
├── getAll({ limit, offset, filters })
├── getCount({ filters })
├── getById(id)
├── create(data)
├── update(id, fields)
└── hardDelete(id)
```

**Benefits:**
- Decouples business logic from SQL
- Enables easy mocking in tests
- Consistent API across all entities

**Implementation:** [[apps/node-backend/src/repositories/]]

### 2. Strategy Pattern (Bank Adapters)

**Purpose:** Pluggable CSV parsing strategies per bank.

```
Bank Adapter Interface:
├── parse(csvContent) → RawTransaction[]
├── detectFormat(firstLine) → boolean
└── normalize(raw) → NormalizedTransaction
```

**Implementations:**
- BelfiusAdapter
- RevolutAdapter
- KBCAdapter
- SABBAdapter
- WiseAdapter
- VisionAdapter

**Implementation:** [[apps/node-backend/src/services/bankAdapters.js]]

### 3. Chain of Responsibility (Price Providers)

**Purpose:** Sequential price resolution with fallback.

```
Price Resolution Chain:
1. In-memory cache (latest)
2. asset_price_history (persisted)
3. Live provider API call
4. Cached current_price (fallback)
```

**Implementation:** [[apps/node-backend/src/services/priceProviderService.js]]

### 4. Observer Pattern (React Query)

**Purpose:** Automatic cache invalidation and UI updates.

```
Mutation onSuccess → invalidateQueries → refetch → UI update
```

**Implementation:** All `use*` hooks in [[apps/frontend/src/hooks/]]

### 5. Facade Pattern (API Client)

**Purpose:** Unified interface for all backend HTTP calls.

```
apiClient.getTransactions(params)
apiClient.createTransaction(data)
apiClient.refreshPrices()
```

**Implementation:** [[apps/frontend/src/lib/api.ts]]

### 6. Template Method (Import Pipeline)

**Purpose:** Standardized import process with customizable steps.

```
Import Pipeline:
1. Read CSV (fixed)
2. Detect bank (strategy)
3. Parse rows (strategy)
4. Normalize text (fixed)
5. Deduplicate (fixed)
6. Create transactions (fixed)
```

**Implementation:** [[apps/node-backend/src/services/importService.js]]

---

## Data Flow Analysis

### Request Lifecycle

```
User Action
    │
    ▼
┌─────────────────┐
│ React Component │
│   (onClick)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌──────────────────┐
│     Hook        │────▶│  React Query     │
│ useCreateThing()│     │  (cache layer)   │
└────────┬────────┘     └────────┬─────────┘
         │                       │
         ▼                       ▼
┌─────────────────────────────────────┐
│         apiClient                   │
│  (HTTP request with retry logic)    │
└────────────────┬────────────────────┘
                 │ HTTP POST/GET/PATCH
                 ▼
┌─────────────────────────────────────┐
│         Express Route               │
│  (validation, rate limiting)        │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│         Service                     │
│  (business logic, orchestration)    │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│         Repository                  │
│  (parameterized SQL query)          │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│         PostgreSQL                  │
│  (query execution, index scan)      │
└─────────────────────────────────────┘
```

### State Management Layers

| Layer | Technology | Scope | Lifetime |
|-------|-----------|-------|----------|
| **Server State** | React Query | API data | Configurable stale time |
| **Global State** | React Context | App settings, theme, language | App lifetime |
| **Local State** | useState/useReducer | Component-specific | Component lifetime |
| **URL State** | React Router | Page params, filters | Navigation lifetime |

---

## Dependency Graph

```
Frontend Dependencies:
├── React 18 (UI framework)
├── TypeScript (type safety)
├── Vite (build tool)
├── Tailwind CSS (styling)
├── Radix UI (accessible primitives)
├── React Router (navigation)
├── React Query (server state)
├── Recharts (charting)
└── Sonner (notifications)

Backend Dependencies:
├── Express (HTTP server)
├── pg (PostgreSQL client)
├── Bun (runtime/package manager)
├── yahoo-finance2 (market data)
├── binance-api (crypto data)
├── compression (response compression)
└── express-rate-limit (rate limiting)

Shared:
├── Zod (validation — frontend)
└── Alembic (migrations)
```

---

## Scalability Considerations

### Current Design (Single-User Desktop)

- **Database:** Single PostgreSQL instance (local or remote)
- **Backend:** Single Node.js process
- **Frontend:** Single Chromium instance
- **Concurrency:** Event loop (Node.js) + async I/O

### Scaling Paths

1. **Multi-user:** Add authentication layer, workspace isolation via tenant_id
2. **Horizontal:** Stateless backend behind load balancer, shared PostgreSQL
3. **Caching:** Redis for cross-instance cache sharing
4. **CDN:** Static assets served from CDN for web deployment

### Bottleneck Analysis

| Component | Current Bottleneck | Scaling Solution |
|-----------|-------------------|------------------|
| PostgreSQL | Connection pool size | PgBouncer connection pooling |
| Backend | Single event loop | Worker threads or clustering |
| Frontend | Large dataset rendering | Virtual scrolling (already implemented) |
| Import | CSV parsing speed | Streaming (already implemented) |

---

## Error Handling Strategy

### Backend Error Hierarchy

```
Error
├── ValidationError (400)
│   └── MissingFieldError
│   └── InvalidFormatError
├── NotFoundError (404)
├── ConflictError (409)
├── RateLimitError (429)
└── InternalError (500)
```

### Frontend Error Boundaries

```
App
├── ErrorBoundary (catches render errors)
├── QueryErrorBoundary (catches data fetch errors)
└── Per-component error states
```

---

## Security Architecture

### Defense in Depth

1. **Input validation** — Zod schemas on frontend, middleware validation on backend
2. **Parameterized queries** — All SQL uses `$1, $2` parameters
3. **Rate limiting** — Global + per-route rate limiters
4. **CSP headers** — Content-Security-Policy for Electron renderer
5. **Sandbox** — Electron context isolation

### Data Protection

- No PII transmitted over network (local-only by default)
- Database credentials in environment variables only
- No secrets in source code

---

## Related

- [[docs/architecture/index]] — Architecture diagrams
- [[docs/adr/index]] — Architecture Decision Records
- [[docs/reference/code-patterns]] — Code patterns
- [[docs/security/index]] — Security documentation
