---
title: ADR 006 - Three-Layer Backend Architecture
type: adr
status: Accepted
date: 2026-04-02
tags: [architecture, backend, design-patterns, layers]
description: Decision to use a three-layer architecture (routes → services → repositories) for the Node.js backend
aliases: [three-layer, layered architecture, routes services repositories]
related_code: ["apps/node-backend/src/routes/", "apps/node-backend/src/services/", "apps/node-backend/src/repositories/"]
---

# ADR-006: Three-Layer Backend Architecture

## Status
Accepted

## Date
2026-03-17

## Context

The backend needs a clear separation of concerns to maintain code quality as the application grows. Options considered:

1. **MVC** (Model-View-Controller) — traditional web pattern
2. **Clean Architecture** — strict dependency inversion
3. **Three-Layer** (Routes → Services → Repositories) — pragmatic middle ground

## Decision

Use a **three-layer architecture**:

```
┌─────────────────────────────────────────┐
│ Routes (Express)                        │
│ - HTTP request/response handling        │
│ - Input validation                      │
│ - Rate limiting                         │
│ - Error formatting                      │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│ Services (Business Logic)               │
│ - Domain logic                          │
│ - External API calls                    │
│ - Data transformation                   │
│ - Cross-cutting concerns                │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│ Repositories (Data Access)              │
│ - SQL queries                           │
│ - CRUD operations                       │
│ - Parameterized queries                 │
│ - No business logic                     │
└─────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Directory | Responsibility |
|-------|-----------|----------------|
| **Routes** | `routes/` | HTTP concerns, validation, error handling |
| **Services** | `services/` | Business logic, external integrations |
| **Repositories** | `repositories/` | Data access, SQL queries |

### Key Rules

1. **Routes never call repositories directly** — must go through services
2. **Services may call multiple repositories** — orchestration layer
3. **Repositories contain no business logic** — pure data access
4. **No circular dependencies** — strict top-down flow

## Consequences

### Positive
- **Clear separation** — each layer has a single responsibility
- **Testability** — each layer can be tested independently
- **Maintainability** — easy to locate and modify code
- **Scalability** — new features follow established patterns

### Negative
- **Boilerplate** — more files than a simpler architecture
- **Service layer overhead** — some services are thin wrappers
- **Learning curve** — new developers must understand the pattern

## Related

- [[docs/reference/code-patterns]] — Code patterns reference
- [[docs/architecture/backend-architecture]] — Backend architecture diagrams
- [[docs/guides/how-to-add-api-endpoint]] — How to add endpoints
