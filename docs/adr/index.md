---
title: Architecture Decision Records Index
type: adr-index
status: active
date: 2026-10-19
updated: 2026-10-19
last_modified: 2026-10-08
tags: [adr, index, architecture, decisions, phase-1, phase-4, phase-5, phase-6, phase-7, security, dependency-slim-down, container-hardening, docker, backup, encryption, aead, aes-256-gcm, codeql, dependabot, rate-limiting, tailwind-v4, css-architecture, dependencies, ai, streaming, useSyncExternalStore, bug-hunt, recovery-hardening, updated-at-constraints, concurrent-backup, ci-cd, secrets-scanning, supply-chain-security, gitleaks, deps-audit, trivy-scan, docker-compose-sync, named-volumes, data-loss, tags, tagging, transaction-tags, orthogonal-dimension, belgian-tax, exemption-brackets, own-home-credits, taxable-income-sources, audit-2026-05-11, disabled-dependents, regional-autonomy-factor, property-tax-centimes, etf-tob, reynders-routing, as-filed, audit-log, comparison, trend-strip, may-2026-audit, monetary-precision, decimal-enforcement, tx-hash-dedup, race-safe-dedup, portfolio-precision, import-precision, forecast-precision, timezone-consistency, snapshot-valuation-parity, fixed-income-accrual, real-estate-appreciation, net-worth-reconciliation, live-overlay, valuation-freshness, price-history, binance, quote-backfill, gap-fill, daily-granularity, sparsity, densify, saved-custom-parsers, custom-parser-configs, named-parsers, bank-label, generic-adapter-fallback, route-service-boundary, lint-enforcement, mv-recipient-monthly-drop, shared-utils, banker-rounding, global-rate-limiter, trusted-proxies, vision-dev, zip-bomb, response-cap, liquid-glass-v2, glass-materials, atmosphere-layer, command-palette, optimistic-updates, route-preload, premium-v3, rolling-number, money-typography, chart-scrub, chart-sync, shader-aurora, enhanced-effects, visual-effects-tiers, auto-adapt-display, fx-reduced, webgl, electron-native, macos, ipc, hiddeninset, vibrancy, system-accent, native-menu, dock-badge, csv-open-with, electronapi, june-2026, fx-attribution, historical-rates, ecb-full-history, purchase-date-rates, asset-gain, fx-gain, value-fx-neutral, portfolio-import, instrument-matching, type-normalizer, kind-discriminator, migration-0040, migration-0041, adr-078, adr-081, adr-082, monte-carlo, portfolio-projection, fundamentals-scorecard, chart-builder, technical-indicators, pillar-c, macro, macroeconomic, fred, dbnomics, eurostat, provider-pinned, db-data-editor, adr-101, xmin, optimistic-concurrency, audit-trail, skin-v2, dense-fintech, visual-redesign, feature-flag, theming, css-scoping, unlayered-css, inline-token-constraint, apple-refined, jewel-emerald, refined-geometry, glass-differentiation, hairlines, tabular-nums, press-feedback, motion-spring, insight-agent, anomaly-agent, detection-layer, narration-layer, insightsDigest, no-external-calls, ollama, native-runtime, postgresql-18, adr-110, adr-111, adr-112, adr-113, recurrence, adr-130]
description: "Architecture Decision Records documenting significant technical choices and their rationale. 2026-07-11: ADR-110 NEW (detection-layer/narration-layer split for local-LLM insights — deterministic detection runs auto on page load, local-LLM narration gated behind an explicit click; scheduled background narration rejected as unprompted inference on unknown hardware, scoped to narration only; Statistics-panel + button-badge surfacing, no new dashboard banner/card; server-side pre-call so the model only narrates; ADR-024 no-external-calls guarantee + fetch-spy CI test extended to the narration tool). 2026-07-10: ADR-107 (Accounts budgeting UX remake — one anchor+delta balance definition on every surface with provenance lines, reconcile-as-a-flow, grouped hub, new /accounts/:id running-balance ledger route; look-changing scope user-signed-off) + ADR-108 (Portfolio accounts v2 — whole-lot broker tagging: every lot belongs to one broker account, sells consume same-broker lots, transfers are re-tags carrying basis; per-broker positions AND P&L as parity-tested partitions of the global engine; trade cash legs + moveHoldingService + snapshot value_by_account walk deleted; brokerage cash-statement import path kept and fixed; retires VITE_ENABLE_PER_ACCOUNT_HOLDINGS; supersedes UI scope of ADR-090/091/095/100/103); ADR-088/089/094/103 addenda — accounts-rewrite decisions D1–D5 (normalized implicit minting + case-insensitive identity + lifecycle + contract runbook; multi_currency_cash activated as per-currency balance series; guarded opening-balance anchor via transfer_source='opening'; per-account holdings flag committed to flip default-on as rewrite Phase E behind an 8-item prerequisite gate); round 2 same day D6–D9 — ADR-095 addendum (instrument-less brokerage rows → signed cash row), ADR-060 addendum (NUMERIC(18,4) domain money precision, widen siblings), ADR-109 NEW (flat investments schema canonical, one-time legacy conversion, supersedes ADR-004), D9 recurrence badge-only confirmed (TODO-level). 2026-06-23: ADR-105 (Apple-refined visual pass — bakes refined geometry + jewel accent + differentiated glass shadows into the BASE design, no flag; --radius 0.625rem; Card rounded-[0.75rem]; glass-regular vs glass-elevated shadow differentiation; jewel emerald primary/ring/sidebar-primary/sidebar-ring light 164 78% 26% / dark 160 74% 52%; ease-out-quint + ease-out-expo → cubic-bezier(0.32,0.72,0,1); press-feedback:active scale 0.97; tabular-nums letter-spacing -0.006em; 0.5px hairlines on glass-regular/premium-frame/glass-thin at @media min-resolution:2dppx; aurora/glass/hover/typography kept; VITE_SKIN_V2 gain/loss flag independent and unaffected; label-opacity text hierarchy deferred). ADR-104 (Dense-fintech visual skin behind a flag — ships the \"skin-v2\" redesign as CSS scoped under :root.skin-v2, toggled by VITE_SKIN_V2 (default OFF); applySkinV2Class() called pre-render; localStorage override + window.__setSkinV2 for dev comparison; UNLAYERED CSS wins over Tailwind layers; critical constraint: applyThemePalette() writes color tokens as inline styles — only structural tokens freely overridden from CSS; Phases 0–2 CSS-only implemented; Phase 3 component wiring in progress). 2026-06-20: ADR-103 (Gate per-account holdings UI behind a flag — VITE_ENABLE_PER_ACCOUNT_HOLDINGS default off). 2026-06-18: ADR-101 (Admin DB data editor — JetBrains-style table browser/editor under /admin/db/:table; 3 new admin endpoints (schema/rows/mutate); xmin optimistic concurrency; dryRun SQL preview; db_editor_audit table (migration 0059); matview auto-refresh on transactions/recipients/categories; bypass-domain-validation caveat documented). 2026-06-17: ADR-082 (Macroeconomic Indicators Data Vertical — adds FRED, Eurostat, and DBnomics macro adapters to the research aggregation layer; macro series are provider-pinned, never raced; two new endpoints GET /api/research/macro/search and GET /api/research/macro/series; storage boundary preserved: in-memory cache only, never persisted; keyless degradation to Eurostat catalog + DBnomics when FRED_API_KEY absent; Chart Builder unified search now surfaces Economic data alongside Markets results). 2026-06-16: ADR-081 (Research Analytics & Forecasting Expansion — delivers deferred Pillar C via Monte Carlo portfolio projection engine (drift/risk decoupled: RISK from aggregate NAV daily-return history, DRIFT per-holding blend of historical mean + forward analyst inputs via forwardBlend; parametric and block-bootstrap simulators; non-persisted, seeded PRNG; POST /api/research/portfolio-forecast); deepens Pillar B with freeform Chart Builder at /research/charts (multi-symbol, dual-axis, candlesticks, SMA/EMA/Bollinger/RSI/MACD client-side, presets, localStorage layout); deepens Pillar D with heuristic fundamentals scorecard (0-100/A-F, per-metric flags, missing-field-skip invariant; GET /api/research/scorecard) and extended fundamentals normalization across Yahoo/Finnhub/FMP adapters; adds optional provider param to GET /api/research/chart; openapi.yaml now 192 operations). ADR-079 (Multi-Provider Research Data Aggregation — Research section aggregates Yahoo + Twelve Data + Finnhub + FMP + Alpha Vantage behind priceProviderRegistry; capability map + persisted quota governor (token buckets) + type-aware cache TTLs route around rate limits; research data fetched live, never persisted to asset_price_history; user-confirmed ISIN-anchored cross-provider symbol map is the fool-proof anchor; unlocks pillars A/B strongly, D partially; C deferred designation superseded by ADR-081). 2026-06-15: ADR-078 (Portfolio CSV Import — parallel pipeline over generalizing budgeting import; symbol→name exact matching + mandatory review step for unresolved rows; conservative auto-commit; custom_parser_configs kind discriminator; migrations 0040+0041). 2026-06-12: ADR-075 (Visual-Effects Tiers and Per-Display Auto-Adaptation — replaces ADR-071's enhancedEffects boolean with reduced/standard/enhanced tier + autoAdaptDisplay; large-display heuristic >6M physical px drops tier to reduced automatically; VisualEffectsController tags <html> with fx-reduced/fx-static-atmosphere; ShaderAurora canvas capped at 640px; migration in migrateAppSettings; new settings.appearance.visualEffects*/autoAdaptDisplay* i18n keys, settings.general.enhancedEffects* removed). 2026-06-11: ADR-074 (FX attribution with purchase-date rates — invested capital locks at purchase-date FX rates; total gain = assetGain + fxGain; ECB full-history backfill since 1999; value_fx_neutral snapshot series; fx_rate_to_eur auto-resolved on transaction write). ADR-073 (Shared Portfolio Math in @vision/shared-utils — cost-basis calculators incl. FIFO/LIFO dispatch, accrued interest, buildInvestmentSummaryCore shared by backend service and frontend hooks; cost_basis_method setting wired end-to-end; frontend summaries FX-converted via useExchangeRates). 2026-06-10: ADR-072 (Electron-Native Desktop Integration — hiddenInset traffic lights, native menu bar + dock menu/badge, CSV drag/open-with import handoff, under-window vibrancy behind enhancedEffects toggle, system-accent color overlay, new window.electronAPI contextBridge surface; sandbox posture unchanged). ADR-071 (Premium v3 — RollingNumber/Money/DeltaPill shared components, chart scrub+sync, ChartSkeleton, PageTitleContext large-title collapse, palette v2 + recents, ShortcutsOverlay + go-to key sequences, animated tabs pill, workspace-aware aurora, ShaderAurora behind enhancedEffects toggle [boolean superseded by ADR-075 tier model], light-mode paper&ink tokens, per-widget dashboard hydration, optimistic CREATE). ADR-070 (Liquid Glass v2 — atmosphere layer restored, saturated blur tiers 12–32px, PageTransition re-added as enter-only spring, 45 cards migrated to glass-regular/elevated, CommandPalette, sidebar magic-move ActiveRail, optimistic transaction update/delete, route-chunk hover prefetch). 2026-06-01: ADR-069 (@vision/shared-utils monorepo package; banker's rounding canonical); ADR-068 (drop mv_recipient_monthly — unread MV, write-amplification removed, migration 0038); ADR-067 (enforce route→service boundary — no-repo-direct-from-route promoted to ERROR, 14 new thin service seams). Also June 2026 security hardening: global baseline rate limiter on /api (RATE_LIMIT_GLOBAL_MAX/WINDOW_MS), XFF trusted-proxy gating (TRUSTED_PROXIES), VISION_DEV fail-safe dev bypass, zip-bomb guard on restore, 5 MB response cap on price-provider fetches; snapshotBuilder split/return_of_capital events + APP_TIMEZONE day boundary; portfolioUnitMath.ts shared between Add/Edit dialogs; PlannedPaymentsPage migrated to VirtualDataTable + toast errors; tc() plural function in LanguageContext. Earlier: 2026-06-01 (ADR-066): Saved Named Custom CSV Parsers. 2026-05-31 (ADR-065): Daily gap-fill for dense asset price history. 2026-05-31 (ADR-064): Net Worth current value live overlay. 2026-05-29 (ADR-063): Admin auth token-or-open + CSRF guard supersedes ADR-037 RFC1918 IP-allowlist. May 2026 (ADR-061): Snapshot valuation parity. Prior May 2026: ADR-060 Monetary Precision; ADR-059 Belgian Tax historical year extensions; ADR-058 Belgian Tax historical year snapshots; ADR-057 Belgian Tax follow-up; ADR-056 Belgian Tax audit fixes; ADR-055/054/053 tax correctness; ADR-052 Transaction Tags; ADR-051 Docker Compose sync; ADR-050 CI supply chain; ADR-049 bug hunt; ADR-048 AI Chat stream store; ADR-047 Tailwind v4."
aliases: [ADRs, decisions, architecture decisions]
---

