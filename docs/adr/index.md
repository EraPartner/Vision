---
title: Architecture Decision Records Index
type: adr-index
status: active
date: 2026-04-23
updated: 2026-05-05
last_modified: 2026-05-05
tags: [adr, index, architecture, decisions, phase-1, phase-4, phase-5, phase-6, phase-7, security, dependency-slim-down, container-hardening, docker, backup, encryption, aead, aes-256-gcm, codeql, dependabot, rate-limiting, tailwind-v4, css-architecture, dependencies, ai, streaming, useSyncExternalStore, bug-hunt, recovery-hardening, updated-at-constraints, concurrent-backup]
description: Architecture Decision Records documenting significant technical choices and their rationale. May 2026: Phase 6.1–7 bug hunt recovery hardening (ADR-049), AI Chat module-level stream store (ADR-048), Tailwind CSS v4 migration (ADR-047).
aliases: [ADRs, decisions, architecture decisions]
---

# Architecture Decision Records

> [!abstract] What is an ADR?
> An ADR (Architecture Decision Record) documents a significant architectural decision along with its context, consequences, and status. Use these to understand **why** the system is built the way it is.

## All ADRs

```dataview
TABLE WITHOUT FILE status AS "Status", date AS "Date", description AS "Summary"
FROM "docs/adr"
WHERE !contains(file.name, "template") AND type = "adr"
SORT date DESC
```

## Active Decisions

```dataview
LIST WITHOUT FILE
FROM "docs/adr"
WHERE status = "Accepted"
SORT date DESC
```

## Creating a New ADR

See [[docs/adr/template\|the ADR template]] for the format to use when creating a new decision record.

> [!tip] When to Create an ADR
> - Choosing a new technology or framework
> - Changing a fundamental architectural pattern
> - Documenting a significant bug fix with architectural implications
> - Recording a decision that affects multiple parts of the system

## Recent Decisions

### 2026-05-05: Phase 6.1–7 Bug Hunt Recovery Hardening

[[docs/adr/049-phase-6-7-bug-hunt-recovery-hardening|ADR-049]] — Two coordinated fixes during the bug hunt phase. **Phase 6.1:** Corrective migration (0022) fixes 11 core tables that were created with nullable `updated_at` columns instead of `NOT NULL DEFAULT NOW()` (categories, recipients, recipient_bank_accounts, transactions, planned_transactions, planned_transaction_loan_schedule, exchange_rates, belgian_inflation_rates, asset_price_history, bank_statements, reconciliation_entries). Backfills NULLs from `created_at`, sets NOT NULL + DEFAULT NOW(). **Phase 7:** Electron hardening hardens backup/restore operations and fixes timeout/concurrent-backup issues: (1) `httpGet()` adds 10-second timeout to prevent hung connections, (2) `run()` helper reduces default `maxBuffer` from 200 MB to 10 MB (pg_dump streams via spawn, not buffered), (3) `backup:run` IPC handler adds `backupInFlight` flag to prevent concurrent backups, (4) `backup:restore` adds `dialog.showMessageBox()` confirmation before overwriting live data, (5) `backup:restore` pauses health watchdog during restore to prevent container restarts mid-operation.

### 2026-05-03: AI Chat Module-Level Stream Store

[[docs/adr/048-ai-chat-module-level-stream-store|ADR-048]] — Decouple AI chat SSE stream lifetime from React component lifecycle via singleton store (`aiChatStreamStore`). Streams now survive navigation; users can leave the chat page and the in-flight response continues. Store holds `{streams, aborts, listeners}` maps; React hooks subscribe via `useSyncExternalStore` and re-subscribe on return. Conversation pre-created before streaming (no PENDING bookkeeping). URL-backed selection (`?c=<id>`). Sidebar shows pulsing indicator for active streams via `useStreamingConversationIds()`. Consequence: uninterrupted streaming, deep-linkable conversations, live activity visibility even on other pages.

### 2026-05-03: Tailwind CSS v4 Migration & Dependency Upgrades

[[docs/adr/047-tailwind-v4-migration-dependency-upgrades|ADR-047]] — Upgrade Tailwind CSS from v3 (3.4.19) to v4 (4.2.4) with unified `@tailwindcss/postcss` plugin architecture. Key changes: PostCSS config now minimal (`'@tailwindcss/postcss': {}`); CSS entry point uses `@import "tailwindcss"` + `@config` directives; custom glass aliases declare full CSS rules (v4 restricts @apply to registered utilities). Font optimization: static weights (400/500/600) replace variable fonts. Also bump Sonner 1.7.4 → 2.0.7 (improved toast API) and Recharts 2.15.4 → 3.8.1 (retained for compatibility, inactive per ADR-028). All changes backward compatible; visual regression testing passed.

