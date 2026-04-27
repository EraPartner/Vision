---
title: Vision Project Knowledge Base
type: index
status: active
date: 2026-04-27
updated: 2026-04-27
tags: [knowledge-base, index, project, overview, phase-8, phase-5a, phase-6, phase-7, phase-4, phase-3, phase-9]
description: Main entry point to the Vision project documentation - financial transaction management application. Phase 9 complete with aggregation shadow cutover; all aggregations now served via `/api/aggregations/*`. Phase 8 complete with portfolio and tax PDF report export (6 + 7 sections). Recent fixes include ExportDialog date picker UI, VirtualDataTable edit column width, and bank reconciliation feature removal.
aliases: [KB, docs, documentation, knowledge base, home]
---

# Vision Knowledge Base

> [!abstract] About This KB
> Welcome to the Vision project documentation. This knowledge base contains architectural decisions, API documentation, guides, and all project knowledge designed for **humans**, **AI agents**, and **computer scientists**.
> 
> **Quick Open:** Press `Ctrl/Cmd+O` to quick-open any document
> **Search:** Use the search bar or `Cmd+Shift+F` for full-text search
> **Graph View:** Use `Cmd+G` to explore document relationships

## 🎯 Quick Navigation

```dataview
TABLE WITHOUT FILE
  choice(contains(file.tags, "guide"), "📖", "") + " " + choice(contains(file.tags, "api"), "📡", "") + " " + choice(contains(file.tags, "architecture"), "📐", "") + " " + choice(contains(file.tags, "feature"), "⚡", "") + " " + choice(contains(file.tags, "reference"), "📚", "") as "",
  title AS "Document",
  choice(date, dateformat(date, "yyyy-MM-dd"), "—") AS "Updated"
FROM "docs"
WHERE status = "active" AND type != "index"
SORT title ASC
LIMIT 20
```

## Quick Start

