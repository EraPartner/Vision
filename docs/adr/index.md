---
title: Architecture Decision Records Index
type: adr-index
status: active
date: 2026-08-31
updated: 2026-09-04
last_modified: 2026-09-04
tags: [adr, index, architecture, decisions, phase-1, phase-4, phase-5, phase-6, phase-7, security, dependency-slim-down, container-hardening, docker, backup, encryption, aead, aes-256-gcm, codeql, dependabot, rate-limiting, tailwind-v4, css-architecture, dependencies, ai, streaming, useSyncExternalStore, bug-hunt, recovery-hardening, updated-at-constraints, concurrent-backup, ci-cd, secrets-scanning, supply-chain-security, gitleaks, deps-audit, trivy-scan, docker-compose-sync, named-volumes, data-loss, tags, tagging, transaction-tags, orthogonal-dimension, belgian-tax, exemption-brackets, own-home-credits, taxable-income-sources, audit-2026-05-11, disabled-dependents, regional-autonomy-factor, property-tax-centimes, etf-tob, reynders-routing, as-filed, audit-log, comparison, trend-strip, may-2026-audit, monetary-precision, decimal-enforcement, tx-hash-dedup, race-safe-dedup, portfolio-precision, import-precision, forecast-precision, timezone-consistency, snapshot-valuation-parity, fixed-income-accrual, real-estate-appreciation, net-worth-reconciliation, live-overlay, valuation-freshness, price-history, binance, quote-backfill, gap-fill, daily-granularity, sparsity, densify, saved-custom-parsers, custom-parser-configs, named-parsers, bank-label, generic-adapter-fallback, route-service-boundary, lint-enforcement, mv-recipient-monthly-drop, shared-utils, banker-rounding, global-rate-limiter, trusted-proxies, vision-dev, zip-bomb, response-cap, liquid-glass-v2, glass-materials, atmosphere-layer, command-palette, optimistic-updates, route-preload, premium-v3, rolling-number, money-typography, chart-scrub, chart-sync, shader-aurora, enhanced-effects, visual-effects-tiers, auto-adapt-display, fx-reduced, webgl, electron-native, macos, ipc, hiddeninset, vibrancy, system-accent, native-menu, dock-badge, csv-open-with, electronapi, june-2026, fx-attribution, historical-rates, ecb-full-history, purchase-date-rates, asset-gain, fx-gain, value-fx-neutral, portfolio-import, instrument-matching, type-normalizer, kind-discriminator, migration-0040, migration-0041, adr-078, adr-081, adr-082, monte-carlo, portfolio-projection, fundamentals-scorecard, chart-builder, technical-indicators, pillar-c, macro, macroeconomic, fred, dbnomics, eurostat, provider-pinned, db-data-editor, adr-101, xmin, optimistic-concurrency, audit-trail, skin-v2, dense-fintech, visual-redesign, feature-flag, theming, css-scoping, unlayered-css, inline-token-constraint, apple-refined, jewel-emerald, refined-geometry, glass-differentiation, hairlines, tabular-nums, press-feedback, motion-spring, insight-agent, anomaly-agent, detection-layer, narration-layer, insightsDigest, no-external-calls, ollama, native-runtime, postgresql-18, adr-110, adr-111, adr-112, adr-113]
description: Architecture Decision Records documenting significant technical choices and their rationale. 2026-07-11: ADR-110 NEW (detection-layer/narration-layer split for local-LLM insights — deterministic detection runs auto on page load, local-LLM narration gated behind an explicit click; scheduled background narration rejected as unprompted inference on unknown hardware, scoped to narration only; Statistics-panel + button-badge surfacing, no new dashboard banner/card; server-side pre-call so the model only narrates; ADR-024 no-external-calls guarantee + fetch-spy CI test extended to the narration tool). 2026-07-10: ADR-107 (Accounts budgeting UX remake — one anchor+delta balance definition on every surface with provenance lines, reconcile-as-a-flow, grouped hub, new /accounts/:id running-balance ledger route; look-changing scope user-signed-off) + ADR-108 (Portfolio accounts v2 — whole-lot broker tagging: every lot belongs to one broker account, sells consume same-broker lots, transfers are re-tags carrying basis; per-broker positions AND P&L as parity-tested partitions of the global engine; trade cash legs + moveHoldingService + snapshot value_by_account walk deleted; brokerage cash-statement import path kept and fixed; retires VITE_ENABLE_PER_ACCOUNT_HOLDINGS; supersedes UI scope of ADR-090/091/095/100/103); ADR-088/089/094/103 addenda — accounts-rewrite decisions D1–D5 (normalized implicit minting + case-insensitive identity + lifecycle + contract runbook; multi_currency_cash activated as per-currency balance series; guarded opening-balance anchor via transfer_source='opening'; per-account holdings flag committed to flip default-on as rewrite Phase E behind an 8-item prerequisite gate); round 2 same day D6–D9 — ADR-095 addendum (instrument-less brokerage rows → signed cash row), ADR-060 addendum (NUMERIC(18,4) domain money precision, widen siblings), ADR-109 NEW (flat investments schema canonical, one-time legacy conversion, supersedes ADR-004), D9 recurrence badge-only confirmed (TODO-level). 2026-06-23: ADR-105 (Apple-refined visual pass — bakes refined geometry + jewel accent + differentiated glass shadows into the BASE design, no flag; --radius 0.625rem; Card rounded-[0.75rem]; glass-regular vs glass-elevated shadow differentiation; jewel emerald primary/ring/sidebar-primary/sidebar-ring light 164 78% 26% / dark 160 74% 52%; ease-out-quint + ease-out-expo → cubic-bezier(0.32,0.72,0,1); press-feedback:active scale 0.97; tabular-nums letter-spacing -0.006em; 0.5px hairlines on glass-regular/premium-frame/glass-thin at @media min-resolution:2dppx; aurora/glass/hover/typography kept; VITE_SKIN_V2 gain/loss flag independent and unaffected; label-opacity text hierarchy deferred). ADR-104 (Dense-fintech visual skin behind a flag — ships the "skin-v2" redesign as CSS scoped under :root.skin-v2, toggled by VITE_SKIN_V2 (default OFF); applySkinV2Class() called pre-render; localStorage override + window.__setSkinV2 for dev comparison; UNLAYERED CSS wins over Tailwind layers; critical constraint: applyThemePalette() writes color tokens as inline styles — only structural tokens freely overridden from CSS; Phases 0–2 CSS-only implemented; Phase 3 component wiring in progress). 2026-06-20: ADR-103 (Gate per-account holdings UI behind a flag — VITE_ENABLE_PER_ACCOUNT_HOLDINGS default off). 2026-06-18: ADR-101 (Admin DB data editor — JetBrains-style table browser/editor under /admin/db/:table; 3 new admin endpoints (schema/rows/mutate); xmin optimistic concurrency; dryRun SQL preview; db_editor_audit table (migration 0059); matview auto-refresh on transactions/recipients/categories; bypass-domain-validation caveat documented). 2026-06-17: ADR-082 (Macroeconomic Indicators Data Vertical — adds FRED, Eurostat, and DBnomics macro adapters to the research aggregation layer; macro series are provider-pinned, never raced; two new endpoints GET /api/research/macro/search and GET /api/research/macro/series; storage boundary preserved: in-memory cache only, never persisted; keyless degradation to Eurostat catalog + DBnomics when FRED_API_KEY absent; Chart Builder unified search now surfaces Economic data alongside Markets results). 2026-06-16: ADR-081 (Research Analytics & Forecasting Expansion — delivers deferred Pillar C via Monte Carlo portfolio projection engine (drift/risk decoupled: RISK from aggregate NAV daily-return history, DRIFT per-holding blend of historical mean + forward analyst inputs via forwardBlend; parametric and block-bootstrap simulators; non-persisted, seeded PRNG; POST /api/research/portfolio-forecast); deepens Pillar B with freeform Chart Builder at /research/charts (multi-symbol, dual-axis, candlesticks, SMA/EMA/Bollinger/RSI/MACD client-side, presets, localStorage layout); deepens Pillar D with heuristic fundamentals scorecard (0-100/A-F, per-metric flags, missing-field-skip invariant; GET /api/research/scorecard) and extended fundamentals normalization across Yahoo/Finnhub/FMP adapters; adds optional provider param to GET /api/research/chart; openapi.yaml now 192 operations). ADR-079 (Multi-Provider Research Data Aggregation — Research section aggregates Yahoo + Twelve Data + Finnhub + FMP + Alpha Vantage behind priceProviderRegistry; capability map + persisted quota governor (token buckets) + type-aware cache TTLs route around rate limits; research data fetched live, never persisted to asset_price_history; user-confirmed ISIN-anchored cross-provider symbol map is the fool-proof anchor; unlocks pillars A/B strongly, D partially; C deferred designation superseded by ADR-081). 2026-06-15: ADR-078 (Portfolio CSV Import — parallel pipeline over generalizing budgeting import; symbol→name exact matching + mandatory review step for unresolved rows; conservative auto-commit; custom_parser_configs kind discriminator; migrations 0040+0041). 2026-06-12: ADR-075 (Visual-Effects Tiers and Per-Display Auto-Adaptation — replaces ADR-071's enhancedEffects boolean with reduced/standard/enhanced tier + autoAdaptDisplay; large-display heuristic >6M physical px drops tier to reduced automatically; VisualEffectsController tags <html> with fx-reduced/fx-static-atmosphere; ShaderAurora canvas capped at 640px; migration in migrateAppSettings; new settings.appearance.visualEffects*/autoAdaptDisplay* i18n keys, settings.general.enhancedEffects* removed). 2026-06-11: ADR-074 (FX attribution with purchase-date rates — invested capital locks at purchase-date FX rates; total gain = assetGain + fxGain; ECB full-history backfill since 1999; value_fx_neutral snapshot series; fx_rate_to_eur auto-resolved on transaction write). ADR-073 (Shared Portfolio Math in @vision/shared-utils — cost-basis calculators incl. FIFO/LIFO dispatch, accrued interest, buildInvestmentSummaryCore shared by backend service and frontend hooks; cost_basis_method setting wired end-to-end; frontend summaries FX-converted via useExchangeRates). 2026-06-10: ADR-072 (Electron-Native Desktop Integration — hiddenInset traffic lights, native menu bar + dock menu/badge, CSV drag/open-with import handoff, under-window vibrancy behind enhancedEffects toggle, system-accent color overlay, new window.electronAPI contextBridge surface; sandbox posture unchanged). ADR-071 (Premium v3 — RollingNumber/Money/DeltaPill shared components, chart scrub+sync, ChartSkeleton, PageTitleContext large-title collapse, palette v2 + recents, ShortcutsOverlay + go-to key sequences, animated tabs pill, workspace-aware aurora, ShaderAurora behind enhancedEffects toggle [boolean superseded by ADR-075 tier model], light-mode paper&ink tokens, per-widget dashboard hydration, optimistic CREATE). ADR-070 (Liquid Glass v2 — atmosphere layer restored, saturated blur tiers 12–32px, PageTransition re-added as enter-only spring, 45 cards migrated to glass-regular/elevated, CommandPalette, sidebar magic-move ActiveRail, optimistic transaction update/delete, route-chunk hover prefetch). 2026-06-01: ADR-069 (@vision/shared-utils monorepo package; banker's rounding canonical); ADR-068 (drop mv_recipient_monthly — unread MV, write-amplification removed, migration 0038); ADR-067 (enforce route→service boundary — no-repo-direct-from-route promoted to ERROR, 14 new thin service seams). Also June 2026 security hardening: global baseline rate limiter on /api (RATE_LIMIT_GLOBAL_MAX/WINDOW_MS), XFF trusted-proxy gating (TRUSTED_PROXIES), VISION_DEV fail-safe dev bypass, zip-bomb guard on restore, 5 MB response cap on price-provider fetches; snapshotBuilder split/return_of_capital events + APP_TIMEZONE day boundary; portfolioUnitMath.ts shared between Add/Edit dialogs; PlannedPaymentsPage migrated to VirtualDataTable + toast errors; tc() plural function in LanguageContext. Earlier: 2026-06-01 (ADR-066): Saved Named Custom CSV Parsers. 2026-05-31 (ADR-065): Daily gap-fill for dense asset price history. 2026-05-31 (ADR-064): Net Worth current value live overlay. 2026-05-29 (ADR-063): Admin auth token-or-open + CSRF guard supersedes ADR-037 RFC1918 IP-allowlist. May 2026 (ADR-061): Snapshot valuation parity. Prior May 2026: ADR-060 Monetary Precision; ADR-059 Belgian Tax historical year extensions; ADR-058 Belgian Tax historical year snapshots; ADR-057 Belgian Tax follow-up; ADR-056 Belgian Tax audit fixes; ADR-055/054/053 tax correctness; ADR-052 Transaction Tags; ADR-051 Docker Compose sync; ADR-050 CI supply chain; ADR-049 bug hunt; ADR-048 AI Chat stream store; ADR-047 Tailwind v4.
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
>
> - Choosing a new technology or framework
> - Changing a fundamental architectural pattern
> - Documenting a significant bug fix with architectural implications
> - Recording a decision that affects multiple parts of the system