# Architecture Decision Records

> [!abstract] What is an ADR?
> An ADR (Architecture Decision Record) documents a significant architectural decision along with its context, consequences, and status. Use these to understand **why** the system is built the way it is.

## Desktop app decision

[[docs/adr/214-retire-vision-native-swift-port|ADR-214]] retires the Vision Native Swift port
(ADR-204, ADR-205, ADR-209 to ADR-212 superseded; ADR-213 rejected). The Electron app with the
React/TypeScript frontend and TypeScript backend is the only desktop app; its bundled native
PostgreSQL runtime and Vision Demo stay. Do not restart a Swift or native rewrite without a new
ADR from Tor.

## Recovery and report resource bounds

[[docs/adr/207-coordinated-native-recovery|ADR-207]] coordinates native snapshot capture and interrupted restore recovery.
[[docs/adr/208-bounded-report-pipeline|ADR-208]] bounds complete PDF jobs before data fetching and HTML allocation.

## Bank chronology

[[docs/adr/206-bank-chronology|ADR-206]] preserves bank sequence through import and uses it for same-day balance anchors without guessing missing chronology.

## Latest visual hierarchy decision

[[docs/adr/172-calm-information-hierarchy|ADR-172]] reserves primary emphasis for selected totals and makes supporting surfaces quieter while preserving the visual identity.