### 2026-05-02: Electron App Name & userData Migration

[[docs/adr/045-electron-app-name-userData-migration|ADR-045]] — Call `app.setName('Vision')` before any `app.getPath('userData')` usage to align Electron's `app.getName()` with the macOS bundle name (CFBundleName). Without this, `app.getPath('userData')` resolves to `~/Library/Application Support/vision-desktop/` instead of the canonical `Vision/`, triggering macOS Sonoma+ TCC prompts for cross-app data access. Worse, rename/reinstall lands in different userData dirs, generating fresh `embedded_compose/.env` with new `POSTGRES_PASSWORD` while the shared docker volume retains old password, causing authentication failures. Includes one-shot `migrateLegacyUserData()` IIFE that safely renames legacy dir and preserves docker-compose state. Non-fatal; backward compatible.

### 2026-04-29: Portfolio Snapshot Atomicity

[[docs/adr/043-portfolio-snapshot-atomicity|ADR-043]] — Wrap portfolio snapshot DELETE + batched INSERTs in a single PostgreSQL transaction to guarantee concurrent readers see either fully-old or fully-new snapshots via MVCC, never a torn/partial table. Fixes race condition during startup warmup where concurrent `/api/info/net-worth` requests read empty table after DELETE but before INSERT, triggering cache of zero portfolio value. Solution uses `withTransaction(...)` pattern already established in ADR-014.

### 2026-04-29: CodeQL + Dependabot Security Remediation

[[docs/adr/042-codeql-dependabot-remediation-2026-04|ADR-042]] — Triage and remediation of 7 Dependabot alerts (tar@6.2.1 CVEs) and 17 CodeQL/Trivy findings. Dependabot alerts resolved by bumping `electron-builder` `^25→^26` (tar@^7 transitive). CodeQL fixes: CORS no longer combines wildcard with `Allow-Credentials: true`; `attachmentRateLimiter` (60 req/min) and `spaRateLimiter` (600 req/min) added; CSV `separator` coerced via `String()` to prevent array type-confusion; `cleanup()` and `safeReadCsv()` add `TMP_ROOTS` allowlist guards; `stripHtml` loops until stable; `validate-locales.js` regex replaced with bounded line-by-line parse. Two false positives in `admin.js` suppressed with `// codeql[...]` inline comments and justification. Trivy pip alerts dismissed as `not_applicable` (gitignored venv).

### 2026-04-28: Saved Charts Schema Extension — Recipients, Variants, Time Buckets, Date Ranges

[[docs/adr/041-saved-charts-schema-extension|ADR-041]] — Extend `saved_charts` table with 5 new columns to support per-recipient aggregation and chart variant selection: `recipient_ids INTEGER[]`, `chart_variant TEXT`, `time_bucket TEXT`, `date_range_start DATE`, `date_range_end DATE`. Enables custom charts to render recipients (merchants) as independent series alongside categories, supporting multiple rendering styles (default, stacked, grouped) and time granularities (monthly/yearly) with optional date filtering. New `useRecipientPivot()` hook (keyed on currency, bucket, start, end) and `GET /api/aggregations/recipient-pivot` endpoint provide per-recipient spending series. CustomChart component renders correct chart primitive per (chart_type, chart_variant) combination; validation enforces valid pairs (no line stacked/grouped, no area grouped). Frontend form with live preview in CustomChartBuilderModal; SavedChartsSection refactored as full tab content in Statistics page. Migration 0017 additive with safe defaults. See [[docs/features/saved-charts|Saved Charts Feature]].

### 2026-04-28: Backup Format v2 AEAD Encryption with Per-Backup Salt

[[docs/adr/040-backup-format-v2-aead-encryption|ADR-040]] — Upgrade from AES-256-CBC with static salt (v1) to AES-256-GCM (AEAD) with per-backup random 16-byte salt and 12-byte IV. KDF upgraded to Scrypt(N=2^15, r=8, p=1) — doubled iteration count. AEAD provides confidentiality + authenticity; tampering detected on decryption. Per-backup entropy eliminates salt-reuse collisions across multiple backups. Backward compatible: v1 format still readable; v2 is default for new backups. Auto-detection via magic header; no user-visible format change. See [[docs/features/backup-coverage-audit|Backup Coverage Audit]] for format details.