## Recent Decisions

### 2026-09-04: Provisional latest portfolio snapshot

[[docs/adr/125-provisional-latest-portfolio-snapshot|ADR-125]] keeps the newest portfolio snapshot
raw until a later point enables two-sided spike detection. The performance API marks that point as
provisional, and the Performance page explains the status beside the chart controls.

### 2026-09-04: Net-worth history requires an active source

[[docs/adr/124-net-worth-active-source-span|ADR-124]] removes the inactive-transaction fallback
from the net-worth start-date probe. Inactive-only ledgers now return no snapshot history, while
investment snapshots can still establish the series.

### 2026-09-04: Effective-date current balances

[[docs/adr/123-effective-date-current-balances|ADR-123]] keeps future-dated ledger rows visible but
excludes them from current balances and history until their application-timezone date. Forecasts
receive those rows as a distinct, always-on scheduled-actual overlay.

### 2026-09-04: Normalized saved-chart filters

[[docs/adr/122-normalized-saved-chart-filters|ADR-122]] replaces saved-chart identifier arrays with
three foreign-keyed membership tables. The repository preserves the array-shaped API contract and
updates memberships atomically.

### 2026-09-04: Belgian tax Zustand slice

[[docs/adr/121-belgian-tax-zustand-slice|ADR-121]] moves persisted Belgian-tax state and atomic
actions into the shared settings store, narrows production subscriptions with selectors, and
coalesces multi-year comparison calculations while preserving the live current-year preview.