## Current copy decision

[[docs/adr/182-ui-copy-plain-words|ADR-182]] puts the English and Dutch UI copy on the
plain-words rule: sentence case outside navigation labels and proper names, *payee* for the
counterparty, *excluded* for a transaction left out of totals, *income tax* instead of PIT,
*exchange rate* instead of FX, and planned payments *marked as paid*.

## Current screen redesign decision

[[docs/adr/190-primitives-follow-up|ADR-190]] turns the sweep's primitive wishes into shared
primitives (ListRow actions and selection, RowMenu, destructive menu items, mini sizes, labelled
segmented controls, Disclosure, Select none-sentinel helpers, PageHeader back, Alert role by
variant) and moves the last native selects, in the portfolio import session, to the design-system
Select.

[[docs/adr/187-completeness-sweep|ADR-187]] closes the redesign roadmap: every remaining screen
and dialog (money pages, taxes, portfolio assets and imports, research, analysis, AI chat, admin
and shared components) adopts PageHeader with one primary action and a ••• menu, List rows with
row menus, SegmentedControl and Select, Alert and EmptyState, and undo or confirm per action,
without cutting any action. Navigation labels read in sentence case.

[[docs/adr/183-remaining-screens-redesign|ADR-183]] merges the Portfolio overview and the
Performance page into one Portfolio screen and moves Net worth, Insights (formerly Statistics),
Import, Planned and the Settings window onto the design system without cutting any action.

[[docs/adr/181-home-transactions-redesign|ADR-181]] moves Home, Transactions and New Transaction
onto the design system: a month-to-date hero and Needs attention list on Home, filter chips, a
View menu and a docked inspector on Transactions, and a New Transaction sheet that records
expenses, income and transfers and opens from N on the web.

## Current navigation decision

[[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]] replaces the three workspaces with
one labelled sidebar whose Money, Wealth and Research sections are visible together and
individually hideable; icons-only is remembered, the topbar theme and update controls move into
Settings, the palette and the Electron View menu, and live counts sit on the rows that need
attention. Supersedes the layout of [[docs/adr/099-sidebar-navigation-ia|ADR-099]].

## Current design-system decision