| If you're... | Start here |
|---|---|
| **New developer** | [[docs/getting-started|Getting Started MOC]] → [[docs/guides/setup|Setup Guide]] |
| **Looking for an API** | [[docs/api/index|API Overview]] or [[docs/api/transactions|Transactions API]] |
| **Making an architectural decision** | [[docs/adr/index|ADR Index]] → [[docs/adr/template|Template]] |
| **Understanding the architecture** | [[docs/architecture/index|Architecture Overview]] |
| **Working on a feature** | [[docs/features/index|Feature Docs]] |
| **An AI agent** | Read [[docs/adr/index|ADRs]] first, then check [[docs/api/index|API docs]] |
| **Computer scientist** | See [[#For Computer Scientists]] section below |

## Audience-Specific Paths

### 👨‍💻 For Developers

```dataview
TABLE WITHOUT FILE title AS "Document", description AS "Description"
FROM "docs/guides"
WHERE type = "guide"
SORT title ASC
LIMIT 5
```

**Start here:** [[docs/guides/setup|Setup Guide]] → [[docs/guides/contributing|Contributing Guide]]

### 🤖 For AI Agents

> [!tip] AI Agent Quick Reference
> 1. **Read before writing** - Check existing docs before adding new content
> 2. **Use ADRs for decisions** - Document significant design choices in `docs/adr/`
> 3. **Update relevant docs** - Keep API, features, and guides docs in sync with code
> 4. **Use templates** - Start new documents from templates in `docs/templates/`
> 5. **Use wiki-links** - Link to code with `[[apps/node-backend/src/routes/file.js]]` format
> 6. **Search first** - Use `obsidian_simple_search` to find existing docs

**Start here:** [[CLAUDE.md]] → [[docs/guides/ai-agent-kb-usage|AI Agent KB Usage]] → [[docs/guides/kb-maintenance|KB Maintenance]]

### 🔬 For Computer Scientists

> [!abstract] Algorithms & Complexity
> This section documents the algorithmic foundations of Vision for developers interested in computational complexity, data structures, and optimization techniques.

| Document | Description | Complexity |
|----------|-------------|-------------|
| [[docs/reference/algorithms|Algorithms & Data Structures]] | LTTB, SHA-256 deduplication, recurring detection, Modified Dietz | O(n), O(1) |
| [[docs/reference/database-query-patterns|Database Query Patterns]] | PostgreSQL CTEs, window functions, materialized views | Index analysis |
| [[docs/reference/data-model|Data Model]] | Entity relationships and schema design | Schema patterns |
| [[docs/performance/chart-downsampling|Chart Downsampling]] | LTTB implementation for time-series | O(n) time, O(k) space |
| [[docs/adr/005-materialized-views|ADR-005: Materialized Views]] | Pre-computed aggregation strategy | Query vs view trade-offs |
| [[docs/adr/004-postgresql-table-inheritance|ADR-004: Table Inheritance]] | PostgreSQL inheritance for investments | Schema design patterns |
| [[docs/adr/006-three-layer-architecture|ADR-006: Three-Layer Architecture]] | Routes → Services → Repositories | Layer separation patterns |
| [[docs/adr/007-streaming-imports|ADR-007: Streaming Imports]] | SSE progress + parallel batch processing | Pipeline architecture |

## Knowledge Areas

| Area | Description |
|------|-------------|
| [[docs/adr/index|🏗️ Architecture Decisions]] | Major design decisions and rationale |
| [[docs/api/index|📡 API Documentation]] | REST API endpoints and schemas |
| [[docs/guides/index|📖 Guides]] | Setup, deployment, and contributing |
| [[docs/features/index|⚡ Features]] | Feature documentation (Portfolio, Tax, etc.) |
| [[docs/integrations/index|🔌 Integrations]] | External services, bank adapters |
| [[docs/i18n/index|🌍 Localization]] | Internationalization and translations |
| [[docs/security/index|🔒 Security]] | Security policies and practices |
| [[docs/performance/index|🚀 Performance]] | Performance optimizations |
| [[docs/components/index|🧩 Components]] | Frontend React components and hooks |
| [[docs/testing/index|🧪 Testing]] | Testing strategies and patterns |
| [[docs/architecture/index|📐 Architecture]] | System diagrams and architecture |
| [[docs/reference/index|📚 Reference]] | Code patterns, types, algorithms, env vars |
| [[docs/templates/index|📝 Templates]] | Documentation templates for new docs |

## 📊 PlantUML Diagrams

> [!info] All Diagrams
> Vision uses 23 PlantUML diagrams across backend, frontend, and system categories.

```dataview
TABLE WITHOUT FILE
  choice(contains(file.name, "backend"), "🖥️", "") + choice(contains(file.name, "frontend"), "🎨", "") + choice(contains(file.name, "import"), "📥", "") + choice(contains(file.name, "price"), "💹", "") + choice(contains(file.name, "currency"), "💱", "") + choice(contains(file.name, "system"), "🌐", "") as "",
  file.name AS "Diagram",
  choice(contains(file.name, "-flow") OR contains(file.name, "-sequence"), "Flow", "Architecture") AS "Type"
FROM "docs/diagrams"
WHERE file.name != "index.md"
SORT file.name ASC
LIMIT 20
```

**View all diagrams:** [[docs/diagrams/index|Diagrams Index]] | [[docs/architecture/index|Architecture Overview]]

| Resource | Description |
|----------|-------------|
| [[docs/glossary|📚 Glossary]] | Key terms, aliases, and disambiguation |
| [[docs/tag-taxonomy|🏷️ Tag Taxonomy]] | Controlled vocabulary for KB tags |
| [[docs/troubleshooting|🔧 Troubleshooting]] | Common issues and solutions |
| [[docs/getting-started|🗺️ Getting Started]] | Map of Content for navigation |
| [[docs/common-tasks|📋 Common Tasks]] | Task-oriented quick reference |
| [[docs/diagrams/index|📊 Diagrams Index]] | All PlantUML diagrams organized by category |
| [[docs/reference/data-model|🗃️ Data Model]] | Complete entity reference — core, portfolio, planning |
| [[docs/reference/environment-variables|🔑 Environment Variables]] | All env vars in one place |
| [[docs/reference/react-query-keys|🔄 React Query Keys]] | All frontend query keys |
| [[docs/reference/frontend-routes|🛣️ Frontend Routes]] | Complete route table |
| [[docs/reference/scripts|⚙️ Scripts Reference]] | All bun/npm commands |
| [[docs/reference/database-triggers|🗄️ Database Triggers]] | All PostgreSQL triggers |
| [[docs/reference/migration-dependencies|🔗 Migration Dependencies]] | Migration chain and groups |
| [[docs/reference/code-patterns|💻 Code Patterns]] | Standard code patterns for all layers |
| [[docs/reference/error-codes|❌ Error Codes]] | All API error responses and status codes |
| [[docs/reference/typescript-types|🔢 TypeScript Types]] | All frontend type definitions |
| [[docs/reference/algorithms|🧮 Algorithms]] | LTTB, deduplication, recurring detection, currency conversion |
| [[docs/reference/service-layer|🗂️ Service Layer]] | All 16 backend services reference |
| [[docs/reference/database-query-patterns|🗄️ Database Query Patterns]] | PostgreSQL patterns, indexes, optimization |
| [[docs/reference/agent-navigation-map|🗺️ Agent Navigation Map]] | File navigation by feature, layer, task |
| [[docs/reference/frontend-api-client|🔌 Frontend API Client]] | Transport, types, and facade layers of the HTTP client (Phase 1) |
| [[docs/reference/schema-initialization|🗃️ Schema Initialization (Archived)]] | Legacy database startup schema initialization |
| [[docs/reference/api-endpoint-matrix|📊 API Endpoint Matrix]] | Complete matrix of all 128 API endpoints |

## Recent Updates

```dataview
TABLE WITHOUT FILE title AS "Document", date AS "Date", type AS "Type"
FROM "docs"
WHERE date AND date >= date(today) - dur(7 days)
SORT date DESC
LIMIT 10
```

### 2026-04-27 Encrypted Backup Restore with Passphrase Modal (Phase 2)

**UX Enhancement:**
- **Encrypted restore detection**: Backup restore now detects encryption via magic header without decryption
- **Passphrase modal**: When user attempts to restore an encrypted `.visionbak.enc` file, a modal prompts for the backup passphrase before decryption
- **Error recovery**: Wrong passphrase shows clear error message and allows retry (no silent failures)
- **Fallback sources**: Restore still respects `VISION_BACKUP_PASSPHRASE` env var and OS keychain (Electron safeStorage) as fallback if user doesn't enter passphrase in modal
- **No breaking changes**: Unencrypted backups (`.visionbak`) restore without prompting; encrypted behavior is opt-in via user input
- **Hook-driven UX**: New `useRestoreBackup` hook manages modal flow consistently across BackupTab and onboarding RestoreFromBackupCard
- **i18n**: Six new translation keys already present (`settings.restore.passphraseTitle`, `passphraseDesc`, `passphraseLabel`, `passphraseSubmit`, `passphraseInvalid`, `passphraseRequired`)

See [[docs/features/backup-coverage-audit|Backup Coverage Audit]], [[docs/features/settings|Settings]], [[docs/components/dashboard-settings-dialog|DashboardSettingsDialog]], and [[docs/security/data-protection|Security: Data Protection]] for implementation details.

### 2026-04-26 Minor Frontend Fixes & Bank Reconciliation Removal

**Component Updates:**
- **ExportDialog date picker** — Replaced native `<Input type="date">` with app's shared `<DatePicker>` component using `parseLocalDateFromYmd`/`toYmd` utilities for consistent date handling across report export dialogs.
- **VirtualDataTable edit column width** — Action column now dynamically expands to 88px when editing (was fixed 40px), preventing button overlap during inline editing.
- **EditInvestmentDialog TDZ fix** — Fixed temporal dead zone issue where `unitBased` was called as function instead of assigned from `isUnitBased(...)`.
- **PerformancePage sparkline** — Sparkline "Last 30 days" now uses separate `useQuery` with fixed `period: "1m"` instead of deriving from period-specific downsampled snapshots.

**CSV Import Accuracy:**
- **CategoriesImportCard toast** — Fixed `total` param in import success toast to use `data.total_processed` instead of `data.imported` for correct count display.

**Feature Removal (Complete):**
- **Bank reconciliation feature removed** — Full stack removal including frontend page (`ReconciliationPage.tsx`), API client (`reconciliation.ts`), backend routes (`reconciliation.js`), repository (`reconciliationRepository.js`), all i18n keys, and Alembic migration `0014_drop_bank_reconciliation`. Feature docs (`docs/features/bank-reconciliation.md`, `docs/api/reconciliation.md`) already cleaned up.

See [[docs/components/export-dialog|ExportDialog]], [[docs/components/shared-components|Shared Components]], [[docs/features/index|Features Index]]

### 2026-04-25 Docker Container Hardening

**ADR-039 Acceptance:**
- Non-root user (`USER bun`, UID 1000)
- Dropped Linux capabilities (`cap_drop: [ALL]`)
- No-new-privileges flag (`security_opt: [no-new-privileges:true]`)
- Read-only root filesystem with selective writable surfaces (`/tmp` tmpfs, `attachments_data` named volume)
- Resource ceilings (`mem_limit: 4g`, `cpus: 4.0`)
- Container healthcheck via `/health` endpoint
- CI image scanning via Trivy on every push/PR (CRITICAL/HIGH, exit-code 1, ignore-unfixed)

Surfaces accidental writes; prevents RCE-to-root escalation; attachments persist across rebuilds; CI blocks releases on critical CVEs.

See [[docs/adr/039-docker-container-hardening|ADR-039]], [[docs/security/container-hardening|Container Hardening]]

### 2026-04-24 Feature Flags Removed

**ADR-035 Acceptance:**
- Remove entire runtime-toggleable feature flag system (DB table, backend service/repo/routes, frontend page, i18n keys)
- All features always enabled unconditionally
- Alembic migration `0011_drop_feature_flags` drops the table while preserving history
- Rationale: No flags were ever toggled off in production; system added maintenance surface without delivering value

See [[docs/adr/035-remove-feature-flags|ADR-035]]

### 2026-04-24 Admin Environment — Unified Observability Hub

**ADR-034 Acceptance:**
- **Settings Toggle**: `adminMode: boolean` in `AppSettings` Zustand store with toggle in Settings → App → Developer section
- **Four Admin Pages**: Overview (`/admin`), Database Maintenance (`/admin/db`), Data Sources/Providers (`/admin/providers`), Endpoints Liveness (`/admin/endpoints`)
- **Provider Health Tracking**: Passive success/error recording from 7 data sources (Binance, Yahoo, Kinesis, ECB, open.er-api, Statbel, Eurostat) + on-demand probe endpoints
- **Request Metrics**: In-memory rolling window (15 min / 1 min buckets) with p50/p95 per route via `requestMetrics` middleware
- **Endpoint Manifest**: Static Express router scan returning all registered routes with methods + descriptions
- **New Backend Modules**: `services/providerHealth/`, `middleware/requestMetrics.js`, `services/routeManifest.js`
- **4 New API Endpoints**: `GET /api/admin/providers/health`, `POST /api/admin/providers/:provider/probe`, `GET /api/admin/metrics/requests`, `GET /api/admin/endpoints`
- **API Total**: 148 endpoints across 20 routes (Admin: 13 endpoints after feature flags removal)

See [[docs/adr/034-admin-environment|ADR-034]], [[docs/features/admin-observability|Admin Observability Feature]], [[docs/api/admin|Admin API]]

### 2026-04-24 Phase 5 & 6 — PDF Polish & Localization Complete

**PDF Report Export Phase 5 (Polish):**
- **Paginated Footer**: Puppeteer footer template with "Vision | Confidential | page X / Y" on all content pages; theme colors interpolated as HSL literals
- **Footer Space Management**: CSS variable `--footer-h: 28px` reserves footer area; cover page height adjusted to `calc(297mm - var(--footer-h))`
- **Print Break Control**: `break-inside: avoid` on `.kpi-card`, `.account-card`, `.stat-row`, `.planned-day` prevents orphaning; `display: table-header-group` on `.data-table thead` repeats headers across pages
- **Improved Layout**: Top border on `.page` (4px primary color), `break-after: avoid` on section titles/subtitles for visual separation

**PDF Report Export Phase 6 (i18n) & Phase 8 (Portfolio & Tax Reports):**
- **32 New Translation Keys** (Phase 6): Added `export.*` keys to `i18n/source/en.json` and `nl.ts` for dialog, period selection, section toggles, currency, and actions
- **Full Localization**: Both English and Dutch translations for Report Type, Period (YTD/rolling/custom/year), Sections (7 financial + 6 portfolio + 7 tax), Currency, and Download actions
- **Phase 8 Completion**: Portfolio and tax reports fully implemented with real data fetchers, SVG charts, and Belgian tax profile pass-through. All 20 export.section.* keys now mapped to complete sections (no placeholders)
- **Validation Pass**: `bun run validate-locales` confirms parity, types, and no drift

See [[docs/features/pdf-report-export|PDF Report Feature]] (Phase 3-8), [[docs/api/reports|Reports API]], [[docs/i18n/translations|i18n Translations]] (32 export keys + portfolio/tax sections)

### 2026-04-24 TypeScript & Error Handling Standards (Phase 5+ Linting Fixes)

**Frontend Type Safety Hardening across 18 files:**

- **Error Handling**: Migrated all `catch (err: any)` to `catch (err: unknown)` with type narrowing via `instanceof` checks. Empty catch blocks now include explanatory comments.
- **Type Annotations**: Added explicit `: type` annotations to uninitialized variables (`let count: number`) instead of inference; removes `no-useless-assignment` anti-pattern.
- **Cast Removal**: Eliminated `as any` casts in favor of type guards (AppearanceTab, GeneralTab translation keys; DashboardPage transaction types).
- **Interface Cleanup**: Converted empty `interface X extends Y {}` to `type X = Y` (command.tsx, textarea.tsx) per `no-empty-object-type` rule.
- **Error Context**: All re-thrown errors now use `{ cause: err }` to preserve error context in logs (ai.ts, client.ts, imports.ts).
- **Type Specificity**: 
  - `any[]` → `Transaction[]` in DashboardPage
  - `useState<any[]>` → `useState<Recipient[]>` in RecipientsPage
  - `transactions: any[]` → `transactions: PortfolioTransaction[]` in types/portfolio.ts

**Documentation Updates:**
- [[docs/reference/code-patterns#typescript-type-annotation-best-practices-phase-5|TypeScript Type Annotation Best Practices]] — New section covering explicit annotations, type narrowing, and interface/type guidance.
- [[docs/reference/code-patterns#frontend-error-handling-phase-5|Frontend Error Handling (Phase 5+)]] — Enhanced error handling section with type-safe catch patterns and error context preservation.
- [[docs/guides/contributing#typescript-frontend|Contributing Guide TypeScript section]] — Added type-safety rules and examples.

**Linting Status:** 0 type safety errors; tests remain at 1223 passing (no behavior changes).

### 2026-04-24 Phase 7 — Feature Batch C Complete

**Database Maintenance, Sankey Flow, Rolling Averages, PDF Reports:**

- **Database Maintenance UI** (`GET /api/admin/db/stats`, `POST /api/admin/db/vacuum`): Real-time table statistics display and per-table/bulk VACUUM ANALYZE operations. Uses raw database client (not pool) because VACUUM cannot run in transactions. Frontend page at `/admin/db`.
- **Sankey Flow Visualization** (`GET /api/aggregations/sankey`): Interactive income→category flow diagram via d3-sankey showing top 12 categories + Savings node. New "Flow" tab in Statistics page with year selector. Backend service in `aggregation/sankey.js` with top-12 category aggregation and savings calculation.
- **Rolling Average Overlays**: New utility `computeRollingAverage()` (window-based moving average with null-handling) + BarChart overlay support. MonthlyChart toggle displays 3-month rolling average line overlay. Helps identify trends beneath seasonal noise.
- **PDF Financial Report Export** (`GET /api/reports/financial`): Server-side PDF generation via `pdfkit@0.18.0` with streaming response. Includes summary cards, monthly breakdown table, top 10 categories. "Export PDF" button added to StatisticsPage header. API client method `downloadFinancialReport()` handles browser download flow.
- **Endpoint Matrix Updated**: All 150 endpoints now documented including Phase 7 additions.

See [[docs/features/database-maintenance|DB Maintenance]], [[docs/features/sankey-flow|Sankey Flow]], [[docs/features/rolling-averages|Rolling Averages]], [[docs/features/pdf-report-export|PDF Reports]], [[docs/api/aggregations|Aggregations API]], [[docs/api/admin|Admin API]]

### 2026-04-24 Phase 5A Feature Batch A Complete

**CSV Import & Receipt Attachments:**

- **ADR-{pending}**: Receipt attachment system with file storage in `{ATTACHMENTS_DIR}/{txId}/{uuid}.ext` structure; configurable size limits via `ATTACHMENT_MAX_SIZE_MB`.
- **Visual CSV Mapper**: New `useCsvPreview` hook + `CsvColumnMapper` component for client-side header detection and column mapping with preview table showing mapped columns highlighted.
- **Attachment Routes**: Four endpoints:
  - `POST /api/attachments/transaction/:id` — Upload
  - `GET /api/attachments/transaction/:id` — List with metadata
  - `GET /api/attachments/:id/download` — Stream file
  - `DELETE /api/attachments/:id` — Delete file + record
- **Frontend AttachmentPanel**: React Query integration with image thumbnails, hover-reveal delete button, upload progress feedback.
- **Database Migration 0004**: `attachments` table with transaction FK CASCADE, stored_path, mime_type, size_bytes.
- **Phase 5A Feature Checklist**:
  - ✅ Import rollback (batch_id + delete-by-batch)
  - ✅ Import history view with UI
  - ✅ JSON/CSV portability export
  - ✅ Visual CSV column mapper (useCsvPreview hook)
  - ✅ Receipt attachments (upload, list, download, delete)

See [[docs/features/import|Import Feature]], [[docs/api/attachments|Attachments API]], [[docs/reference/api-endpoint-matrix|API Endpoint Matrix (133 endpoints)]]

### 2026-04-17 Phase 9 — UI Revamp: Liquid Glass Aesthetic, visx Charts, Framer Motion

**Frontend Complete Redesign:**

- **ADR-017 — Liquid Glass Aesthetic**: Apple-inspired design system with emerald + champagne-gold palette, five-tier glass material hierarchy, self-hosted Fraunces (display) + Inter Tight (body) fonts, centralized token system (`styles/tokens.css`), premium surface utilities (`surface-elevated`, `premium-frame`, `micro-lift`, `liquid-canvas`). All 48 shadcn components retuned to token-based styling; glass defaults for overlays/modals.

- **ADR-018 — visx/d3 Chart Migration**: Migrated from Recharts to visx + d3 low-level primitives. New chart library in `components/charts/` (AreaChart, BarChart, PieChart, LineChart, Sparkline, Candlestick, TreemapChart, etc.). Design-token-aware styling; saves ~35kb gzipped (Recharts ~50kb → visx ~15kb). All consumer pages (Dashboard, Statistics, Performance, Portfolio, Watchlist) rewritten.

- **ADR-019 — Framer Motion Adoption**: Unified motion system via `lib/motion.ts` with centralized durations, easings, spring configs. All 18+ form dialogs + PageTransition wrapper use spring entry/exit. Full `prefers-reduced-motion` compliance via `useReducedMotion()` hook on all motion consumers.

- **Shell Components**: AppLayout v2 with `liquid-canvas` animated gradient mesh + grain overlay + motion-aware atmosphere blobs. AppSidebar v2 with `glass-chrome` nav + emerald accent rail. PageTransition wrapper animates route changes.

- **Verification**: `bunx tsc --noEmit` clean; `bun run build` 5.52s; `bun run lint` 49 errors/72 warnings (baseline); `bun run validate-locales` pre-existing drift (not from revamp).

See [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017]], [[docs/adr/018-visx-d3-chart-migration|ADR-018]], [[docs/adr/019-framer-motion-adoption|ADR-019]], [[docs/reference/code-patterns#motion-consumer-pattern-phase-9|Motion Consumer Pattern]], [[docs/reference/code-patterns#surface-shell-pattern-phase-9|Surface Shell Pattern]]

### 2026-04-17 Performance Optimization — Glass System Downgrade & Liquid Canvas Removal

**Electron M1 GPU Regression Fix:**

- **ADR-020 — Glass System Downgrade & Liquid Canvas Removal**: Reduced glass-system blur (6-12px max, modal-only usage) and removed liquid-canvas animated background + PageTransition wrapper to eliminate Electron M1 GPU regression. Replaced with solid `bg-card/95` opacity layering + static grain overlay. Font subset optimization (static weights vs. variable). Improves GPU utilization and battery life.
- **Glass hierarchy collapse**: Blur retained only on modal overlays (Dialog, AlertDialog, Sheet) + sidebar chrome; dense surfaces (Card, Input, Textarea, Tabs, Select, etc.) downgraded to opaque backgrounds.
- **Motion consolidation**: PageTransition removed; Framer Motion retained for modal/dialog entry + chart animations (higher UX impact, lower GPU cost).
- **Font optimization**: Swapped `@fontsource-variable/*` → `@fontsource/*` static weights (400/500/600 latin), reducing font file size.

See [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020]]

### 2026-04-23 Phase 3.1 - Backend Repository Split + Batch FX Optimization (infoRepository)

- **infoRepository.js Monolith → Composite Module**: Original 1445-line monolithic `infoRepository.js` split into 7 domain-specific sub-modules for improved maintainability and clarity:
  - `infoRepositoryHelpers.js` (194 lines) — Shared utilities: mvCache, rounding, date/aggregation/category/currency helpers, spike sanitization, `batchConvertGroupsWithHistoricalRateFallback()`
  - `infoRepositoryStatistics.js` (186 lines) — Statistics: `getStatistics`, `getCategoryBreakdown`, `getBanks`, `getTransactionCount`, `getTransactionSummary`
  - `infoRepositoryMonthly.js` (484 lines) — Monthly aggregations: `getMonthlyFinancialSummary`, `getAverageVsCurrentSpending`, `getCashflowComparison` (now with parallel queries + batch FX)
  - `infoRepositoryBanks.js` (145 lines) — Bank operations: `getBankBalances` (now with parallel queries + batch FX)
  - `infoRepositoryNetWorth.js` (233 lines) — Net worth: `getNetWorthFromSnapshots` with snapshot-based calculation and spike sanitization
  - `infoRepositoryPlanned.js` (94 lines) — Planned operations: `getPlannedExpensesNextMonth`
  - `infoRepositoryRecipients.js` (124 lines) — Recipient analytics: `getRecipientInsights`
- **Backward Compatibility**: Barrel re-export in main `infoRepository.js` (37 lines) maintains API transparency; all 9 consumer files import unchanged
- **Shared Utility Consolidation**: Helpers eliminate duplicated patterns across aggregation endpoints (FX conversion fallback, date formatting, category merging, rounding, row mapping)
- **Batch FX Conversion**: New `batchConvertGroupsWithHistoricalRateFallback()` helper combines N row groups into 1 `convertRowsToEur` query, eliminating redundant exchange_rates lookups:
  - `getCashflowComparison`: 4 sequential queries → `Promise.all` + 1 batch FX call (saved 3 exchange_rates queries)
  - `getAverageVsCurrentSpending`: 2 sequential queries → `Promise.all` (FX already cached)
  - `getBankBalances`: 2 sequential queries → `Promise.all` + 1 batch FX call (saved 1 exchange_rates query)
- **Testing**: 1223 tests pass; all endpoint contracts and behavior unchanged

See [[docs/reference/repository-layer|Repository Layer Reference]], [[docs/architecture/backend-architecture|Backend Architecture]], [[docs/api/info|Info & Analytics API]]

### 2026-04-17 Phase 3.5 & 3.6 - Metals DRY Refactor & Watchlist API Integration

- **Phase 3.5 — MetalsPage DRY**: `MetalsPage.tsx` refactored as a thin wrapper around `StocksPage` with configurable props (`assetClasses=["metals"]`, `titleKey="metals.title"`, etc.). Eliminates code duplication; StocksPage now handles all asset-class logic generically.
- **Phase 3.6 — Watchlist API Encapsulation**: `WatchlistPage.tsx` replaced 3 raw `fetch()` calls with typed `apiClient` methods: `getWatchlist()`, `getMarketQuotes(symbols)`, `deleteWatchlistItem(id)`. New watchlist methods added to `apiClient` (`createWatchlistItem`, `updateWatchlistItem`, `getMarketQuotes`). Enables shared error handling, retry logic, and React Query integration.

See [[docs/features/portfolio|Portfolio Feature]] (Metals routing + Phase 3.5), [[docs/features/watchlist|Watchlist Feature]] (Phase 3.6), [[docs/reference/frontend-api-client|Frontend API Client]] (Phase 1 refactor)

### 2026-04-17 Phase 8 Correctness Hardening

- **ADR-016**: Aggregation shadow-mode middleware (`createAggregationShadow`) cross-checks new `/api/aggregations/*` against legacy `/api/info/*` in production. Default 1¢ threshold, `queueMicrotask` fire-and-forget, envelope-aware diff. Removal gated on Phase 9 criteria.
- **Property-test pattern** established: deterministic `mulberry32` seeded PRNG, 50–500 bounded iterations, invariants over examples. Six suites under `apps/node-backend/tests/property/` covering loan-schedule amortization, recurrence cadence, split allocation, monthly aggregation, category totals, and currency round-trip.
- **Calculation Inventory lock**: `apps/node-backend/tests/golden/INVENTORY.md` is now the merge-gate source-of-truth — every calc function carries a G (golden) / P (property) / S (smoke) marker. New calc code must update the inventory before landing.
- **Feature-doc contracts**: splits, planned/recurrence, and currency feature docs reference the property-test invariants as locked contracts.

See [[docs/adr/016-aggregation-shadow-mode|ADR-016]], [[docs/testing/testing#property-test-pattern-phase-8|Property Test Pattern]], [[docs/reference/code-patterns#calculation-inventory-lock-phase-8|Calculation Inventory Lock]]

### 2026-04-16 Phase 1 Aggregation-Layer Infrastructure

- **ADR-010**: Postgres-backed aggregations strategy (MVs + trigger-maintained tables) replaces Redis/in-process caches
- **Migration 0026**: Adds `mv_recipient_monthly`, `agg_recipient_totals`, `agg_split_outstanding` with full trigger maintenance and concurrent refresh support
- **Orchestrator**: `aggregationRefresh.js` service with `refreshAggregations()` (bulk) and `scheduleAggregationRefresh()` (debounced single-row) entry points
- **Data Model**: Phase 1 aggregation entities documented (3 new entities, 5 supporting functions, 4 triggers)
- **Testing**: Module surface + migration artifact smoke tests, golden-fixture harness for Phase 2+ calc modules
- **Fixture Scaffold**: 9-variant test matrix (empty, currencies, exclusions, boundaries, leap-day, DST) documented per aggregate

See [[docs/adr/010-phase1-aggregation-strategy|ADR-010]], [[docs/performance/materialized-views|Materialized Views]], [[docs/reference/data-model|Data Model]], [[docs/reference/code-patterns|Code Patterns]]

### 2026-04-20 Phase 0 Quick-Wins Shipped

- **Frontend**: Context memoization (AppSettings, Language), disabled React Query window-focus refetch, explicit image dimensions (CLS prevention)
- **Database**: Covering partial index on `transactions (category_id, recipient_id) WHERE is_active = true` for hot-path queries
- **Query Optimization**: Prepared-statement plan cache (`queryPrepared`) adopted on hot paths: `getBanks`, `getTransactionCount`, key transaction/info repository methods
- **Import Performance**: Post-commit fire-and-forget materialized-view refresh to keep aggregations warm
- **Electron**: Async file I/O for startup (`loadSettings`, `saveSettings` deferred due to module-load coupling)
- **Code Consolidation**: Deleted deprecated `services/calculations/currency.js` facade; canonical path is now `services/currency/currencyConversionService.js`

### 2026-04-16 Phase 0 Foundations Complete

- **ADR-009**: Timezone policy established for deterministic business math across zones
- **Patterns**: Golden-fixture regression testing, centralized SQL filter builder, typed error hierarchy
- **Infrastructure**: Database fixture helper (TEST_DATABASE_URL), exchange_rate_cache table for arbitrary FX pairs
- **Testing**: New patterns documented for golden fixtures and database-dependent tests
- **Migration**: 0025_exchange_rate_cache.py adds schema support for arbitrary FX pair caching

See [[docs/adr/009-timezone-policy|ADR-009]], [[docs/reference/code-patterns|Code Patterns]], [[docs/testing/testing|Testing Documentation]], [[docs/integrations/currency-conversion|Currency Conversion]]

### 2026-04-16 Performance Page Rewrite

- **API Enhancement**: `/api/info/portfolio-performance` now returns pre-computed metrics, heatmap, and per-investment breakdown with new `period` query param (1m/3m/6m/1y/3y/all)
- **Backend Services**: New `portfolioPerformanceSnapshotService.js` with `computeMetrics()`, `computeHeatmap()`, `getBreakdownSummary()` functions
- **Downsampling**: LTTB algorithm ported to backend for server-side snapshot reduction to ~400 points
- **Heatmap Fix**: Contribution-adjusted formula now correctly isolates investment returns from cash flow effects
- **Frontend Simplification**: Eliminated 4 heavy useMemo chains; page now makes 1 API call instead of 4 sequential requests
- **Performance Gain**: Payload reduced 30-40x for filtered periods (1000 snapshots → ~30 points)
- **Architecture Decision**: See [[docs/adr/008-performance-page-server-computed-response|ADR-008]]

### 2026-04-02 KB Enhancements

- **Documentation Templates**: Created `docs/templates/` with templates for API endpoints, features, components, guides, and hooks
- **Data Model Reference**: Created `docs/reference/data-model.md` with complete entity documentation
- **Diagrams Index**: Created `docs/diagrams/index.md` with organized diagram catalog
- **Fixed frontend-architecture.md**: Removed stray `@enduml` artifacts and fixed bare wiki-links
- **Enhanced main index**: Added audience-specific navigation paths for developers, AI agents, and computer scientists
- **Updated tag taxonomy**: Added `template` tag for documentation templates

### 2026-04-10 Security & Toolchain Updates

- **Dependency Security Remediation**: Added workspace-level remediation record for root `overrides`/`resolutions` hardening and toolchain updates ([[docs/security/dependency-security-remediation-2026-04]]).
- **Toolchain baseline updated**: Frontend Vite upgraded to `^8.0.8` with `@vitejs/plugin-react-swc` `^4.3.0`; backend Vitest upgraded to `^4.1.4` ([[apps/frontend/package.json]], [[apps/node-backend/package.json]]).
- **Test compatibility note**: Documented constructor-compatible Vitest 4 mock pattern for `yahoo-finance2` ([[apps/node-backend/tests/priceProviderService.test.js]]).

### 2026-04-02 KB Consistency Updates

- **Fixed broken wiki-links**: Corrected bare wiki-links in `docs/architecture/index.md` to use proper path-based links
- **Fixed duplicate entries**: Removed duplicate entries in `docs/performance/index.md`
- **Updated dates**: Fixed 2025 → 2026 date typos in 4 files (layout, recipientBankAccounts, rate-limiting, materialized-views)
- **Added aliases**: Added missing aliases field to 14 files (API docs, component docs, guide docs)
- **Added orphan docs**: Added missing links to `docs/adr/001`, `004`, `005`, `006`, `007`, `how-to-add-new-page`, `api-endpoint-matrix`
- **Enhanced index**: Added "For Computer Scientists" section with algorithm complexity references

### 2026-03-31 Updates

- **Portfolio Performance Snapshots**: New service (`portfolioPerformanceSnapshotService.js`) computes and stores daily portfolio performance snapshots in `portfolio_performance_snapshots` table. Includes per-class invested/value breakdowns (stocks+ETFs, crypto, metals), inflation-adjusted values, and spike sanitization. Migrations: `0023_portfolio_performance_snapshots`, `0024_per_class_invested_columns`.
- **Chart Data Downsampling**: LTTB (Largest-Triangle-Three-Buckets) algorithm added to `apps/frontend/src/utils/downsample.ts` for efficient rendering of large time-series charts. Reduces thousands of data points to a configurable threshold while preserving visual shape.
- **Database Schema Updates**: Added `metals_investments` and `metals_transactions` inheritance tables, `portfolio_performance_snapshots`, and `belgian_inflation_rates` to database schema diagrams.
- **System Architecture**: Updated to reflect new services (BelgianInflationService, PortfolioPerformanceSnapshotService) and external data sources (Statbel, Eurostat HICP).
- **Kinesis History Sanitization**: Admin endpoint `POST /api/admin/investments/kinesis/sanitize-history` for correcting isolated price spikes in persisted Kinesis history.
- **KB Comprehensive Audit**: Full cross-reference audit of 146 frontend items, 16 backend services, 13 repositories, 14 route files, 25 migrations, and database schema. 146 frontend items audited (114 fully documented, 12 partially, 20 not), services 14/16 fully documented, repos 7/13 fully documented.

## Project Overview

Vision is a comprehensive **financial transaction management application** supporting:

- **Transactions**: Income/expense tracking with categories and recipients
- **Planned Transactions**: Future scheduled and recurring payments
- **Portfolio**: Stocks, crypto, real estate, savings tracking
- **Tax**: Belgian tax profile and deduction tracking
- **Imports**: CSV bank statement imports with deduplication
- **Multi-workspace**: Support for multiple workspaces/users

### Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + Radix UI
- **Backend**: Node.js (Bun) + Express
- **Database**: PostgreSQL with Alembic migrations
- **Desktop**: Electron
- **Testing**: Vitest + React Testing Library

## Key Concepts

> [!info] Transaction Amounts
> - **Negative amounts**: Expenses (money leaving your account)
> - **Positive amounts**: Income (money entering your account)

> [!info] Categories
> Categories use `GENERAL:DETAIL` format:
> - `FOOD:GROCERIES`, `TRANSPORT:GAS`, `UTILITIES:ELECTRICITY`

> [!info] Bank Adapters
> Supported banks for import: Belfius, Revolut, KBC, SABB, Wise, Vision (internal format), Custom (configurable)