### 2026-09-04: Cash-flow cache date keys

[[docs/adr/120-cashflow-cache-date-keys|ADR-120]] converts the three forecast cache/history date
keys from free text to PostgreSQL `DATE`, preserves their string boundary contracts, and records
why the live logical `user_id` cache partition remains.

### 2026-09-04: Trigger-owned `updated_at` policy

[[docs/adr/119-trigger-owned-updated-at-policy|ADR-119]] makes the shared PostgreSQL trigger the
final authority for every mutable table with `updated_at`, and adds update timestamps to the three
audited mutable tables that lacked them.

### 2026-09-04: Balance-provenance lateral naming

[[docs/adr/118-balance-provenance-lateral-naming|ADR-118]] (Accepted) renames the account-level SQL lateral to `BALANCE_PROVENANCE_LATERAL`. It supersedes ADR-107's outdated name and clarifies that current balance values come from the per-currency helpers while the shared lateral returns provenance only.

### 2026-09-04: On-demand Electron vibrancy

[[docs/adr/117-on-demand-electron-vibrancy|ADR-117]] (Accepted) supersedes ADR-072's always-present macOS material. The typed renderer bridge now enables `under-window` vibrancy only while the effective visual-effects tier is enhanced and removes it for standard, reduced, cleanup, and auto-adapt downgrades.