[[docs/adr/179-primitives-adopt-role-tokens|ADR-179]] moves the shared primitives onto the
[[docs/adr/178-design-system-role-tokens|ADR-178]] role tokens: one control height scale,
concentric corners, one keyboard focus ring, elevation-backed glass tiers and CSS springs, plus a
segmented control, an inset list, an inspector panel and an Undo toast helper.

## Current agent execution decision

[[docs/adr/176-built-in-agent-sandboxes|ADR-176]] retires the project agent container and uses
built-in Claude Code and Codex sandboxes with the native development workflow.

## Current portfolio history decision

[[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|ADR-177]] adds reviewed adoption
receipts, atomic statement sessions, and dated partial custody with original acquisition basis.
It supersedes whole-lot re-tagging for dated custody history and records guarded schema recovery.

## Current source-owned cash decision

[[docs/adr/189-proved-brokerage-cash-history|ADR-189]] adds complete proved cash-only review,
source-owned broker transfer classification, literal withdrawal fee expenses and guarded rollback.

## All ADRs

```dataview
TABLE WITHOUT FILE status AS "Status", date AS "Date", description AS "Summary"
FROM "docs/adr"
WHERE !contains(file.name, "template") AND type = "adr"
SORT date DESC
```

## Active Decisions

[[docs/adr/171-packaged-openai-explicit-configuration|ADR-171]] (Accepted for implementation)
permits the packaged OpenAI API route only with explicit private runtime configuration. It
supersedes ADR-167's unconditional packaged disablement; live synthetic route acceptance is
still pending review.

[[docs/adr/170-agentcloak-desktop-detection-and-scoped-protection|ADR-170]] (Accepted) adds
experimental AgentCloak Desktop detection. Vision protects selected findings with encrypted scoped
tokens before consent and restores answer text locally; the MCP gate remains available.

[[docs/adr/169-operator-managed-agentcloak-preflight|ADR-169]] (Accepted) adds an optional
operator-managed loopback AgentCloak check before cloud preview and send. It blocks a changed
result while preserving Vision's exact OpenAI payload and grant.

[[docs/adr/168-github-release-trust-boundary|ADR-168]] (Accepted) uses GitHub's protected
release process as the desktop update trust root, without a separately managed signing key.
The updater still requires matching ZIP and checksum assets; a new malicious GitHub release
remains a trusted-publisher risk.

[[docs/adr/164-disposable-codex-session-cleanup|ADR-164]] (Accepted) removes
abandoned marked synthetic Codex session roots on the next start while leaving
active and unrelated temporary files alone.

[[docs/adr/163-audit-transfer-recovery-journal|ADR-163]] (Accepted) recovers an
interrupted protected audit transfer only when the current or journal checkpoint
matches the independent Keychain witness.

[[docs/adr/162-one-year-audit-retention|ADR-162]] (Accepted) binds a
one-year-old audit prefix to an external receipt before guarded atomic pruning.

[[docs/adr/161-password-protected-audit-device-transfer|ADR-161]] (Accepted)
adds a password-protected transfer of the trusted audit checkpoint to a fresh
Mac before restoring the matching backup.

[[docs/adr/160-explicit-audit-enrollment-baseline|ADR-160]] (Accepted) lets an
existing native installation deliberately create a forward-looking Keychain
checkpoint while marking earlier entries as accepted at enrollment.

[[docs/adr/158-macos-keychain-audit-witness|ADR-158]] (Accepted) adds a
macOS Keychain checkpoint outside the application-data tree. Existing version
2 receipts do not enroll automatically, and key recovery remains open.

[[docs/adr/157-electron-local-audit-receipt|ADR-157]] (Accepted) adds a
main-process local audit receipt, a private loopback verification bridge, and
startup and restore checks. Existing-install enrollment and ongoing checkpoint
promotion remain open.

[[docs/adr/156-forward-only-audit-chain-foundation|ADR-156]] (Accepted) records a
forward-only audit-chain cutover and backup coverage. ADR-157 adds the later
installation-local receipt and lifecycle checks.

[[docs/adr/155-evidence-led-electron-surface|ADR-155]] (Accepted) keeps the required
native desktop journeys while narrowing renderer navigation and IPC trust and
removing measured package-only assets.

[[docs/adr/154-local-analysis-monitors|ADR-154]] (Accepted) persists deterministic local checks,
visible observations, deduplicated notification episodes, and a server-owned inbox without
background provider or AI calls.

[[docs/adr/153-persistent-research-dossiers|ADR-153]] (Accepted) keeps user-authored research,
evidence provenance, live and deleted links, and conclusions in local versioned dossiers with a
guarded downgrade and complete JSON export.

[[docs/adr/152-depth-agnostic-category-hierarchy|ADR-152]] (Accepted) keeps stable category IDs,
adds ordered parent-linked paths and ancestor rollups, and preserves the old two-field contract as
compatibility aliases with a guarded downgrade.

[[docs/adr/151-scoped-reversible-ai-references|ADR-151]] (Accepted) replaces explicitly marked
private literals with one-job cryptographic tokens for cloud disclosure, then restores allowlisted
answer text locally under an installation-held key. It is pseudonymization, not anonymity.

[[docs/adr/150-explicit-portfolio-look-through-exposure|ADR-150]] (Accepted) combines direct and
supported fund holdings only through explicit classifications and exact share-class identifiers,
while preserving uncovered weight and excluding inferred economic foreign-exchange exposure.

[[docs/adr/149-cloud-authored-catalog-analysis-plans|ADR-149]] (Accepted) lets the cloud planner
propose strict identifier-only analysis plans while trusted scope injection, SQL compilation,
execution, private results, and final synthesis remain local.