### 2026-04-25: Docker Container Hardening

[[docs/adr/039-docker-container-hardening|ADR-039]] — Defense-in-depth at the container layer for the `app` service: non-root user (UID 1000), dropped Linux capabilities (CAP_DROP ALL), no-new-privileges flag, read-only root filesystem with selective writable carve-outs (`/tmp` tmpfs, `attachments_data` named volume), resource ceilings (4GB memory, 4 CPUs), and HEALTHCHECK via `/health` endpoint. CI image scanning via Trivy on every push and PR (CRITICAL,HIGH severity, exit-code 1, ignore-unfixed). Container compromise no longer implies host root; surfaces accidental writes immediately; attachments survive rebuilds. Justifies `--no-sandbox` for Puppeteer/Chromium (container itself is the boundary).

### 2026-04-25: FX Cache Startup Ordering & Kinesis EUR-to-USD Mapping

Fixed two critical startup and price-provider issues:

1. **Startup Sequence Ordering** — `warmExchangeRateCache()` and `backfillPortfolioHistoricalRates()` are now awaited via `Promise.all()` before `computeAndStoreSnapshots` proceeds. Prior fire-and-forget behavior caused snapshot/cache jobs to run before historical FX was populated, producing false "Historical FX missing" warnings during startup.

2. **Kinesis EUR Symbol Normalization** — Kinesis API only exposes USD-quoted symbols. Investments with EUR-denominated internal IDs (KAU_EUR/KAG_EUR/XAU_EUR/XAG_EUR/XPT_EUR/XPD_EUR) are now silently remapped to USD equivalents in `resolveKinesisConfig()` before the API fetch, eliminating "Kinesis: no data returned" startup warnings.

3. **`resolveRateWithFallback` Bug Fixes** — Fixed three bugs in historical FX fallback logic:
   - EUR rows always warned (EUR is filtered from `exchange_rates` saves, so check is now immediate)
   - Rows with `rowDate=null` incorrectly triggered fallback path (now return current rate without warning)
   - Short-circuit before ECB 90d + DB lookup when historical index lacked currency (now tries full fallback chain before warning)

See [[docs/integrations/currency-conversion|Currency Conversion]], [[docs/integrations/kinesis-price-provider|Kinesis Price Provider]], and [[docs/architecture/backend-architecture|Backend Architecture]].

### 2026-04-25: Dependency Slim-Down — Supply Chain Risk Reduction

[[docs/adr/038-dependency-slim-down-supply-chain-risk|ADR-038]] — Remove 9 packages (next-themes, pdfkit, react-resizable-panels, embla-carousel-react, vaul, date-fns, recharts, cors, compression) and replace with native/already-present alternatives. 5-phase approach: dead code removal, dead UI wrapper deletion, date-fns→Intl, recharts→visx consolidation, inline CORS + zlib middleware. Reduces transitive package count by ~80–120 and eliminates ~80 MB+ on disk.

### 2026-04-25: Secure File Download with Path Traversal Guard and RFC 5987

[[docs/adr/036-secure-file-download-with-path-traversal-and-rfc5987|ADR-036]] — Path traversal protection for file downloads via explicit path validation in `resolveAbsolutePath()`: reject any stored path that escapes the attachments root. RFC 5987 dual-encoding in `Content-Disposition` headers: ASCII fallback for legacy clients + UTF-8 encoding for modern ones. Enables safe serving of attachments with non-ASCII filenames (French, Chinese, etc.) without risk of directory traversal attacks. Zero performance impact; backward compatible.

### 2026-04-24: Remove Feature Flags

[[docs/adr/035-remove-feature-flags|ADR-035]] — Supersedes ADR-033. Remove the entire runtime-toggleable feature flag system (DB table, backend service/repo/routes, frontend page, i18n keys). All features are always enabled unconditionally. Decision rationale: no flags were ever toggled off in production, the system added maintenance surface without delivering value, and the product direction is toward all functionality being always on. Alembic migration `0011_drop_feature_flags` drops the table while preserving history via `0002_feature_flags`.

### 2026-04-24: Admin Environment — Unified Observability Hub