### 2026-09-04: Native vibrancy substitutes persistent web blur

[[docs/adr/129-native-vibrancy-substitutes-persistent-web-blur|ADR-129]] (Accepted) makes the active native macOS material replace `backdrop-filter` on persistent cards, chrome, hero surfaces, the app top bar, and the full-window modal scrim. Thin navigation and thick transient panels keep local blur.

### 2026-08-31: Gated release candidate promotion and artifact attestation

[[docs/adr/116-gated-release-candidate-promotion|ADR-116]] (Accepted) publishes Docker candidates
without tags, scans and migration-tests the exact digest, and promotes only a passing index. The
release scan shares CI's accepted-risk file, while the DMG, native ZIP, and source-launcher ZIP gain
GitHub attestations before the release is created.

### 2026-08-31: Asynchronous import materialized-view refresh

[[docs/adr/115-asynchronous-import-materialized-view-refresh|ADR-115]] (Accepted) removes full materialized-view scans from the import response path. The pipeline awaits forecast-cache invalidation after transfer reconciliation, schedules one coalesced rebuild of the three managed views, and documents the resulting eventual-consistency boundary for MV-backed projections.

### 2026-08-31: Native deterministic Vision Demo runtime

[[docs/adr/114-native-deterministic-demo-runtime|ADR-114]] (Accepted) moves Vision Demo from its
separate Docker stack to the same bundled native runtime as production, while retaining a distinct
application-data directory, runtime identity, PostgreSQL cluster, port, roles, and database. A
disposable migrated build database produces a checksummed custom-format synthetic seed. Demo
launch activates it with exact row-count validation, detailed readiness, and automatic rollback.