[[docs/adr/148-user-default-openai-model|ADR-148]] (Accepted) persists a user-selected default
OpenAI API model in AI settings. Per-investigation selection still overrides it, while removed or
unapproved models fall back to the operator-approved catalog.

[[docs/adr/147-allowlisted-openai-model-selection|ADR-147]] (Accepted) exposes a server-approved
OpenAI API model picker with per-model prices. The selected model is bound into the exact preview,
consent digest, and spend reservation; ChatGPT subscriptions remain a separate unsupported route.

[[docs/adr/146-explicit-selected-evidence-cloud-synthesis|ADR-146]] (Accepted) adds a separate
consent profile where OpenAI writes the final answer from only the exact user-selected evidence in
the approved payload, without tools, hidden context, or automatic local fallback.

[[docs/adr/144-isolated-manual-analysis-workspace|ADR-144]] (Accepted) isolates visual and SQL
analysis behind a fixed read-only PostgreSQL role and persists immutable definitions and runs.

[[docs/adr/143-forward-only-broker-performance-history|ADR-143]] (Accepted) starts a new daily
per-broker portfolio history without synthesizing or rewriting earlier account assignments.

[[docs/adr/142-retire-electron-legacy-install-guards|ADR-142]] (Accepted) ends support for legacy
Electron application-data and Docker-runtime recovery after the sole maintained install completed
the native cutover.

[[docs/adr/141-provider-neutral-transaction-provenance|ADR-141]] (Accepted) replaces provider-specific
raw transaction tables with an exact neutral archive, preserved links, and manual duplicate claims.

[[docs/adr/140-versioned-analysis-datasets|ADR-140]] (Accepted) defines four versioned,
deny-by-default financial analysis datasets and their reconciliation rules.

[[docs/adr/139-fund-holdings-source-and-import-contract|ADR-139]] (Accepted) defines the
user-supplied fund-holdings baseline, provenance, coverage, and fail-closed import contract.

[[docs/adr/138-openai-codex-assistance-boundary|ADR-138]] (Accepted) separates OpenAI API and
Codex subscription assistance and keeps both behind an explicit local disclosure boundary.

[[docs/adr/137-shared-analysis-definition-and-result-contract|ADR-137]] (Accepted) defines the
versioned, runtime-validated definition and execution-result contract shared by future manual, SQL,
spreadsheet, chart, and AI-assisted financial analyses.

[[docs/adr/136-same-release-http-import-and-navigation-contract|ADR-136]] (Accepted) defines the
same-release frontend/backend support policy and retires legacy HTTP error parsing, import
query-field fallbacks, and old frontend entry points.

[[docs/adr/134-versioned-import-identity-and-exact-provenance|ADR-134]] (Accepted) separates exact
CSV provenance from versioned, occurrence-aware duplicate identity shared by budgeting and
portfolio imports.

[[docs/adr/133-native-only-runtime-and-delivery|ADR-133]] (Accepted) retires active Docker and
Compose support across the product, development, CI, and releases while preserving real native
PostgreSQL verification and a fail-closed legacy migration boundary.

[[docs/adr/132-thin-default-card-material|ADR-132]] (Accepted) makes `glass-thin` the default Card
material while preserving explicit elevated hero cards and chrome surfaces.

[[docs/adr/131-bounded-statistics-window|ADR-131]] (Accepted) bounds the default Statistics view to
24 calendar months while preserving an explicit all-time mode and exact historical FX conversion.

[[docs/adr/130-canonical-biweekly-recurrence|ADR-130]] (Accepted) canonicalizes portfolio and
planned-transaction recurrence values to `biweekly`, with a one-release compatibility mapper for
legacy portfolio writes.

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

> [!note] Renumbered on 2026-10-18
> The Vision Native ADRs written on the native branch as ADR-206 to ADR-210 are ADR-209 to
> ADR-213 after merging `main`, which already uses ADR-206 to ADR-208 (bank chronology,
> coordinated native recovery, bounded report pipeline).

### 2026-10-19: Proportional CI (accepted)

[[docs/adr/221-proportional-ci|ADR-221]] cuts `ci.yml` from about 22 jobs to seven and removes
the Quality Gate job. Pull requests run the frontend suite in two shards without coverage; pushes
to `main` keep the coverage ratchet. Native runtime verification and the live API contracts run
inside `Test (Backend)`, also on drafts. Trivy is removed from CI and release, Dependabot groups
updates per ecosystem, and release verification requires a passing `CI Complete` on the tagged
commit instead of re-running the suites. It supersedes the Trivy part of ADR-050.

### 2026-10-19: Branded ids, currency codes and Money values (accepted)

[[docs/adr/220-branded-ids-currency-codes-and-money|ADR-220]] brands entity ids and ISO currency
codes (`@vision/types/brands`) at the row-schema, route, wire-contract and frontend API
boundaries, so mixed-up ids and free-text currencies fail to compile. Server totals sum converted
figures as `Money` through `sumMoney`, which refuses to add different currencies. The existing
typecheck enforces it; no CI step is added.

### 2026-10-19: Minimal macOS Electron shell hardening; retire v1 backups (accepted)

[[docs/adr/219-minimal-electron-shell-hardening|ADR-219]] makes the shell macOS-only, flips
packaged Electron fuses before the ad-hoc seal (`NODE_OPTIONS` and inspect arguments off, asar
integrity and asar-only loading on, RunAsNode kept for the update installer), denies permissions
in every profile, sandboxes all renderers and refuses webviews. The watchdog pauses during sleep,
logout or shutdown skips backup-on-quit, native UI follows the Appearance choice, `.csv` files
offer Vision in Open With, and a banner shows backend loss. Restore refuses retired v1
(AES-256-CBC) backups. It supersedes ADR-040's v1-readable clause and extends ADR-155.

