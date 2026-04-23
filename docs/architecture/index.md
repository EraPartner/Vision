---
title: Architecture Diagrams
type: architecture-index
status: active
date: 2026-04-23
tags: [architecture, index, uml, plantuml, diagrams, phase-2, phase-3, frontend, api-client, openapi, domain-split, repository-split, statistics-refactoring]
description: Index of all UML diagrams for the Vision project - backend, frontend, system, and sequence diagrams; includes Phase 2 API client domain split, OpenAPI architecture, and April 2026 Statistics page refactoring
aliases: [architecture, diagrams, UML, system design]
---

# Architecture Diagrams

> [!abstract] Overview
> Complete collection of UML diagrams for the Vision project, generated from source code and maintained alongside it. All diagrams use PlantUML and render in Obsidian.

## Overview

The diagrams are organized into categories:

- [Backend Diagrams](#backend-diagrams)
- [Backend Flow Diagrams](#backend-flow-diagrams)
- [Frontend Diagrams](#frontend-diagrams)
- [System-Wide Diagrams](#system-wide-diagrams)
- [Sequence & State Diagrams](#sequence--state-diagrams)

## Backend Diagrams

Located in `docs/diagrams/`:

| Diagram | Description | File |
|---------|-------------|------|
| Domain Model | Core entities (Transaction, Recipient, Category, etc.) | `backend-domain-model.puml` |
| Repository Layer | Data access repositories | `backend-repository-layer.puml` |
| Service Layer | Business logic services | `backend-service-layer.puml` |
| API Layer | Express routes and middleware | `backend-api-layer.puml` |
| Database Schema | Full ERD with all tables | `backend-database-schema.puml` |

## Backend Flow Diagrams

| Diagram | Description | File |
|---------|-------------|------|
| Import Pipeline | CSV import with bank adapters and deduplication | `import-pipeline.puml` |
| Import Sequence | Detailed import sequence diagram | `import-sequence.puml` |
| Currency Conversion | Exchange rate fetching and caching | `currency-conversion-flow.puml` |
| Price Provider | Investment price updates from external APIs | `price-provider-flow.puml` |
| Recurring Detection | Automatic recurring transaction detection | `recurring-detection-flow.puml` |
| Materialized Views | View refresh on startup and schedules | `materialized-view-flow.puml` |

## Frontend Diagrams

| Diagram | Description | File |
|---------|-------------|------|
| Component Structure | UI components and feature modules | `frontend-component-structure.puml` |
| State Management | React Context + React Query | `frontend-state-management.puml` |
| Data Flow | API client and type system | `frontend-data-flow.puml` |
| Pages & Routes | React Router structure | `frontend-pages-routes.puml` |
| Transaction Creation | Sequence flow for creating transactions | `transaction-creation-sequence.puml` |
| Transaction State | Transaction lifecycle states | `transaction-state.puml` |

## System-Wide Diagrams

| Diagram | Description | File |
|---------|-------------|------|
| API Communication | Frontend ↔ Backend request flow | `api-communication.puml` |
| System Architecture | Complete system overview | `system-architecture.puml` |
| Deployment Architecture | Docker, production, desktop | `deployment-architecture.puml` |
| Use Case | User interactions overview | `use-case-diagram.puml` |

## Sequence & State Diagrams

| Diagram | Description | File |
|---------|-------------|------|
| Import Sequence | Detailed CSV import flow | `import-sequence.puml` |
| Recipient Merge | Recipient merge/unmerge workflow | `recipient-merge-sequence.puml` |
| Transaction Creation | Transaction creation sequence | `transaction-creation-sequence.puml` |
| PlannedTransaction State | PlannedTransaction lifecycle | `planned-transaction-state.puml` |
| Transaction State | Transaction lifecycle states | `transaction-state.puml` |

## Architecture Documentation

Detailed architectural analysis:

- [[docs/architecture/backend-architecture|Backend Architecture]] - Backend-specific diagrams
- [[docs/architecture/frontend-architecture|Frontend Architecture]] - Frontend-specific diagrams
- [[docs/architecture/deep-dive|Architecture Deep Dive]] - Design patterns, data flow, system organization
- [[docs/architecture/electron|Electron Desktop Architecture]] - Electron packaging, IPC, security
- [[docs/architecture/trade-offs|System Design Trade-offs]] - Analysis of key architectural trade-offs and alternatives

## Regenerating Diagrams

To regenerate diagrams after code changes:

1. Review the relevant source files
2. Update the PlantUML source in the `.puml` file
3. The diagrams in the markdown files will render automatically

## Adding New Diagrams

To add a new diagram:

1. Create a `.puml` file in `docs/diagrams/`
2. Add the PlantUML code to the appropriate documentation file
3. Update this index

## Frontend Architecture Updates (Phase 2)

### API Client Domain Split (Phase 2.2)

The monolithic `apps/frontend/src/lib/api.ts` (1553 lines) was split into 13 domain modules for better maintainability:

| Module | Responsibility |
|--------|-----------------|
| `transactions.ts` | Transaction CRUD operations |
| `categories.ts` | Category management |
| `recipients.ts` | Recipient CRUD + merge/unmerge |
| `planned.ts` | Planned transaction operations |
| `investments.ts` | Portfolio & investment management |
| `imports.ts` | CSV import pipeline |
| `settings.ts` | Application settings |
| `aggregations.ts` | Data aggregation queries |
| `charts.ts` | Saved chart operations |
| `market.ts` | Market data lookup |
| `ai.ts` | AI chat functionality |
| `portfolio.ts` | Portfolio transactions |
| `info.ts` | Statistics & net worth |
| `api.ts` | Barrel re-export (backward compat) |

All modules share `client.ts` (transport layer) and `types.ts` (envelope + error types).

Documentation:
- [[docs/reference/frontend-api-client|Frontend API Client Architecture]]
- [[docs/reference/code-patterns#api-client-pattern|API Client Pattern]]

### OpenAPI Type Generation (Phase 2.4)

Added `openapi.yaml` (hand-written OpenAPI 3.0.3 spec) and `openapi-typescript` codegen:

```bash
# Generates apps/frontend/src/types/generated.ts
bun run generate:types
```

Benefits:
- Single source of truth for API contract
- Auto-generated TypeScript types (never manually edited)
- Type safety: breaking changes caught at compile time
- IDE autocomplete for all endpoints

Documentation:
- [[docs/adr/031-openapi-type-generation-frontend|ADR-031: OpenAPI Type Generation]]
- `openapi.yaml` — Authoritative API spec

### Decimal & Timezone Utilities (Phase 2.1 & 2.3)

New safe utilities for monetary and date operations:

**Decimal (Phase 2.1):**
- `apps/frontend/src/lib/decimal.ts` — `parseDecimal()` for form input parsing
- Replaced 46+ `parseFloat()` calls on monetary values

**Timezone (Phase 2.3):**
- `apps/frontend/src/lib/timezone.ts` — `parseYmd()`, `todayYmd()`, `daysBetween()`
- Fixed YYYY-MM-DD string parsing (no more UTC midnight shift)

Documentation:
- [[docs/reference/code-patterns#decimal-pattern-frontend-phase-22|Decimal Pattern]]
- [[docs/reference/code-patterns#timezone-safe-date-utilities-frontend-phase-23|Timezone Pattern]]

## Backend Repository Layer (Phase 3.1)

The backend repository layer completed a major refactoring in Phase 3.1:

- **Monolith Split**: Original 1445-line `infoRepository.js` refactored into 7 domain-specific sub-modules (`statisticsRepository`, `monthlyRepository`, `banksRepository`, `netWorthRepository`, `plannedRepository`, `recipientInsightsRepository`) plus shared helpers
- **Batch FX Optimization**: New `batchConvertGroupsWithHistoricalRateFallback()` helper combines N row groups into 1 `convertRowsToEur()` database query, eliminating 4 redundant exchange_rates lookups
- **Parallel Query Execution**: Sequential queries converted to `Promise.all()` for independent operations
- **Shared Utilities**: Helpers consolidate duplicated patterns (date formatting, rounding, category merging, row mapping)

Documentation:
- [[docs/reference/repository-layer|Repository Layer Reference]] - Complete reference with dependency map
- [[docs/performance/index|Performance Index]] - Phase 3.1 batch FX optimization details

## Frontend Design System (Phase 9)

The frontend implements a premium liquid-glass aesthetic with:

- **Color Palette**: Emerald + champagne-gold with deep charcoal base
- **Typography**: Fraunces (display, serif) + Inter Tight (body, geometric sans-serif)
- **Material System**: Five-tier glass hierarchy + premium surface utilities
- **Motion**: Framer Motion with centralized motion system + reduced-motion compliance
- **Charts**: visx + d3 primitives replacing Recharts

Documentation:
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/018-visx-d3-chart-migration|ADR-018: visx/d3 Migration]]
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]]
- [[docs/reference/code-patterns#motion-consumer-pattern-phase-9|Motion Consumer Pattern]]
- [[docs/reference/code-patterns#surface-shell-pattern-phase-9|Surface Shell Pattern]]

## Technology Stack

- **UML Tool**: PlantUML
- **Rendering**: Obsidian with PlantUML plugin
- **Hosting**: Git (version controlled diagrams)
