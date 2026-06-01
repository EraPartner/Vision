---
title: Architecture Decision Records Index
type: adr-index
status: active
date: 2026-04-23
updated: 2026-06-01
last_modified: 2026-06-01
tags: [adr, index, architecture, decisions, phase-1, phase-4, phase-5, phase-6, phase-7, security, dependency-slim-down, container-hardening, docker, backup, encryption, aead, aes-256-gcm, codeql, dependabot, rate-limiting, tailwind-v4, css-architecture, dependencies, ai, streaming, useSyncExternalStore, bug-hunt, recovery-hardening, updated-at-constraints, concurrent-backup, ci-cd, secrets-scanning, supply-chain-security, gitleaks, deps-audit, trivy-scan, docker-compose-sync, named-volumes, data-loss, tags, tagging, transaction-tags, orthogonal-dimension, belgian-tax, exemption-brackets, own-home-credits, taxable-income-sources, audit-2026-05-11, disabled-dependents, regional-autonomy-factor, property-tax-centimes, etf-tob, reynders-routing, as-filed, audit-log, comparison, trend-strip, may-2026-audit, monetary-precision, decimal-enforcement, tx-hash-dedup, race-safe-dedup, portfolio-precision, import-precision, forecast-precision, timezone-consistency, snapshot-valuation-parity, fixed-income-accrual, real-estate-appreciation, net-worth-reconciliation, live-overlay, valuation-freshness, price-history, binance, quote-backfill, gap-fill, daily-granularity, sparsity, densify, saved-custom-parsers, custom-parser-configs, named-parsers, bank-label, generic-adapter-fallback, route-service-boundary, lint-enforcement, mv-recipient-monthly-drop, shared-utils, banker-rounding, global-rate-limiter, trusted-proxies, vision-dev, zip-bomb, response-cap]
description: Architecture Decision Records documenting significant technical choices and their rationale. 2026-06-01: ADR-069 (@vision/shared-utils monorepo package; banker's rounding canonical); ADR-068 (drop mv_recipient_monthly — unread MV, write-amplification removed, migration 0038); ADR-067 (enforce route→service boundary — no-repo-direct-from-route promoted to ERROR, 14 new thin service seams). Also June 2026 security hardening: global baseline rate limiter on /api (RATE_LIMIT_GLOBAL_MAX/WINDOW_MS), XFF trusted-proxy gating (TRUSTED_PROXIES), VISION_DEV fail-safe dev bypass, zip-bomb guard on restore, 5 MB response cap on price-provider fetches; snapshotBuilder split/return_of_capital events + APP_TIMEZONE day boundary; portfolioUnitMath.ts shared between Add/Edit dialogs; PlannedPaymentsPage migrated to VirtualDataTable + toast errors; tc() plural function in LanguageContext. Earlier: 2026-06-01 (ADR-066): Saved Named Custom CSV Parsers. 2026-05-31 (ADR-065): Daily gap-fill for dense asset price history. 2026-05-31 (ADR-064): Net Worth current value live overlay. 2026-05-29 (ADR-063): Admin auth token-or-open + CSRF guard supersedes ADR-037 RFC1918 IP-allowlist. May 2026 (ADR-061): Snapshot valuation parity. Prior May 2026: ADR-060 Monetary Precision; ADR-059 Belgian Tax historical year extensions; ADR-058 Belgian Tax historical year snapshots; ADR-057 Belgian Tax follow-up; ADR-056 Belgian Tax audit fixes; ADR-055/054/053 tax correctness; ADR-052 Transaction Tags; ADR-051 Docker Compose sync; ADR-050 CI supply chain; ADR-049 bug hunt; ADR-048 AI Chat stream store; ADR-047 Tailwind v4.
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

### 2026-06-01: @vision/shared-utils Monorepo Package

[[docs/adr/069-shared-utils-monorepo-package|ADR-069]] — New Bun workspace package `@vision/shared-utils` (at `packages/shared-utils/`) holds pure helpers `money`, `slugify`, and `downsample` that were previously duplicated in `apps/node-backend/src/lib/` and `apps/frontend/src/lib/`. Both apps declare `"@vision/shared-utils": "workspace:*"` and use thin re-export shims at existing import paths for backward compatibility. As part of this consolidation, `roundMoney` is standardised to `Decimal.ROUND_HALF_EVEN` (banker's rounding) everywhere — the prior frontend copy used ROUND_HALF_UP. Banker's rounding matches PostgreSQL NUMERIC semantics and eliminates systematic per-transaction bias.

### 2026-06-01: Drop mv_recipient_monthly Materialized View

[[docs/adr/068-drop-mv-recipient-monthly|ADR-068]] — `mv_recipient_monthly` was never read after `agg_recipient_totals` (trigger-maintained, real-time) became the sole source for recipient-insights aggregation. The view added write-amplification: `aggregationRefresh.js` refreshed it on every transaction mutation with no consumer. Migration `0038_drop_mv_recipient_monthly.py` drops it; downgrade recreates the 24-month version. `aggregationRefresh.js` no longer schedules the refresh. The aggregation envelope `source` field is corrected from `'mv'` to `'live'`.

### 2026-06-01: Enforce Route → Service Boundary

[[docs/adr/067-enforce-route-service-boundary|ADR-067]] — All 15 Express route files must now import from `services/<domain>Service.js` seams only, never directly from repository modules. The ESLint rule `vision-local/no-repo-direct-from-route` is promoted from `warn` to `ERROR`. 14 new thin service modules complete the boundary for domains that lacked proper seams. These seams are thin at creation time — they exist to establish the correct dependency direction and provide stable extension points.

### 2026-06-01: Saved Named Custom CSV Parsers

[[docs/adr/066-saved-named-custom-csv-parsers|ADR-066]] — Users can now save a custom CSV column-mapping configuration under a unique name and reuse it across import sessions. Saved parsers persist in the new `custom_parser_configs` table (migration `0037`; `name TEXT UNIQUE`, `config_json JSONB`, `updated_at` maintained by shared trigger). The parser name doubles as the `bank_account` label on imported transactions — consistent with pre-configured bank adapters. Four new REST endpoints under `/api/import/parsers` (GET list, POST create 201/400/409, PATCH update 404/409, DELETE 204/404). Frontend: saved parsers appear in the bank-source dropdown with a Bookmark icon; selecting one loads its config; read-only summary with Edit / Delete (confirm); name field + "Save parser" in custom-config mode. Hook `useCustomParserConfigs` wraps React Query list + mutations under `['custom-parser-configs']`. Also fixes a latent `Unknown adapter` bug in `stageBatch` (`importPipeline/stage.js`): when `getAdapter(adapterName)` returns null and a `customConfig` is present, falls back to the `generic` adapter — mirrors the existing logic in `createAdapter()` and makes all free-form named custom imports robust.

### 2026-05-31: Daily Gap-Fill for Dense Asset Price History

[[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065]] — Portfolio and asset charts were rendering at ~biweekly granularity due to three compounding causes: (1) `priceProviderService` capped Binance history at 365 days, silently discarding older crypto history; (2) `needsHistoryRefresh` in `priceCache.js` only checked that stored dates spanned the window endpoints — interior gaps were never detected, so sparse-but-endpoint-spanning series were never re-fetched; (3) full backfill ran only at startup warmup (`backfillHistoricalAssetQuotes`), and the hourly `refreshActiveHoldingQuotes` only covered the last 7 days / open positions. Fix: (1) Binance now paginates with `startTime`/`endTime`/`limit=1000` across the full holding window (BINANCE_PAGE_LIMIT=1000, BINANCE_MAX_PAGES=30 runaway guard, window-aware cache key); (2) new `force` option on `fetchHistoricalPrices` bypasses the endpoint-only short-circuit; (3) new `holdingWindowsNeedBackfill` pure fn detects gaps exceeding GAP_THRESHOLD_DAYS=9 across all holding windows; new `backfillHoldingGaps` iterates all investments, detects gaps, and re-fetches with `force=true`; a daily `setInterval` in `warmup.js` runs `backfillHoldingGaps` and, if `filled > 0`, calls `computeAndStoreSnapshots()` so Performance/Net Worth charts reflect the denser history. One-time `quotes:densify` script heals existing sparse deployments without a restart. Open follow-up: Kinesis `timeFrame=60` unit ambiguity (minutes vs. days) not resolved — empirical diagnostic required before any change.

### 2026-05-31: Net Worth Current Value Live Overlay

[[docs/adr/064-net-worth-current-value-live-overlay|ADR-064]] — Closes the freshness gap left open by ADR-061. `computeAndStoreSnapshots()` is called only at startup; after the hourly `refreshActiveHoldingQuotes` runs, Dashboard and Performance update immediately via `portfolioSummaryService`, but Net Worth stayed frozen at the boot-time price. Fix mirrors the `_performanceHelpers.js` pattern: new `resolveLivePortfolioValue(targetCurrency)` helper (in `_liveSummary.js`) reads `totals.totalPortfolioValue` from the shared 60-second `portfolioSummaryCache`, and `infoRepositoryNetWorth.getNetWorthFromSnapshots` accepts an optional `liveInvestments` argument that overwrites the latest snapshot row's investments value before computing `current` and `monthlyChange`. Historical rows are untouched. Staleness budget: ≤5 min (net-worth cache TTL) vs. previously "frozen since startup". API response shape unchanged; no frontend changes. Graceful degradation: if the live resolution fails, returns the stored snapshot value. Known residual: historical unit-split days are not reconciled (tracked in TODO.md).

### 2026-05-29: Admin Auth Token-or-Open + CSRF Guard

[[docs/adr/063-admin-auth-csrf-guard|ADR-063]] — Supersedes ADR-037's RFC1918 IP-allowlist admin fallback. `adminAuth.js` is now token-or-open: when `ADMIN_AUTH_TOKEN` is set, enforce timing-safe Bearer; when unset, call `next()` immediately and rely on the docker-compose loopback binding plus the new `csrfGuard.js`. `createCsrfGuard` blocks cross-site state-changing browser requests via `Sec-Fetch-Site` (allow `same-origin`/`none`; reject `same-site`/`cross-site`) with an `Origin` allowlist fallback for browsers that omit `Sec-Fetch-Site`. Mounted before `adminAuthMiddleware` on `/api/admin`. Addresses codebase-audit-2026-05 finding `security.2`.

### 2026-05-29: Frontend Type-Check Gate Enforcement

[[docs/adr/062-frontend-typecheck-gate-enforcement|ADR-062]] — The CI `typecheck` job ran `bunx tsc --noEmit` against the solution-style `apps/frontend/tsconfig.json` (`files: []` + references), which without `tsc -b` type-checks **zero files** — a green gate validating nothing (proven: `--listFilesOnly` = 0 via `tsconfig.json` vs 435 via `tsconfig.app.json`). Combined with the SWC build (which never type-checks), 160 type errors across 57 files had accumulated on `main` undetected. Adds a real `typecheck` script (`tsc -p tsconfig.app.json --noEmit && tsc -p tsconfig.node.json --noEmit`), wires `ci.yml` + `release.yml` to it, bumps the frontend `target`/`lib` ES2020→ES2022, adds the missing `@types/d3-array`, and fixes all 160 errors — including real latent bugs (`TransactionsPage` optimistic edit wrote `bank_account` instead of `bank`; `SplitItem`/`OwedSummary` API types out of sync; react-router v7 / react-day-picker v10 / Zod v4 / vitest 4 API drift). Verification: `bun run typecheck` exits 0; 1,379 frontend + 1,983 backend tests pass; ESLint 0 errors. Follow-up: `calendar.tsx` carries a temporary `classNames` cast pending a full react-day-picker v10 styling migration (see `TODO.md`).

### 2026-05-18: Snapshot Valuation Parity with Live Summary

[[docs/adr/061-snapshot-valuation-parity|ADR-061]] — Rewrites `snapshotBuilder` non-unit asset valuation to mirror `portfolioSummaryService` formulas exactly, eliminating a 2,142.24 € discrepancy between Net Worth "Investments" and Portfolio Overview / Performance "Portfolio Value". Fixed-income (savings/bond): `value = runningInvested + accruedInterest` where accrual = `principal × (rate/100/365) × calendarDaysBetween(lastInterestDate ?? firstBuyDate, day)`. Real-estate: `value = runningInvested + cumulativeAppreciation` via `appreciation` transactions. Unit-based assets (stock/etf/crypto/metals): latest day uses `investments.current_price` directly instead of `asset_price_history` forward-fill, so the latest snapshot always reconciles with live summary. Legacy fallback preserved: investments with no buy transactions but a `current_price` and `active_from` still display that price rather than regressing to zero. Consequence: historical Net Worth chart redraws on next `computeAndStoreSnapshots` run (values typically shift upward as accrued interest and appreciation are now layered in). Regression tests lock parity: savings accrual, real-estate appreciation, bond interest payment resetting clock, latest-day unit price.

### 2026-05-14: Monetary Precision & Deduplication Audit

[[docs/adr/060-may-2026-monetary-precision-and-deduplication-audit|ADR-060]] — Systematic May 2026 audit extending Decimal.js enforcement to portfolio aggregation (FX multiplier), import precision (streaming running balance), and cash flow forecast accumulation (cumulative net flows). Adds `multiply()`, `divide()`, `roundMoney()` helpers to `money.js` and mirrors backend patterns in new frontend `decimal.ts`. Transaction hash deduplication via new `tx_hash` column (migration 0036) with UNIQUE constraint enables race-safe idempotent import via ON CONFLICT. Timezone consistency: all date bucketing now strictly uses APP_TIMEZONE per ADR-009 (month boundaries, calendar-day counts, recurrence expansion). Database robustness: graceful shutdown, connection retry safety (read-only only), per-account balance isolation, inheritance-aware queries. Import improvements: `prepareImport` now requires `unresolved > 0` for review (blank-recipient batches auto-commit removed). API hardening: rate limiter trusts loopback + link-local ranges, streaming respects backpressure, route coercion prevents array-type confusion, scheduled tasks prevented overlapping. Frontend correctness: stable component identities, animation timing from visible value, deterministic backpressure handling. Consequences: all accumulations exact to 2 DP, concurrent imports cannot create duplicates, month/day boundaries match user expectations, 80%+ test coverage maintained.

### 2026-05-12: Belgian Tax Historical Year Extensions

[[docs/adr/059-belgian-tax-historical-year-extensions|ADR-059]] — Extends ADR-058's historical year viewer with six related features. New persisted `belgian_tax_profile_snapshot_meta_v1` (JSONB sparse `Record<incomeYear, { frozenCalculation?, filing?, history? }>`) sits alongside the existing snapshots map. New context surface: `metaForYear`, `isYearFiled`, `getFrozenCalculation`, `displayCalculationForYear` (prefers frozen over live recompute), `getSnapshotHistory`, `freezeCalculation`/`unfreezeCalculation`, `markYearAsFiled`/`unmarkYearAsFiled`. Filing implies freezing (engine-drift protection); unfiling preserves the frozen calc (clerical correction). `updateSnapshot` and `createSnapshotFromLive` now append `'created'`/`'patched'` entries to the meta history (diff-only, trimmed at 200 entries/year). New components: `MultiYearTrendStrip` (compact clickable year tiles), `YearComparisonCard` (side-by-side delta table with picker), `YearActionsMenu` (dropdown for freeze/file/history/export), `MarkAsFiledDialog`, `SnapshotHistoryDialog`. `HistoricalYearBanner` extended with `filed` and `frozen` modes; `TaxProfileDialog` gates filed-year edits behind an explicit "Amend this filed year" confirmation. `TaxOverviewPage` and `PortfolioTaxPage` share `resolveHistoricalBannerMode` (priority `filed > frozen > snapshot > estimate`) and both use `displayCalculationForYear` so filed numbers don't drift retroactively. New pure module `exportTaxYearCsv` emits a three-section CSV (metadata, profile inputs, calculation) via the existing `downloadBlob` helper. +12 context tests, +2 hook tests, +6 CSV tests; locale parity (en/nl) maintained; typecheck clean.

### 2026-05-11: Belgian Tax Historical Year Snapshots

[[docs/adr/058-belgian-tax-historical-year-snapshots|ADR-058]] — Historical year viewer for `/tax` and `/portfolio/tax`. New persisted `belgian_tax_profile_snapshots_v1` (JSONB `Record<incomeYear, BelgianTaxProfile>`) frozen automatically when the live profile's `taxYear` advances. New `viewedYear` transient state on `BelgianTaxProfileContext` with helpers `profileForYear`, `calculationForYear`, `snapshotExistsForYear`, `createSnapshotFromLive`, `updateSnapshot`, `isViewingHistorical`. New `useAvailableTaxYears()` hook unions snapshot years, portfolio tax/fee transaction years, and taxable-income-category years. New `TaxYearSwitcher` dropdown + `HistoricalYearBanner` (snapshot vs estimate modes). `TaxProfileDialog` gains `targetYear` prop with historical-edit warning banner; `taxYear` is stripped from patches so the snapshot's year stays pinned. Live recompute via `computeBelgianPIT` (no calc snapshot); soft-lock allows past edits behind a warning. Engine drift and point-in-time exchange rates are documented limitations. +28 frontend tests across provider, hook, switcher, and page integrations; typecheck clean.

### 2026-05-11: Belgian Tax Audit Follow-up (PwC, May 2026)

[[docs/adr/057-belgian-tax-audit-followup-pwc-may-2026|ADR-057]] — Second-pass audit follow-up to ADR-056, six fixes covering portfolio and budgeting tax calculations: (1) **TOB shares cap correction** — €4,000 → €1,600 for the 0.35% rate across IY 2024/2025/2026 (cap is per-rate not per-instrument; only the 1.32% accumulating-fund rate carries the €4,000 cap). (2) **CGT effective-date docs** — Comments and docstrings corrected from "1 June 2026" to "1 January 2026"; broker withholding starts 1 June 2026 but the taxable event covers the full year. Carryforward docstring tightened (annual +€1k/year when used <10%, cumulative €5k cap so annual exemption can grow to €15k after five unused years). (3) **Direct bonds → CGT from IY 2026** — `PortfolioTaxPage` gain-split routes `assetClass='bond'` AND `subjectToReynders=false` into the 10% CGT pool when CGT is active. Pre-2026 keeps the existing exempt branch. (4) **Reynders interest-portion split** — New optional `reyndersInterestPortion` (range 0–1, default 1.0) on `InvestmentSummary` and `TaxClassificationEntry`. Reynders is now taxed only on `gain × portion`; the remainder routes to the 10% CGT pool from IY 2026 onwards (EY: "the remaining capital gains will fall under the 10% capital gains tax"). UI: new "Interest portion (%)" input in `PortfolioTaxAdjustmentsDialog`. (5) **Year-aware `SuggestedDeductionsCard`** — All hardcoded `0.30`/`0.25`/`0.80` literals and the deprecated `CHILDCARE_DAILY_CAP_2025` import replaced with `getTaxTable(profile.taxYear)` lookups. (6) **Per-residence centimes override** — Optional `cadastralCentimesOverride` (main residence) and `centimesOverride` (additional residences) let users refine property-tax estimates beyond the regional median. Consequences: PwC AY 2026 sample still reproduced within €0.30; portfolio tax handles large equity trades, mixed bond funds, and post-2026 direct-bond regime correctly; +10 regression tests; 1,331 frontend tests pass; typecheck clean.

### 2026-05-11: Belgian Tax Audit Fixes (AY 2026)

[[docs/adr/056-belgian-tax-audit-fixes-ay2026|ADR-056]] — Comprehensive audit fixes aligning Belgian PIT, property tax, and portfolio tax with PwC AY 2026 guidance. Eight coordinated changes: (1) **Exemption-bracket recalibration** — IY 2025 boundaries confirmed as 25% (€0–€11,460), 30% (€11,460–€16,320), 40% (€16,320–€27,190), 45% (€27,190–€49,840), 50% (€49,840+); IY 2024 indexed back 3.15%; IY 2026 inherits IY 2025. (2) **Regional autonomy factor** — New 0.9951–0.9945 multiplier per region applied to federal PIT after credits, before communal surcharge. (3) **Property-tax centimes reductions** — Flanders 1450→1100, Wallonia 4000→3300, Brussels 4500→4200 to align with typical 20–50%-of-indexed-CI range. (4) **Disabled-dependent count doubling** — New optional fields `dependentChildrenDisabled` and `dependentOtherPersonsDisabled` per CIR-92 art. 132 4° / 136 (disabled dependent counts as TWO). (5) **Child-under-3 forfeiture** — Supplement skipped if childcare reduction claimed (mutually exclusive per CIR-92 art. 132bis). (6) **ETF TOB default flip** — Accumulating (1.32%) now default, not distributing (0.12%), to match 80%+ retail market. (7) **Reynders override routing** — New optional `subjectToReynders` per-investment setting to disambiguate bonds (exempt) vs. ETFs (Reynders). (8) **New settings-backed hook** — `usePortfolioTaxClassifications` persists ETF structure and Reynders overrides to `portfolio_tax_classifications_v1` JSONB key. Consequences: PIT calculations now align with PwC worked examples, regional differences are explicit, property tax estimates land inside typical ranges, disabled dependents correctly counted, ETF defaults match market reality, users have explicit control over ambiguous tax routing.

### 2026-05-08: Transaction Tags as Orthogonal Dimension

[[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]] — Add freeform tagging system to transactions and planned transactions as a second, orthogonal classification dimension alongside categories. Solves the problem of cross-cutting groupings (trips, projects, events) without restructuring the category hierarchy. Three tables: `tags` (global registry with unique slugs), `transaction_tags`, `planned_transaction_tags` (junctions with CASCADE). Soft-delete via `is_active = false` + atomic reactivation preserves junction history. Slug normalisation: lowercase, trim, collapse whitespace to `-`, strip non-alphanum. Read path uses batched second query (`WHERE transaction_id = ANY($1)`). Filter semantics: OR (transaction matches if it has *any* selected tags). Bulk-tag endpoint `/api/transactions/bulk-tag` operates in single DB transaction (all-or-nothing). Planned transaction tags inherited by executed copies inside same `withTransaction` block. Consequences: users can group transactions across categories without modifying hierarchy, tags auto-create on first use, soft-delete + reactivation preserves history, bulk-tag toolbar enables batch operations. Trade-offs: slug immutability (renames require new tag + bulk migration), Unicode dropped in v1, two-query read adds latency proportional to batch size.

### 2026-05-07: Docker Compose Named Volumes Sync Policy

[[docs/adr/051-docker-compose-sync-named-volumes|ADR-051]] — Enforce strict synchronization of named volumes between root `docker-compose.yml` and embedded `packaging/electron/resources/docker-compose.yml` via CI gates. Automated `verify-compose-sync` job in ci.yml runs on every push/PR, extracting and comparing named volumes from both files; fails if divergence detected. Same check added to release.yml `verify` job before any packaging. Prevents v1.0.2 data-loss bug where missing attachment volume in embedded Electron compose caused attachments to vanish on updates. Consequences: new named volumes blocked from merging until both files are synced, release safety guaranteed, developer awareness via CI failure message.

### 2026-05-07: CI Supply Chain Security Tooling

[[docs/adr/050-ci-supply-chain-security-tooling|ADR-050]] — Four-layer supply chain hardening via CI automation: (1) **Secrets scan** — gitleaks in CI (`secrets-scan` job, full history on every push/PR) + pre-commit hook (local dev, staged changes only), blocks merge if credentials/tokens/keys found; (2) **Dependency audit** — `bun audit --audit-level=high` fails on HIGH/CRITICAL vulns, dependency overrides for basic-ftp/ip-address/postcss pinned to safe versions; (3) **Container scan** — Trivy scans Docker image for OS package CVEs, blocks merge if HIGH/CRITICAL found; (4) **Electron hardening** — `session.defaultSession.setPermissionRequestHandler` denies all renderer permission requests (camera, mic, geolocation, clipboard), strict CSP on error.html (no unsafe-inline). Consequences: secrets never reach CI, transitive dependency exploits blocked, container images patched, renderer cannot escalate to system resources even if XSSed. Friction: developer pre-commit hook setup, CI latency +2-3 min, gitleaks false-positive maintenance.

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