### 2026-10-19: Retire the source-launcher update channel (accepted)

[[docs/adr/218-retire-source-launcher-update-channel|ADR-218]] removes `launch.command`, the
`vision-source-launcher-*.zip` release asset with its source SBOM and attestation, and the
generated shell installer. The packaged app updater is the only in-app install path; development
runs report `update_mode: "source"` and open the release page. It supersedes the source-launcher
parts of ADR-023, ADR-116 and ADR-196.

### 2026-10-19: Compute Belgian tax figures on the server (accepted)

[[docs/adr/217-belgian-tax-figures-on-the-server|ADR-217]] removes the PIT/household engine, including
the assessment and the year tables, from the browser bundle. The tax store hydrates from `GET /api/belgian-tax/overview`, the editor's live
figures come from a debounced `POST /api/belgian-tax/compute`, and freezing, filing and exports
use server figures. It amends the lazily loaded engine of ADR-200 phase B2.

### 2026-10-19: Domain calculations run on the server (accepted)

[[docs/adr/216-server-owned-domain-calculations|ADR-216]] keeps financial figures on the
server; the browser only previews unsaved input. It adds `GET /api/planned-transactions/totals`,
returns the applied forecast `ensemble_weights`, and reads archived holdings from
`portfolio-summary?active=false` instead of rebuilding them in the browser.

### 2026-10-19: Test behaviour at stable boundaries (accepted)

[[docs/adr/215-behaviour-boundary-tests|ADR-215]] lets agents restructure code freely: tests that
assert internal structure may be deleted with a one-line reason, and a behaviour they alone
covered gets a boundary test in the same change.

### 2026-10-19: Retire the Vision Native Swift port (accepted)

[[docs/adr/214-retire-vision-native-swift-port|ADR-214]] retires the Swift app under
`apps/native/`, its generators, CI jobs, frontend bridges and documentation, on Tor's decision.
It supersedes ADR-204, ADR-205, ADR-209, ADR-211 and ADR-212 (ADR-210 was already superseded)
and rejects the proposed ADR-213. Electron stays the only desktop app; the Electron native
PostgreSQL runtime, Vision Demo and the shared TypeScript logic and endpoints extracted during
the port stay.

### 2026-10-18: Move the backend into the Mac app in Swift (proposed; rejected 2026-10-19 by ADR-214)

[[docs/adr/213-vision-native-swift-backend|ADR-213]] proposes replacing the TypeScript backend,
route by route behind `openapi.yaml`, with a Swift backend (Hummingbird 2, PostgresNIO) running
inside the Mac app. PostgreSQL stays supervised; Docker/Linux and Electron keep the TypeScript
backend until they are retired. Decision record only; no code yet.

### 2026-10-18: Retire the helper document (accepted; superseded by ADR-214)

[[docs/adr/212-vision-native-retire-helper-document|ADR-212]] supersedes ADR-210's helper
document: native-only is the passing Debug Demo default, so the helper's entry, build, backend
route, Swift bridge and e2e mode are removed. The retained web document stays as the opt-out and
for every ineligible build; native-only stays Debug Demo only.

### 2026-10-17: Finish phase 4 without web content (accepted; superseded by ADR-214)

[[docs/adr/211-vision-native-without-web-content|ADR-211]] amends ADR-210: the helper document's
calculations (palette answers, tax report profile and context) and its storage move to Swift,
and a default-off native-only mode stops creating the WKWebView until CI and the macOS smoke
prove it. The e2e smoke measures the Electron Demo as the missing phase-0 baseline.

### 2026-10-17: Phase-4 go for ADR-209 and ADR-210 (accepted, default-off)

Tor gave the phase-4 go on 2026-10-17 on the condition that new authorities stay default-off.
[[docs/adr/210-vision-native-helper-document|ADR-210]] is accepted and implemented in the SDK
behind an explicit Debug Demo opt-in; [[docs/adr/209-vision-native-staged-web-retirement|ADR-209]]
is accepted and its native history is what that mode uses. Every other launch keeps the
retained web document; no real data moves.

### 2026-10-15: Isolate a native Demo helper document (proposed; accepted 2026-10-17; superseded by ADR-212)

[[docs/adr/210-vision-native-helper-document|ADR-210]] proposes a default-off Debug Demo
experiment with native presentation and routing plus a same-origin document for unchanged
TypeScript helpers and scoped storage. It records build/readiness and native-owner prerequisites;
no helper-only SDK mode, real-data migration or phase-4 completion is enabled by the proposal.

### 2026-10-15: Stage native route authority before web retirement (proposed; accepted 2026-10-17; superseded by ADR-214)

[[docs/adr/209-vision-native-staged-web-retirement|ADR-209]] proposes explicit opt-in native
history while the SDK retains renderer routing. It preserves query/leave-guard/Settings contracts
and records storage, helper-runtime and restore-readiness gates before web retirement. The proposal
and preparatory APIs do not certify switch-over or authorize real-data migration.

### 2026-10-12: Vision Native phase 1 hand-over (accepted; superseded by ADR-214)

[[docs/adr/205-vision-native-hand-over|ADR-205]] was accepted on 2026-10-12. It records what
phase 1 of Vision Native delivered (runtime, shell, backup, audit anchor, Demo variant, the
phase 1 exit checklist and backup interop in CI),
keeps the Demo-only rule until phase 4, lists the switch-over steps deferred to phase 4 (restore
through a backup, audit key and witness migration, Keychain service names, iCloud backup folder)
and the product questions for Tor.

