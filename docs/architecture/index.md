---
title: Architecture Diagrams
type: architecture-index
status: active
date: 2026-04-27
updated: 2026-08-26
tags: [architecture, index, uml, plantuml, diagrams, phase-1, phase-2, phase-3, phase-e, frontend, api-client, openapi, domain-split, repository-split, statistics-refactoring, component-decomposition, refactoring, bug-fixes, csv, formula-injection, parallelization, deployment, container-hardening, backup, restore, bundle, electron, tags, tagging, orthogonal-dimension, may-2026, june-2026, route-service-boundary, thin-seams, global-rate-limiter, shared-utils, mv-recipient-monthly-drop, skin-v2, dense-fintech, css-scoping, inline-token-constraint, feature-flag, apple-refined, jewel-emerald, glass-differentiation, refined-geometry, hairlines, motion-spring]
description: Index of all UML diagrams for the Vision project - backend, frontend, system, and sequence diagrams. June 2026 updates: ADR-105 Apple-refined visual pass baked into base design (--radius 0.625rem; Card rounded-[0.75rem]; differentiated glass-regular/glass-elevated shadows; jewel emerald primary 164 78% 26% light / 160 74% 52% dark; ease-out-quint/expo → cubic-bezier(0.32,0.72,0,1); press-feedback:active scale 0.97; tabular-nums letter-spacing -0.006em; 0.5px hairlines on hi-dpi; aurora/glass/hover retained). VITE_SKIN_V2 (ADR-104) now gates only colorblind-safe gain/loss recoloring; flatten direction abandoned. backend-service-layer.puml adds 14 thin route-seam services (ADR-067); backend-api-layer.puml adds globalRateLimiter on /api + TRUSTED_PROXIES XFF handling + VISION_DEV dev-bypass flag.
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
| Domain Model | Core entities (Transaction, Recipient, Category, Tag, etc.) with relationships | `backend-domain-model.puml` |
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
| AI Chat Tool Loop | Ollama tool-call loop with repository dispatch | `ai-chat-tool-loop.puml` |
| Backup AEAD Encryption | AES-256-GCM v2 bundle create + restore (ADR-040) | `backup-aead-encryption.puml` |
| Dev Observability | API event bus → ring buffer → Cmd+Shift+A Inspector | `dev-observability-flow.puml` |

## Interactive Flow Visualizer

For an interactive companion to these diagrams, open `docs/flow-visualizer.html` — a single-page HTML map of all packages (55 components) and 24 end-to-end flows. Click a flow to highlight the path, step through it, and inspect the payload at every hop. Data lives in an embedded JSON block; extending it is a copy-paste.

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
- `apps/frontend/src/features/settings/sections/BackupSection.tsx` — UI for backup/restore, passphrase management, error handling

**Coverage:** All 31 user-data tables + attachments + localStorage keys. CI test enforces coverage on every migration.