### 2026-08-30: Native macOS runtime with optional Docker provider

[[docs/adr/113-native-macos-runtime|ADR-113]] (Accepted) makes a bundled, Vision-managed PostgreSQL
18.6 cluster, standalone migration executable, Bun backend, and Chrome Headless Shell the normal
macOS and packaged-Electron runtime. Docker Compose remains an explicit provider. Existing Docker
installations require an opt-in, fail-closed logical migration with all-table row counts,
attachment hashes, representative API/PDF verification, an authoritative cutover marker, and a
preserved stopped Docker rollback source.

### 2026-08-19: Retire the legacy split-payment overpayment trigger

[[docs/adr/112-retire-legacy-split-overpayment-trigger|ADR-112]] (Accepted) — Migration 0088
drops the pre-squash `trg_split_payment_overpayment_guard` before widening
`split_payments.amount`. Upgraded databases converge on the fresh-install trigger inventory, while
`splitService.addPayment` remains the authoritative exact four-decimal cap under a row lock.
This supersedes only ADR-013's database-trigger defense-in-depth claim.

### 2026-08-19: Complete legacy investment delete cascades during conversion

[[docs/adr/111-complete-legacy-investment-delete-cascades|ADR-111]] (Accepted) — Migration 0087
now recognizes orphan portfolio transactions as residue of the former inheritance-schema delete
path. It warns with their IDs, omits them from the canonical flat copy to match
`ON DELETE CASCADE`, preserves the source rows in `legacy_inh_*` for downgrade, and retains the
legacy sequence high-water mark so omitted IDs are not reused. Those rollback copies can later be
removed only through the verified-backup manual cleanup documented by ADR-109. This supersedes only ADR-109's
abort-on-orphan rule.

### 2026-07-11: Detection-layer / narration-layer split for local-LLM insights

[[docs/adr/110-insight-detection-narration-layer-split|ADR-110]] (Accepted) — Splits the AI insight /
anomaly agent into two layers by **cost**, not by feature. **Detection layer** (new subscriptions,
price creep, category outliers, cash forecast) is plain deterministic code — same cost class as any
page — so it runs automatically on page load with zero LLM involvement and zero hallucination risk;
also exposed as one read-only `insightsDigest` tool
(`apps/node-backend/src/services/aiChat/tools/insights.js`) whose return contract
(`{ subscriptionCreep:{new,priceChanges}, categoryOutliers, cashForecast }`, undismissed findings
only, pre-capped) is the sole cross-layer interface. **Narration layer** (local Ollama model explains
/ prioritizes / phrases the precomputed findings) is the only part that spends inference and the only
part gated behind an explicit click. Records why a **scheduled background narration job was rejected**
(unprompted inference on unknown hardware) and that this reasoning is scoped to narration only — the
detection layer is not click-gated. **Surfacing**: a Statistics-page panel (reuses
`RecurringDetectionPanel.tsx` Card UI) + a button badge counting undismissed findings; **no** new
dashboard banner/card (un-arbitrated `AppLayout.tsx` banner stacking + the `SuggestionCard` `6785a3eb`
removal precedent). Narration tool-call reliability resolved via the **server-side pre-call** approach
— the tool runs server-side before the model turn and its result is fed into context, so the model
only narrates and never decides whether to fetch. Extends ADR-024's no-external-calls guarantee and
its `global.fetch` fetch-spy CI test (`aiChatService.test.js`) to the new narration path. Builds on
[[docs/adr/024-local-llm-chat|ADR-024]]; does not weaken it.