### 2026-10-12: The pension type follows the tax return

[[docs/adr/203-belgian-tax-pension-type-activity-income|ADR-203]] adds the optional
`pensionKind` to a household pension activity, split as in box V of the return (codes 1228 /
1229 / 1211). The engine then leaves a pensioner's activity income out of the art. 147 al. 1, 2°
proportion (art. 147 al. 1, 2°, b-c), tests the statutory-pension limit on the gross amount, keeps
the art. 153 limit on the total net income and applies AAFisc 40/2011 no. 19 under the quotient.

### 2026-10-12: Vision Native is a Swift app target (superseded by ADR-214)

[[docs/adr/204-vision-native-swift-app-target|ADR-204]] records a separate Swift app, Vision
Native (`apps/native/`, `com.vaultvoyager.vision-native`), with its own data directory. It runs
only on the Demo dataset until the phase 4 switch-over, targets Apple-silicon Macs on current
macOS, installs locally with a personal-team signature and has no updater. The backend and data
are unchanged. It supersedes nothing yet. Swift checks run on a GitHub-hosted macOS runner, and
the Belgian tax engine (which runs in the frontend today) moves behind a backend endpoint before
the Tax screen goes native.

### 2026-10-11: The household region decides the own-home regime

[[docs/adr/202-belgian-tax-region-and-own-home-baskets|ADR-202]] supersedes ADR-054 for the
mortgage region only: the Flemish or Walloon own-home regime follows the household's region (the
fiscal domicile on 1 January of the assessment year, special finance law art. 5/1 §2), and
`mortgageRegion` is deprecated but kept. The optional `home.mortgageSharePartnerB` gives each of
two borrowers their own woonbonus or chèque habitat basket.

### 2026-10-11: Tax partners map to account owners by a fixed rule

[[docs/adr/201-belgian-tax-partner-account-mapping|ADR-201]] supersedes ADR-200 §7 for the
mapping only: account owner `me` is partner A, `partner` is partner B, and `joint` accounts are
split 50/50. The mapping is fixed in the frontend, not stored; the backend reports amounts per
account owner.

### 2026-10-11: Belgian tax is computed for a household of one or two partners

[[docs/adr/200-belgian-tax-household-model|ADR-200]] replaces the single-person tax profile with a
version-2 household (one or two partners, several income activities each, dated relationship
events) under the `belgian_tax_household_v2` and `belgian_tax_household_snapshots_v2` setting
keys. The assessment mode follows WIB 92 art. 126 per income year, tax is computed per partner,
and the frontend upgrades v1 data automatically on first load. Partner ids `A` / `B` are the
contract for the later mapping to account owners.

### 2026-10-11: Every TypeScript project uses exactOptionalPropertyTypes and no explicit any

[[docs/adr/198-exact-optional-property-types|ADR-198]] turns on `exactOptionalPropertyTypes` in
every TypeScript project, widens optional properties that accept `undefined` to `T | undefined`,
removes the last explicit `any` and makes the backend `no-explicit-any` lint rule an error.

[[docs/adr/199-belgian-tax-source-verification|ADR-199]] requires every Belgian tax rule and
amount to be traced to a primary source in a rule coverage matrix, and records the corrections
that audit produced (self-employed forfait, art. 88 marital-quotient cap, CSSS scale and
household base, frozen IY 2025 amounts, post-reform IY 2026 table).

### 2026-10-11: The frontend compiles with the backend's stricter TypeScript flags

[[docs/adr/197-stricter-frontend-compiler-flags|ADR-197]] turns on `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noImplicitReturns`, `erasableSyntaxOnly` and `verbatimModuleSyntax` for the
frontend's source and tests, and converts the bundle-size guard to TypeScript.

### 2026-10-11: The Electron shell is strict TypeScript compiled into out/

[[docs/adr/196-electron-shell-typescript|ADR-196]] converts the Electron shell to strict
TypeScript that `tsc` compiles to CommonJS in `packaging/electron/out/`. Every launch, test and
packaging path builds first, and `paths.ts` `appRoot` locates the resources that are not compiled.

### 2026-10-11: Repository scripts are strict TypeScript run on Bun

[[docs/adr/195-repository-scripts-typescript|ADR-195]] converts every JavaScript script under
`scripts/` and `apps/node-backend/scripts/`, and the script tests, to strict TypeScript that Bun
runs directly. CI type-checks them and installs a pinned Bun in every job that runs one.

### 2026-10-10: Runtime contracts cover the backend reads and the frontend client

[[docs/adr/194-runtime-contracts-completion|ADR-194]] completes ADR-193: almost every backend
query whose rows are read is checked against a row schema kept per area in `database/rows/`,
`query<R>()` defaults to `unknown` rows, backend source and tests turn on
`noUncheckedIndexedAccess`, and the frontend checks about 170 more API calls with wire schemas
that require every field the backend always sends, including the save responses the UI reads.

### 2026-10-08: Zod runtime contracts at the boundaries

[[docs/adr/193-zod-runtime-contracts|ADR-193]] checks boundary data at runtime with zod: HTTP
requests through one `parseInput` helper (400 on failure), adapter output, stored parser configs
and PostgreSQL rows through data contracts (they block in every environment, production included,
and never answer 400), selected frontend API reads, and every Electron IPC channel.

### 2026-10-08: Backend tests move to strict TypeScript

[[docs/adr/192-backend-tests-strict-typescript|ADR-192]] converts the backend Vitest suites to
strict TypeScript over a few pull requests, checked by a separate strict `tsconfig.tests.json` in
the backend typecheck and CI.

### 2026-10-08: Backend source is fully strict TypeScript