[[docs/adr/034-admin-environment|ADR-034]] — Consolidate admin tooling into a gated sidebar section with `/admin` overview, `/admin/db` database maintenance, `/admin/providers` data-source health, and `/admin/endpoints` endpoint liveness metrics. Gating via `adminMode` toggle in Settings (not a security boundary for single-user self-hosted app). Provider health uses passive tracking (success/error calls + table) + on-demand probes. Endpoint metrics via in-memory rolling window (15 min / 1 min buckets). Alert surface limited to admin pages only.

### 2026-04-24: Reaffirm visx/d3 over recharts

[[docs/adr/028-reaffirm-visx-over-recharts|ADR-028]] — Reaffirm visx + d3 as the chart primitive stack; reject TODO proposal to swap back to recharts. ADR-018 justified migration as a bundle reduction (~35kb), not an increase. Unused visx sub-packages (`@visx/hierarchy`, `@visx/text`, `@visx/tooltip`) removed as hygiene win. No visual-regression safety net exists for a port; future swaps require measured bundle evidence and visual-regression testing. Removes "Viz library dedupe" TODO block.

### 2026-04-23: Zustand Unified Settings Store

[[docs/adr/032-zustand-unified-settings-store|ADR-032]] — Consolidate three separate React contexts (AppSettingsContext, SettingsContext, ThemeContext) into a single Zustand store (`useSettingsStore`). Context Providers remain as thin wrappers for hydration and persistence side-effects. All consumers use `useShallow()` for slice selection to prevent re-renders on unrelated state changes. Eliminates prop drilling, improves performance, and provides a single source of truth for all user settings (app settings, dashboard exclusions, theme).

### 2026-04-23: Runtime-Toggleable Feature Flags

[[docs/adr/033-runtime-toggleable-feature-flags|ADR-033]] — Add persistent feature flags to PostgreSQL (table: `feature_flags`) with admin API endpoints (`/api/admin/feature-flags/:key`) to toggle features at runtime without redeployment. Replaces hard-coded environment variables (AI_CHAT_ENABLED, AGGREGATIONS_V2_ENABLED) with database-persisted toggles. Safe default behavior: `isEnabled(unknownKey)` returns false. Enables gradual rollouts, emergency disables, and admin control over feature availability.

### 2026-04-21: Express 5 Compatibility: path-to-regexp Override

[[docs/adr/029-express5-path-to-regexp-override|ADR-029]] — Override `path-to-regexp` to `^8.2.0` in `package.json` `overrides` and `resolutions` blocks. Legacy v0.1.13 (from Express 4) lacks `.match()` method required by Express 5's router (@2.2.0), causing `TypeError` at first route registration. Explicit override ensures all transitive dependencies resolve to v8.2.0+ with `.match()` support. Unblocks Express 5 router initialization; no code changes required.

### 2026-04-21: Alembic as Single Source of Schema Truth

[[docs/adr/027-alembic-single-source-of-schema|ADR-027]] — Delete `apps/node-backend/src/database/schemaInit.js` (1021 LOC, idempotent CREATE-IF-NOT-EXISTS) and make Alembic the sole owner of schema DDL. Node-backend boot shells out to `alembic upgrade head` via `child_process.execFile`; fails fast on non-zero exit. `schema_version` table removed — Alembic's `alembic_version` replaces it. `stampBaselineIfLegacy()` pre-upgrade hook rewrites pre-ADR-027 DBs (stamped at legacy revisions 0002–0032 in `alembic/legacy_versions/`) to `0001_initial` baseline without running DDL. Diff schemaInit output vs alembic head → back-fill missing objects as new revisions (expected 3–6). Enables real `downgrade()` support for Phase 5+ feature migrations. Electron packaging gains runtime dependency on bundled Python + alembic.

### 2026-04-20: Unified API Response Envelope

[[docs/adr/026-unified-api-response-envelope|ADR-026]] — All 108 HTTP endpoints return a discriminated union envelope keyed on `ok`: `{ ok: true, data, meta? }` on 2xx / `{ ok: false, error: { code, message, details? } }` on 4xx/5xx. Extends ADR-011's aggregation envelope to every route. New `wrapResponse` middleware exposes `res.ok(data, meta?)`; `createErrorHandler` rewritten to emit the failure shape. Frontend `api.ts` unwraps once and throws typed `ApiClientError`. Stable `ApiErrorCode` enum enables UI branching and i18n message keys. Request IDs propagate via `meta.requestId` for cross-log correlation. Breaking change rolled in one phase with no coexistence window; reversible entirely in code.