### 2026-07-10: Accounts UX remake (budgeting) + Portfolio accounts v2 (broker tags)

[[docs/adr/107-accounts-budgeting-ux-remake|ADR-107]] (Accepted) — Restructures the budgeting accounts surface around **Glance → Overview → Ledger**: one anchor+delta balance definition (ADR-094 lateral, now returning `anchor_date` + `post_anchor_count`) on every surface — dashboard widget, hub, net-worth — each with a provenance subline ("as of {date} bank statement + {n} entries since"); reconciliation becomes a first-class per-account flow (statement input, drift preview, re-anchor / show-transactions-since exits) instead of a permanent red badge; the hub groups Cash & Savings · Portfolio · Liabilities · Archived with subtotals and a Net cash line; a new **`/accounts/:id` ledger route** (first consumer of the backend's per-account running-balance window) becomes the feature's center of gravity; lifecycle cleanup (one Close verb, merge preview + receipt, opening-balance field, dormant flags hidden). Look-changing scope explicitly signed off by the user; visual language (ADR-105) untouched. Driven by the 2026-07-10 four-pass accounts research (TODO.md).

[[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]] (Accepted) — Replaces the flag-hidden ADR-091/100 per-account holdings machinery with **whole-lot broker tagging**: every lot belongs to exactly one broker account (`portfolio_transactions.account_id`, migration 0052 — no new columns), sells consume same-broker lots, in-specie transfers/closes are bulk re-tags that carry basis — giving per-broker positions **and P&L** as partitions of the one global engine (Σ partitions ≡ global totals, parity-tested; tax stays global). Broker cash = reconcile-anchored ordinary ledger fed by real transfers + imported brokerage cash statements (kept and fixed per user decision) — **no synthesized trade cash legs**. Deleted rather than fixed: `tradeCashLegService`/ADR-090 legs, `moveHoldingService` + `/move`, snapshot `value_by_account` walk + by-account history endpoint/chart (rebuilt later on a persisted side table), and the `VITE_ENABLE_PER_ACCOUNT_HOLDINGS` flag itself — mooting ~9 filed bugs. Supersedes the UI scope of ADR-090/091/095/100 and retires ADR-103's flag. Implementation plan: TODO.md § Accounts feature research 2026-07-10 → 5️⃣.

### 2026-07-10: Accounts-rewrite decisions (D1–D5) — four addenda

Decision records for the accounts rewrite (TODO.md → Feature work → "Accounts rewrite").
D1/D4/D5 implementation landed with the 2026-07 integration (migrations 0066/0067/0069/0073/0075

- `accountService` + the opening-balance and reconcile endpoints).

**ADR-088 addendum** — D1: implicit account minting on INSERT stays, but identity becomes
case/whitespace-insensitive (`lower(btrim(name))` unique expression index; trigger + service
layer normalize identically; blanking `bank_account` on UPDATE now also NULLs `account_id`).
D5: lifecycle active → closed (`is_active=false` + new `closed_at`) → delete only when zero
referencing rows, with the 409 routing to close. Plus the **contract runbook**: four explicit
preconditions (parity query zero; all string readers flipped incl. `mv_bank_balances` re-grain;
import writes the FK; drop ships as its own revision with rollback) — until then no new code may
bind to the `bank_account` string. See [[docs/adr/088-account-entity|ADR-088 addendum]].

**ADR-089 addendum** — D2: `multi_currency_cash` is activated for real. Cash becomes per-currency
series keyed `(account_id, currency)`: anchor+delta partitions by currency, all consumers
(`getBankBalances`, hub, net worth, `mv_bank_balances`) move to that grain, statement/drift moves
to an `account_statement_balances` side table (per-currency drift), Revolut keeps ONE account with
per-currency rows (replaces the filed split-per-currency fix; Wise's split stays valid),
`accounts.currency` becomes the primary/reporting currency. Sequenced inside rewrite Phase C, not
piecemeal. See [[docs/adr/089-account-typed-model|ADR-089 addendum]].

**ADR-094 addendum (second)** — D4: guarded opening-balance anchor. A dedicated
`POST /api/accounts/:id/opening-balance` creates one server-stamped system row per
(account, currency): `amount 0`, `balance` = opening figure, `is_transfer=true`,
`transfer_source='opening'` (new CHECK value, `'trade'` precedent). The 2026-06-25 balance
write-protection stays intact — this is the single auditable exception; manual accounts can
finally anchor. See [[docs/adr/094-balance-reconciliation-drift|ADR-094 addendum]].

**ADR-103 addendum** — D3: go decision. `VITE_ENABLE_PER_ACCOUNT_HOLDINGS` flips default-on as
the final phase (E) of the accounts rewrite, strictly after identity (B) + balance engine (C),
gated on eight prerequisite fixes (per-account sell-units validation, moveHoldingService,
CloseAccountDialog NaN, snapshot split rescale, sanitize Σ-invariant, import dedup account_id,
instrument-less rows path, per-account snapshot persistence). Funding-account picker and bulk
lot-assignment UX come in scope with it; flag kept temporarily as kill-switch. See
[[docs/adr/103-per-account-holdings-ui-flag|ADR-103 addendum]].

**Round 2 (same day) — four rewrite-adjacent forks decided (D6–D9):**

**ADR-095 addendum** — D6: instrument-less brokerage rows (sleeve interest, unmapped
distributions, custody fees) route `'cash'` — one signed sleeve transaction auto-categorized by
row kind — instead of erroring "unresolved instrument". Accepted trade-off: they live in the
ledger, not per-instrument portfolio analytics. Resolves prerequisite 7 of the ADR-103 gate. See
[[docs/adr/095-brokerage-account-import|ADR-095 addendum]].

**ADR-060 addendum** — D7: NUMERIC(18,4) is the domain money precision. One alignment revision
widens the (15,2) sibling money columns (splits, planned, loan schedule,
`accounts.statement_balance`, raw tables); new money columns (incl. `account_statement_balances`
from the ADR-089 addendum) ship at (18,4). Rollback: re-narrow with USING round(). See
[[docs/adr/060-may-2026-monetary-precision-and-deduplication-audit|ADR-060 addendum]].

[[docs/adr/109-flat-investments-schema-canonical|ADR-109]] (Accepted) — D8: the flat
investments/portfolio_transactions shape is canonical; legacy inheritance installs (base + 7
children + view) convert via a guarded one-time migration (parity pre-flight, name-swap,
rename-based rollback, no-op on flat installs). Ends runtime `to_regclass` shape-probing (≥11
files), conditionally-absent FKs (incl. `portfolio_transactions.account_id` — needed by rewrite
Phase E), and the side-table idiom. Converted installs may remove the renamed rollback relations
through `alembic/manual/drop_adr109_legacy_relations/` only after a verified logical backup.
**Supersedes ADR-004** (status updated).

**D9 (no ADR — recorded on the TODO finding):** portfolio-transaction recurrence fields are
**badge-only by design**; the missing backend consumer is not a bug. Remaining work is hygiene:
interval whitelist, `end ≥ start` validation, clearing stale fields on recurrence-off.

[[docs/adr/127-no-synthetic-fx-for-account-totals|ADR-127]] (Accepted) — Account and merge-preview
converted totals exclude partitions whose source or requested target exchange rate is unavailable.
Affected APIs return native partitions plus explicit incomplete metadata; the UI shows the native
amounts and never presents a silent 1:1 fallback as a valid converted total.

[[docs/adr/128-account-currency-running-balances|ADR-128]] (Accepted) — Transaction running
balances are partitioned by both account and currency. The main Transactions page exposes explicit
Currency and Running balance columns; account-detail sparklines use only the account's declared
currency rather than connecting incomparable currency series.
