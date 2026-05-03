---
title: Architecture Diagrams
type: architecture-index
status: active
date: 2026-04-27
tags: [architecture, index, uml, plantuml, diagrams, phase-1, phase-2, phase-3, phase-e, frontend, api-client, openapi, domain-split, repository-split, statistics-refactoring, component-decomposition, refactoring, bug-fixes, csv, formula-injection, parallelization, deployment, container-hardening, backup, restore, bundle, electron]
description: Index of all UML diagrams for the Vision project - backend, frontend, system, and sequence diagrams; includes Phase 1+2 backup bundle format and IPC handlers, Phase 2 API client domain split, OpenAPI architecture, April 2026 Statistics page refactoring, Phase E component decomposition, April 25 CSV security & parallelization improvements, and container hardening
aliases: [architecture, diagrams, UML, system design, backup architecture, electron IPC]
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

## Frontend Component Decomposition (Phase E)

ImportPage component refactored from monolithic 1019 lines to modular architecture:

**Structure:**
- `apps/frontend/src/pages/ImportPage.tsx` (35 lines) — Thin orchestrator
- `apps/frontend/src/features/imports/` (6 components + 1 hook, ~914 lines):
  - `TransactionImportCard.tsx` (394 lines) — CSV import, SSE progress, column mapper, exports
  - `RecipientsImportCard.tsx` (155 lines) — Bulk recipients import
  - `CategoriesImportCard.tsx` (140 lines) — Categories import
  - `ExportCard.tsx` (159 lines) — CSV/JSON export UI
  - `SupportedBanksCard.tsx` (38 lines) — Read-only banks chip list
  - `useAdapters.ts` (28 lines) — Shared hook prevents duplicate API calls

**Benefits:**
- High cohesion: each component has single responsibility
- Low coupling: no prop-drilling; state stays with owner
- Testability: each card independently testable

## Backend Refactoring & Bug Fixes (April 25, 2026)

### CSV Export Security & Utility Consolidation

**Issue:** CSV exports in different routes had inconsistent or missing formula injection protection.

**Resolution:**
- New shared utility: [[apps/node-backend/src/lib/csv.js|csv.js]] with `escapeCsvValue()` and `neutralizeCsvFormula()`
- Centralizes CWE-1236 protection: prefixes dangerous leading chars (`=`, `+`, `-`, `@`) with `'`
- Updated routes: `transactions.js` (GET `/api/transactions/export/csv`) and `splits.js` (GET `/api/splits/owed/:id/export/csv`)
- All exports now use the shared utility, eliminating duplication and ensuring consistent security

Documentation:
- [[docs/reference/code-patterns#safe-csv-export-pattern-phase-5|Safe CSV Export Pattern]]
- [[docs/security/input-validation#csv-formula-injection-prevention-cwe-1236|CSV Formula Injection Prevention]]

### Query Parallelization & Performance

**Changes:**
- `transactions.js` (PATCH): Recipient/category resolution now uses `Promise.all` instead of sequential awaits
- `splits.js`: Batch audit-trail writes parallelized via `Promise.all`
### Bug Fixes

**admin.js:** Fixed VACUUM error handler returning 500 instead of 403
- Error: `throw new AppError(msg, 403)` was dropping the status code because `AppError` constructor expects `(msg, opts)` shape
- Fix: Changed to `throw new ForbiddenError(msg)` for proper 403 response

### Response Envelope Harmonization

Documentation:
- [[docs/adr/026-unified-api-response-envelope|ADR-026: Unified API Response Envelope]]

## Electron Desktop Backup Architecture (Phase 1+2)

**Bundle Format:** New `.visionbak` format replaces legacy `.sql` backups:

```
vision_backup_{deviceId}_{timestamp}.visionbak  ← .zip archive
├── metadata.json        # schema version, checksums, timestamps
├── db.sql               # pg_dump output
├── attachments/         # mirrors $ATTACHMENTS_DIR/
└── frontend-state.json  # localStorage snapshot (theme, preferences)
```

**Optional Encryption:** AES-256-CBC per-bundle encryption with pbkdf2 key derivation → `.visionbak.enc`

**IPC Handlers (8 total):** New handlers in `packaging/electron/main.js`:
- `backup:run` — Create bundle with optional encryption
- `backup:restore` — Restore bundle; schema-checks, drops DB, swaps attachments, hydrates localStorage
- `backup:select-file` / `backup:select-dir` — Native file/folder dialogs
- `backup:save-settings` / `backup:load-settings` — Persist backup config
- `backup:get-encryption-status` / `backup:set-passphrase` — Manage encryption

**Schema Safety:** On restore, compares bundle schema against current schema. If bundle is newer, blocks restore with `BUNDLE_SCHEMA_NEWER` error (user must upgrade Vision first).

**Frontend Integration:**
- `apps/frontend/src/lib/api/electron.ts` — TypeScript wrapper types and functions
- `apps/frontend/src/components/settings/tabs/BackupTab.tsx` — UI for backup/restore, passphrase management, error handling

**Coverage:** All 31 user-data tables + attachments + localStorage keys. CI test enforces coverage on every migration.

Documentation:
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]] — Coverage matrix, bundle format, restore process
- [[docs/architecture/electron|Electron Architecture]] — IPC handlers, security model
- [[docs/reference/api-endpoint-matrix#ipc-handlers--electron-desktop-phase-12|API Endpoint Matrix — IPC Section]]

## Frontend Design System (Phase 9) & CSS Architecture (Tailwind v4, May 2026)

The frontend implements a premium liquid-glass aesthetic with:

- **Color Palette**: Emerald + champagne-gold with deep charcoal base
- **Typography**: Fraunces (display, serif) + Inter (body, geometric sans-serif) — static weights (400/500/600) via `@fontsource`
- **Material System**: Five-tier glass hierarchy + premium surface utilities
- **Motion**: Framer Motion with centralized motion system + reduced-motion compliance
- **Charts**: visx + d3 primitives (primary); Recharts 3.8.1 (retained for compatibility, inactive)
- **CSS Architecture**: Tailwind CSS v4 (4.2.4) with unified `@tailwindcss/postcss` plugin

**Tailwind v4 Updates (May 2026):**
- **PostCSS Config** — Simplified to `{ '@tailwindcss/postcss': {}, autoprefixer: {} }`
- **CSS Entry Point** — Uses `@import "tailwindcss"` + `@config` directives (replaces v3's `@tailwind base/components/utilities`)
- **@apply Restrictions** — Custom `.glass*` aliases now declare full CSS rules; v4 restricts @apply to registered utilities only
- **Font Optimization** — Static weights replace variable fonts for reduced payload

Documentation:
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/018-visx-d3-chart-migration|ADR-018: visx/d3 Migration]]
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]]
- [[docs/adr/047-tailwind-v4-migration-dependency-upgrades|ADR-047: Tailwind v4 Migration & Dependency Upgrades]] (NEW)
- [[docs/architecture/frontend-architecture#css-architecture-tailwind-v4-may-2026|Frontend Architecture — CSS Architecture]]
- [[docs/reference/code-patterns#motion-consumer-pattern-phase-9|Motion Consumer Pattern]]
- [[docs/reference/code-patterns#surface-shell-pattern-phase-9|Surface Shell Pattern]]

## Technology Stack

- **UML Tool**: PlantUML
- **Rendering**: Obsidian with PlantUML plugin
- **Hosting**: Git (version controlled diagrams)