Documentation:
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]] — Coverage matrix, bundle format, restore process
- [[docs/architecture/electron|Electron Architecture]] — IPC handlers, security model
- [[docs/reference/api-endpoint-matrix#ipc-handlers--electron-desktop-phase-12|API Endpoint Matrix — IPC Section]]

## Apple-Refined Visual Pass — base design (June 2026, ADR-105)

[[docs/adr/105-apple-refined-visual-pass|ADR-105]] bakes an Apple-craft-inspired refinement pass into the base design. **These values apply at all times — they are not behind a flag.**

The diagnosis: the "AI-generated" look is sameness (one shadow depth, one radius, one spacing step everywhere — the Tailwind/shadcn statistical mean), not richness. The fix is optical resolution within richness: differentiated elevation, tuned geometry, spring motion, bespoke accent.

**Current base design token values** (verified from source):

| Token / class | Value |
|---|---|
| `--radius` | `0.625rem` |
| `Card` base radius | `rounded-[0.75rem]` |
| `--ease-out-quint` | `cubic-bezier(0.32, 0.72, 0, 1)` |
| `--ease-out-expo` | `cubic-bezier(0.32, 0.72, 0, 1)` |
| `.press-feedback:active` | `scale(0.97)` |
| `.tabular-nums` letter-spacing | `-0.006em` |
| `--primary` (light) | `164 78% 26%` (jewel emerald) |
| `--primary` (dark) | `160 74% 52%` (jewel emerald) |
| `--ring` / `--sidebar-primary` / `--sidebar-ring` | mirror `--primary` per mode |

**Glass elevation differentiation** — `glass-regular` (cards) vs `glass-elevated` (hero tiles) now have distinct shadow signatures. The previous state had nearly identical parameters on both tiers:

- `glass-regular` specular: `inset 0 1px 0 hsl(--glass-highlight / 0.60)` light / `0.12` dark; exterior `0 6px 20px -8px`
- `glass-elevated` specular: `inset 0 1px 0 hsl(--glass-highlight / 0.72)` light / `0.18` dark; exterior `0 18px 46px -16px`

Glass backgrounds, blur levels, border, and `backdrop-filter` are untouched.

**Hairlines**: `@media (min-resolution: 2dppx)` sets `border-width: 0.5px` on `.glass-regular`, `.premium-frame`, and `.glass-thin` for sub-pixel card borders on Retina displays.

**What is retained (explicitly not changed)**: aurora CSS blobs, film grain, `liquid-canvas`, WebGL `ShaderAurora` (ADR-071), all glass material backgrounds/blur/border, `.micro-lift:hover` translate, `.premium-frame` hover glow, Fraunces/Inter font stack.

**Deferred**: Apple's label-opacity text hierarchy (1.0/0.6/0.3/0.18) — needs a token-level change to avoid inconsistency with existing `muted-foreground` opacity variants.

Documentation:
- [[docs/adr/105-apple-refined-visual-pass|ADR-105: Apple-refined visual pass]]

## Dense-Fintech Visual Skin — VITE_SKIN_V2 flag (June 2026, ADR-104)

> [!info] Scope after ADR-105
> The flatten direction explored in ADR-104 (atmosphere removal, flat glass, Inter headings, tight radius, calmed motion) was **abandoned**. `VITE_SKIN_V2` now gates **only** the colorblind-safe gain/loss recoloring (`.amount-gain`/`.amount-loss` → Okabe-Ito `--gain`/`--loss` tokens). The geometry, glass, typography, motion, and accent are now governed by the base design (ADR-105 above), not this flag.

[[docs/adr/104-skin-v2-dense-fintech-visual-redesign|ADR-104]] ships `apps/frontend/src/styles/skin-v2.css` as a CSS layer that sits **outside every `@layer` block**, scoped under `:root.skin-v2`. The class is applied synchronously before the first React render by `applySkinV2Class()` (`lib/skin.ts`) from `main.tsx`.

**Activation**: build-time `VITE_SKIN_V2=true` env flag (ADR-030 `booleanEnv`, **default `false`**) or `localStorage` override `vision_skin_v2`. Dev console helper: `window.__setSkinV2(true | false | undefined)`.

**What skin-v2 currently changes** (surviving scope after the revert):
- `.amount-gain` → `hsl(var(--gain))` — Okabe-Ito green `162 84% 30%` (light) / `160 65% 52%` (dark)
- `.amount-loss` → `hsl(var(--loss))` — Okabe-Ito vermillion `24 85% 45%` (light) / `24 90% 62%` (dark)

These are always paired with explicit +/− signs and directional arrows in component markup.

**Critical inline-token constraint** (retained from ADR-104): `applyThemePalette()` in `themes.ts` writes all color tokens as `element.style.setProperty()` inline styles on `document.documentElement`. Skin-v2 CSS cannot override these tokens. Only structural tokens (`--radius`, blur sizes, aurora alphas, motion durations/easings) are freely overridable from CSS — but those are now governed by the base design, not by this flag.

> [!note] ADR-075 compatibility
> The ADR-075 visual-effects tier system (`fx-reduced`, `fx-static-atmosphere`) composes correctly with both ADR-104 and ADR-105. Tier system operates on `backdrop-filter` presence and aurora animation; neither this flag nor the base-design changes touch those mechanisms.

Documentation:
- [[docs/adr/104-skin-v2-dense-fintech-visual-redesign|ADR-104: Dense-fintech skin (revised)]]
- [[docs/reference/code-patterns#scoped-skin-behind-a-flag-pattern-adr-104|Code Patterns — Scoped-skin flag pattern]]

## Frontend Design System — Liquid Glass v2 (June 2026, ADR-070)

[[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070]] completed a five-tier frontend overhaul in June 2026, restoring and extending the ADR-017 liquid-glass design system:

- **Atmosphere layer**: `AppLayout` renders a fixed `liquid-canvas` layer — two slow-drifting aurora blobs (compositor-only transforms, 64s/76s alternate) over a radial wash + SVG grain; aurora pauses under `prefers-reduced-motion`.
- **Saturated materials**: `backdrop-filter` now includes `saturate(var(--glass-saturate))` (180% light / 150% dark); blur tiers raised to 12/20/24/28/32px (thin/regular/chrome/thick/elevated). A11y: `prefers-reduced-transparency` now strips `backdrop-filter` (was incorrectly under `prefers-reduced-motion`).
- **Card vocabulary**: `surface-elevated … bg-card backdrop-blur-sm` replaced across ~45 KPI/chart cards with `glass-regular` (KPI/chart) or `glass-elevated` (hero). `premium-frame` baked into base `Card` — universal hover outline. Tables stay opaque (perf budget).
- **Motion**: `PageTransition.tsx` (new, enter-only spring, keyed on pathname); 2px hairline shimmer replaces `PageLoader`; dialog/alert-dialog use `dialog-in`/`dialog-out` keyframes with overshoot bezier; sidebar active rail is a framer `layoutId` element (`ActiveRail`); theme crossfade via `document.startViewTransition`.
- **CommandPalette**: ⌘K palette (`components/shared/CommandPalette.tsx`) covers all pages + theme/settings; topbar trigger button; 5 new i18n keys (en/nl).
- **Optimistic mutations**: `useUpdateTransaction` / `useDeleteTransaction` snapshot → patch → rollback via `setQueriesData`; `['transactions-virtual']` deliberately excluded; 4 new tests.
- **Route preload**: `lib/routePreload.ts` shared by `App.tsx` lazy() and `AppSidebar` hover prefetch.

Documentation:
- [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070: Liquid Glass v2]] (June 2026)
- [[docs/architecture/frontend-architecture|Frontend Architecture — Design System section]]
- [[docs/reference/code-patterns#surface-shell-pattern-phase-9|Surface Shell Pattern]] (updated)
- [[docs/reference/code-patterns#motion-consumer-pattern-phase-9|Motion Consumer Pattern]] (updated)
- [[docs/components/ui-components|UI Components]] (Card, Dialog, Sonner, CommandPalette)
- [[docs/components/layout|Layout Components]] (AppLayout, AppSidebar, PageTransition)

## Frontend Design System (Phase 9) & CSS Architecture (Tailwind v4, May 2026)

The baseline liquid-glass aesthetic (ADR-017) was further tuned in the Tailwind v4 migration (ADR-047). June 2026 ADR-070 is the authoritative current state; the items below document the Tailwind v4 infrastructure that remains in place:

- **Color Palette**: Emerald + champagne-gold with deep charcoal base
- **Typography**: Fraunces (display, serif) + Inter (body, geometric sans-serif) — static weights (400/500/600) via `@fontsource`
- **Material System**: Five-tier glass hierarchy + premium surface utilities (see ADR-070 for current blur tiers)
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
- [[docs/adr/047-tailwind-v4-migration-dependency-upgrades|ADR-047: Tailwind v4 Migration & Dependency Upgrades]]
- [[docs/architecture/frontend-architecture#css-architecture-tailwind-v4-may-2026|Frontend Architecture — CSS Architecture]]
- [[docs/reference/code-patterns#motion-consumer-pattern-phase-9|Motion Consumer Pattern]]
- [[docs/reference/code-patterns#surface-shell-pattern-phase-9|Surface Shell Pattern]]

## June 2026 Remediation Pass (ADRs 067–069)

### Enforced Route → Service Boundary (ADR-067)

[[docs/adr/067-enforce-route-service-boundary|ADR-067]] — All 15 route files now import exclusively from thin `services/<domain>Service.js` seams. ESLint rule `vision-local/no-repo-direct-from-route` promoted to ERROR. 14 new service modules added. Diagram updated: `backend-service-layer.puml` has a new "Thin Route Seams" package.

### Drop mv_recipient_monthly (ADR-068)

[[docs/adr/068-drop-mv-recipient-monthly|ADR-068]] — The `mv_recipient_monthly` materialized view was never read after `agg_recipient_totals` became the live source. Migration `0038` drops it. `aggregationRefresh.js` no longer schedules its refresh. See [[docs/performance/materialized-views|Materialized Views]] for updated strategy.

### @vision/shared-utils Cross-Workspace Package (ADR-069 and ADR-073)

[[docs/adr/069-shared-utils-monorepo-package|ADR-069]] introduced `packages/shared-utils/` for pure logic shared by both apps, and [[docs/adr/073-shared-portfolio-math-package|ADR-073]] explicitly broadened that boundary to cross-workspace portfolio calculations. Its current modules are `money`, `portfolio`, `assetClasses`, `category`, `csv`, and `slugify`; the removed `downsample` module is no longer part of the package. `roundMoney` remains canonically `ROUND_HALF_EVEN` (banker's rounding) everywhere. App-specific I/O and framework code remain in their owning workspaces.

### Other June 2026 Security & Correctness

- **Global rate limiter on `/api`** — `globalRateLimiter` mounted before all routers; configurable via `RATE_LIMIT_GLOBAL_MAX` / `RATE_LIMIT_GLOBAL_WINDOW_MS`. See `backend-api-layer.puml`.
- **Trusted-proxy XFF gating** — `TRUSTED_PROXIES` env var controls when `X-Forwarded-For` is trusted for IP keying.
- **VISION_DEV fail-safe** — dev bypasses (rate-limit skip, wildcard CORS) now require explicit `VISION_DEV=true`.
- **Zip-bomb guard** — `extractZip` in Electron backup restore enforces `MAX_RESTORE_BYTES` (10 GiB) and `MAX_RESTORE_ENTRIES` (100,000).
- **5 MB response cap** — `_assertResponseWithinCap` applied to Binance and Kinesis fetches.

## May 2026 Recent Decisions (ADRs 053–058)

**Belgian Tax Correctness & Historical Viewing:**
- [[docs/adr/053-belgian-pit-exemption-bracket-correction|ADR-053]] — Exemption-bracket calculation correction
- [[docs/adr/054-belgian-regional-own-home-credits|ADR-054]] — Regional own-home credits (Flemish woonbonus, Walloon chèque habitat)
- [[docs/adr/055-belgian-tax-income-source-filtering|ADR-055]] — Taxable income source filtering for graph visualization
- [[docs/adr/056-belgian-tax-audit-fixes-ay2026|ADR-056]] — Comprehensive audit fixes (disabled-dependent doubling, child-under-3 forfeiture, regional autonomy factor, property-tax centimes)
- [[docs/adr/057-belgian-tax-audit-followup-pwc-may-2026|ADR-057]] — Follow-up audit (TOB shares cap, CGT effective date, direct-bond CGT routing, Reynders interest-portion split, year-aware suggestions, per-residence centimes override)
- [[docs/adr/058-belgian-tax-historical-year-snapshots|ADR-058]] — Historical year viewer with frozen per-year profile snapshots, shared year switcher across `/tax` and `/portfolio/tax` pages, soft-lock editing mode

## Technology Stack

- **UML Tool**: PlantUML
- **Rendering**: Obsidian with PlantUML plugin
- **Hosting**: Git (version controlled diagrams)