[[docs/adr/191-retire-backend-checkjs|ADR-191]] converts the backend entry point to `main.ts` and
retires the checkJs program, its `noImplicitAny` ratchet and the ambient module shims, leaving the
strict `tsconfig.json` as the only backend type check.

### 2026-10-08: The sweep's primitive wishes become shared primitives

[[docs/adr/190-primitives-follow-up|ADR-190]] extends ListRow, Button, menu items,
SegmentedControl, Alert and PageHeader, adds Disclosure, RowMenu and the Select none-sentinel
helpers, adopts them on every screen and dialog, and moves the five native selects in the
portfolio import session to the design-system Select.

### 2026-10-07: Proved brokerage cash history

[[docs/adr/189-proved-brokerage-cash-history|ADR-189]] adds complete proved cash-only review,
source-owned broker transfer classification, literal withdrawal fee expenses and guarded rollback.

### 2026-10-07: Proved in-kind income recognition

[[docs/adr/188-proved-in-kind-income-recognition|ADR-188]] records literal income already represented
by proved acquired units separately from ordinary income and gains. Immutable paired receipts guard
repeat imports, rollback and downgrade; no legal tax classification is inferred.

### 2026-10-07: Every remaining screen and dialog adopts the design system

[[docs/adr/187-completeness-sweep|ADR-187]] finishes the redesign roadmap by moving the money,
tax, portfolio asset, research, analysis, AI chat, admin and shared surfaces onto the design
system with one primary action and a ••• menu per page, row menus, segmented controls and
selects, consistent states, undo or confirm per action, and sentence-case navigation labels.

### 2026-10-07: Backend source moves to strict TypeScript by directory

[[docs/adr/186-backend-strict-typescript|ADR-186]] converts the Node backend from JSDoc JavaScript to
strict TypeScript one directory group at a time, checked by a separate strict tsconfig in CI while
the remaining JavaScript keeps the checkJs gate and ratchet.

### 2026-10-07: Shared packages are strict TypeScript source

[[docs/adr/185-shared-packages-typescript|ADR-185]] replaces the JavaScript and hand-written
declarations in `@vision/types` and `@vision/shared-utils` with strict TypeScript that every runtime
loads directly, checked in CI by `bun run typecheck:packages`.

### 2026-10-07: Python is type-checked with mypy --strict

[[docs/adr/184-strict-python-type-checking|ADR-184]] checks Alembic env and migrations, repository
scripts and the packaged Alembic wrapper with `mypy --strict` in a required CI job, using
hash-pinned dev requirements.

### 2026-10-06: Remaining screens adopt the design system

[[docs/adr/183-remaining-screens-redesign|ADR-183]] merges Portfolio and Performance, gives Net
worth an assets-and-debt hero, renames Statistics to Insights, reorders Import file-first, puts
Planned actions in words and menus, and restyles Settings as a sectioned window.

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
GitHub attestations before the release is created. (Source-launcher ZIP retired by ADR-218.)

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

[[docs/adr/135-compatibility-cutoff-for-september-retirements|ADR-135]] (Accepted) — Ends the
transaction-date response alias, runtime `bi-weekly` normalization, the Belgian-tax
`federalPITTotal` alias, completed browser settings migrations, and the browser-only insight
dismissal gate. Migration 0106 removes only proven-equal persisted tax aliases. The decision records
that the recurrence release gate and centrally unknowable browser-profile census were explicitly
overridden rather than completed.

[[docs/adr/145-bounded-ai-research-orchestration|ADR-145]] (Accepted) — Adds provider-neutral,
recoverable AI investigations, bounded local document and public-web research, structured evidence
answers, and an opt-in consent-bound OpenAI Responses egress helper without requiring a container.

[[docs/adr/146-explicit-selected-evidence-cloud-synthesis|ADR-146]] (Accepted) — Preserves the two
cloud-planning modes and adds explicit final synthesis from a manually selected, previewed evidence
bundle. The cloud receives no tools, database access, or implicit local context.

[[docs/adr/159-experimental-isolated-codex-route|ADR-159]] (Accepted for synthetic experimentation) —
Adds an opt-in, admin-only Codex App Server session with disposable state, macOS Seatbelt, a local
allowlisted proxy, device-code login, and a fixed fictional turn. Private input remains blocked.

[[docs/adr/165-reviewed-fresh-database-baseline|ADR-165]] (Accepted) — Uses one reviewed
PostgreSQL 18 SQL snapshot for empty installs and preserves the historical Alembic graph. Existing
installations defer the no-data-rewrite 0119 bridge until a restore-tested maintenance window.

[[docs/adr/166-maintained-database-canonical-conversion|ADR-166]] (Accepted) — Converts the
reviewed maintained legacy installation to the exact fresh `0119` shape during an explicit
maintenance window. Old timestamps are interpreted as UTC; the 390-row archive is exported and
verified. A full backup, retained prior database, and guarded rollback remain available.

[[docs/adr/167-packaged-openai-api-release-gate|ADR-167]] (Accepted historical decision;
packaged disablement superseded by ADR-171) — Kept the OpenAI API investigation route disabled
when live synthetic acceptance had been declined. Its evaluation evidence remains historical.

[[docs/adr/173-conditional-settings-replacement|ADR-173]] (Accepted) — Requires loaded persistence
baselines for whole-value settings mutation, rejects stale saves, and defines browser/Electron
queues plus explicit internal/admin/restore writer policy.

[[docs/adr/174-single-instance-daily-job-catch-up|ADR-174]] (Accepted) — Supports one backend
instance per shared database and coalesces overdue daily work using successful-completion checkpoints.