### 2026-04-20: Theme Variant System

[[docs/adr/025-theme-variant-system|ADR-025]] — Per-user theme variant selection with five curated color palettes (default, dracula, solarized, nord, high-contrast), each with light and dark sub-palettes. HSL token architecture enables runtime palette swaps via `document.documentElement.style.setProperty`. FOUC prevention via pre-React flash script reading from localStorage. Backend validation enforces variant ∈ {default,dracula,solarized,nord,high-contrast}, mode ∈ {light,dark,system,schedule}, and schedule times (if applicable) match HH:MM. Stored in `theme_settings` JSONB key with defaults applied at read time. Frontend live-preview with 500ms debounced persistence.

### 2026-04-19: Update Installer Checksum Verification

[[docs/adr/023-update-installer-checksum-verification|ADR-023]] — Verify SHA256 of downloaded Electron update installers against sibling `.sha256` artifacts on GitHub releases before extraction. Detects supply-chain tampering, corrupted downloads, and MITM attacks. Best-effort: missing `.sha256` files log warning but don't block. Requires release workflow to generate and upload checksum alongside installer binary.

### 2026-04-19: Electron Sandbox Hardening and Recovery

[[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022]] — Enable renderer sandbox (`sandbox: true`) for defense-in-depth isolation. Add single-instance lock to prevent multiple app instances. Implement backend health-polling at startup (200 attempts, 60s timeout) and 10-second watchdog after startup; 3 consecutive failures emit `backend:lost` IPC event. Error page shows on startup timeout; recovery buttons trigger `recovery:retry` IPC or open logs. Corrupt `settings.json` is quarantined with timestamp suffix instead of silently failing. Env vars: `VISION_HEALTH_POLL_ATTEMPTS`, `VISION_HEALTH_POLL_INTERVAL_MS`. New i18n keys: `app.errorPageTitle`, `app.errorPageMessage`, `app.errorPageRetry`, `app.errorPageOpenLogs`, `app.backendLost`.

### 2026-04-19: Decimal Arithmetic for Monetary Values

[[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]] — Adopt Decimal.js for all monetary calculations to eliminate floating-point drift. IEEE 754 floating-point cannot exactly represent decimal values (0.1 + 0.2 ≠ 0.3 in JavaScript). New `money.js` module exports `toDecimal`, `addAll`, `subtract`, `roundToCents`, `toNumber` functions. Banker's rounding (HALF_EVEN, 2 DP) matches PostgreSQL NUMERIC semantics. Scoped to split/aggregation hotspots in Phase 9; exportable to frontend in Phase 10+.

### 2026-04-17: Glass System Downgrade & Liquid Canvas Removal

[[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020]] — Performance optimization reducing glass-system blur tiers (6-12px max, selective modal-only usage) and removing liquid-canvas animated background + page transitions. Driver: Electron M1 GPU regression from sustained blur animations and ambient drift animation. Replaced with solid `bg-card/95` opacity layering + static grain overlay. Font subset optimization (`@fontsource` static weights vs. variable). Improves GPU utilization and battery life.

### 2026-04-17: Framer Motion Adoption

[[docs/adr/019-framer-motion-adoption|ADR-019]] — Framer Motion as canonical motion library for component choreography. Centralized motion system in `src/lib/motion.ts` exports durations, easings, spring configs, and `useReducedMotion()` hook. All motion consumers must respect `prefers-reduced-motion` via reduced-motion-aware variants. Page transitions, dialog/sheet entry, micro-interactions all follow unified timing and easing language aligned with liquid-glass aesthetic.

### 2026-04-17: visx/d3 Chart Migration

[[docs/adr/018-visx-d3-chart-migration|ADR-018]] — Migrated from Recharts to visx + d3 for low-level chart primitives. Saves ~35kb gzipped (Recharts ~50kb → visx ~15kb). New chart library in `src/components/charts/` (AreaChart, BarChart, PieChart, LineChart, Sparkline, Candlestick, TreemapChart) consumes design tokens directly, enabling full visual cohesion with liquid-glass aesthetic. All pages using charts rewritten to use new primitives.

### 2026-04-17: Liquid Glass Aesthetic & Design System

[[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017]] — Apple-inspired liquid-glass aesthetic with emerald + champagne-gold palette. Five-tier glass material hierarchy (`glass-thin` through `glass-elevated`), self-hosted Fraunces (display) + Inter Tight (body) fonts, centralized token system in `styles/tokens.css`. All 48 shadcn components retuned to tokens + glass defaults. Shell components (AppLayout, AppSidebar, PageTransition) revised with animated gradient meshes and premium surface hierarchy. Reduces visual debt, conveys brand confidence, and aligns aesthetic with financial app category.

### 2026-04-17: Aggregation Shadow Mode

[[docs/adr/016-aggregation-shadow-mode|ADR-016]] — Observational Express middleware (`createAggregationShadow`) shadows new `/api/aggregations/*` responses against legacy `/api/info/*` during Phase 2 → Phase 9 migration window. Default threshold 1¢, `queueMicrotask` fire-and-forget, swallows legacy failures, envelope-aware diff with Postgres NUMERIC string coercion. Removal gated on zero divergence logs across a full release cycle. References [[docs/adr/010-phase1-aggregation-strategy|ADR-010]] and [[docs/adr/011-phase2-aggregation-envelope-standard|ADR-011]].

### 2026-04-16: Recipient, Bank Account, and Category Uniqueness Constraints

[[docs/adr/015-recipient-bank-account-uniqueness|ADR-015]] — Database-level UNIQUE constraints on `recipients.normalized_name`, `recipient_bank_accounts.account_number`, and `categories(general, detail)`. Enforced at DB level for race-safe idempotent operations (create-or-get), conflict-free merge deduplication, and guaranteed data integrity. Implemented in Phase 6 via migration 0029.

### 2026-04-16: Atomic Merge Transactional Safety

[[docs/adr/014-atomic-merge-transactional-safety|ADR-014]] — Recipient merge uses single database transaction with `FOR UPDATE` row-level locking and race-safe `INSERT ... ON CONFLICT` deduplication. All FK reassignments (transactions, splits, planned, bank accounts) execute atomically; partial state is impossible. Implemented in Phase 6.

### 2026-04-16: Split Hard-Delete with split_audit Trail

[[docs/adr/013-split-hard-delete-with-audit-trail|ADR-013]] — Splits and split_payments are hard-deleted via ON DELETE CASCADE; lifecycle is preserved in an append-only split_audit table. Overpayment protection enforced at three layers: pure calc module validation, DB trigger (SQLSTATE 23514), audit trail. Implemented in Phase 4.

### 2026-04-16: Planned Execution Idempotency

[[docs/adr/012-planned-execution-idempotency|ADR-012]] — Use PostgreSQL UNIQUE constraint on (planned_transaction_id, executed_transaction_id) + explicit error detection (Postgres 23505) to guarantee idempotent planned transaction executions. Safe to retry; no duplicate rows on double-click or network retry. Implemented in Phase 3.

### 2026-04-16: Phase 2 Aggregation Envelope Standard

[[docs/adr/011-phase2-aggregation-envelope-standard|ADR-011]] — Standardized response envelope for all `/api/aggregations/*` endpoints with `{ data, meta: { source, computedAt } }` to transparently communicate whether results came from materialized views (cached, ~15min stale) or live computation.

### 2026-04-16: Phase 1 Aggregation Strategy

[[docs/adr/010-phase1-aggregation-strategy|ADR-010]] — Postgres-backed aggregations (materialized views + trigger-maintained tables) as the caching tier instead of Redis or in-process caches. Removes dependency on external caches while providing fast, deterministic dashboard aggregates. Driven by performance issues with the 1433-LOC infoRepository monolith.

### 2026-04-16: Timezone Policy

[[docs/adr/009-timezone-policy|ADR-009]] — Single deterministic timezone per environment for business math (dates, recurrence, loan schedules). Database stores UTC; application layer uses configurable `APP_TIMEZONE`. Materializes SQL aggregations using `AT TIME ZONE` literal.

### 2026-04-16: Performance Page Rewrite

[[docs/adr/008-performance-page-server-computed-response|ADR-008]] — Moved performance computations from frontend to backend, fixed contribution-adjusted heatmap formula.

## Related Documentation

- [[docs/architecture/index\|Architecture Overview]] - System diagrams
- [[docs/adr/002-database-schema\|Database Schema]] - Current schema design
- [[docs/guides/migrations\|Migration Guide]] - How schema changes are managed
