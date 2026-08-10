---
title: Feature - Portfolio & Investments
type: feature
status: active
date: 2026-06-20
last_modified: 2026-08-10
updated: 2026-08-10
tags: [feature, portfolio, investments, stocks, crypto, metals, phase-1, phase-3.5, phase-3.6, phase-9, phase-8, phase-14, pdf-export, offline-resilience, stale-prices, online-status-detection, graceful-degradation, portfolio-summary, realtime-totals, decimal-precision, monetary-math, snapshot-valuation-parity, fixed-income-accrual, real-estate-appreciation, net-worth-reconciliation, historical-fx, snapshot-fx, loading-states, error-states, page-error, skeleton, portfolio-unit-math, shared-utils, splits-event, return-of-capital, banker-rounding, fx-attribution, asset-gain, fx-gain, purchase-date-rates, value-fx-neutral, adr-074, adr-091, adr-100, per-account, move-holding, close-account, brokerage-fanout, rebalancing, saved-plans, cash-aware, cross-workspace, adr-098, portfolio-ticker, marquee, live-quotes, ticker-manager, show-in-ticker, migration-0061, fx-aware-pnl, unified-detail-dialog, useFxAwarePnl]
aliases: [portfolio-feature, investments-feature, holdings, net-worth, stocks, crypto, real-estate, savings, bonds, metals, performance, watchlist]
description: Track stocks, ETFs, crypto, metals, real estate, savings, and bonds; includes Phase 8 PDF report export with 6 portfolio sections. 2026-05-29 adds historical FX in snapshots and loading/error states on all asset pages. June 2026 adds snapshotBuilder split/return_of_capital events, APP_TIMEZONE day-boundary fix, shared portfolioUnitMath.ts, and FX attribution UI (ADR-074): asset gain / FX effect decomposition on overview, performance, asset pages, and investment detail.
related_code: ["apps/node-backend/src/routes/investments.js", "apps/node-backend/src/services/priceProviderService.js", "apps/node-backend/src/services/portfolioPerformanceSnapshotService.js", "apps/node-backend/src/services/portfolio/portfolioSummaryService.js", "apps/node-backend/src/routes/info/portfolioSummary.js", "apps/frontend/src/pages/portfolio/PerformancePage.tsx", "apps/frontend/src/pages/portfolio/MetalsPage.tsx", "apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx", "apps/frontend/src/hooks/portfolio/usePortfolioSummary.ts", "apps/frontend/src/hooks/usePortfolio.ts", "apps/frontend/src/lib/api.ts"]
---

# Feature: Portfolio & Investments

## Overview

Vision's portfolio management tracks various investment types with live price updates and comprehensive transaction history.

Under the hood, portfolio storage now uses PostgreSQL inheritance:

- `investments_base` holds shared fields and is specialized by `stock_investments`, `etf_investments`, `crypto_investments`, `real_estate_investments`, `savings_investments`, and `bond_investments`.
- `portfolio_transactions_base` holds shared transaction fields and is specialized by matching per-asset transaction tables (including dedicated `metals_transactions` for metals, separate from `stock_transactions`).
- Backward-compatible views (`investments`, `portfolio_transactions`) keep existing repository and route contracts stable.

## Supported Asset Classes

| Asset Class | Description | Examples |
|-------------|-------------|----------|
| stock | Individual stocks | AAPL, MSFT, TSLA |
| etf | Exchange-traded funds | IWDA, VWCE |
| crypto | Cryptocurrencies | BTC, ETH |
| metals | Precious metals (unit-based) | GC=F, SI=F |
| real_estate | Property investments | Apartments, houses |
| savings | Savings accounts | Term deposits |
| bonds | Fixed income | Government bonds |

## Investment Management

### Creating Investments
```javascript
POST /api/investments
{
  "name": "Apple Inc.",
  "symbol": "AAPL",
  "asset_class": "stock",
  "currency": "USD",
  "current_price": 185.50,
  "price_provider": "yahoo",
  "price_provider_id": "AAPL"
}
```

Implementation notes:
- Backend route parsing/normalization for investment list and transaction-list endpoints now reuses shared helpers (`parseDefaultListOptions`, `parseBulkTransactionsOptions`, `parseInvestmentTransactionsOptions`, `parseDbOnlyQueryValue`, `parseRequestId`, `parseTxnRequestId`) to reduce duplication while preserving endpoint defaults/clamping/validation behavior ([[apps/node-backend/src/routes/investments.js]]).

### Price Providers

| Provider | Asset Classes | API |
|----------|---------------|-----|
| manual | all | User-entered prices |
| binance | crypto | Binance market data |
| yahoo | stock, etf, metals | Yahoo Finance |
| kinesis | metals, commodities | Kinesis market data |
| custom | all | Custom API endpoint(s) for latest + historical quotes |

### Editing Investments

Investment details can be edited from portfolio details/list UIs via dedicated edit dialogs.

Editable fields:
- Name (`name`)
- Ticker/symbol (`symbol`) for unit-based assets
- Currency (`currency`)
- Current price (`current_price`) when using manual provider on unit-based assets
- Price provider fields (`price_provider`, `price_provider_id`, `price_provider_url`)
- Custom provider advanced fields (`price_provider_latest_url`, `price_provider_latest_path`, `price_provider_history_url`, `price_provider_history_path`, `price_provider_history_ts_path`, `price_provider_history_price_path`)

Constraints:
- `asset_class` cannot be changed after creation.
- `symbol` must be non-empty when set and globally unique (case-insensitive).
- Edit history is timestamp-only via `updated_at` (no full value history).

Code links: [[apps/frontend/src/components/portfolio/EditInvestmentDialog.tsx]], [[apps/frontend/src/components/portfolio/InvestmentDetailDialog.tsx]], [[apps/node-backend/src/repositories/investmentRepository.js]]

### Price Refresh
```
POST /api/investments/refresh-prices
```

Updates all investments with non-manual price providers.

When markets are closed or providers return missing/zero values, refresh uses a fallback chain:
- `live`: real-time quote
- `close`: previous close or latest historical close quote (Yahoo)
- `cached`: last non-zero `current_price` already stored in DB
- `historical_fallback`: last persisted point from `asset_price_history` when live providers are unreachable (offline scenario)

The refresh API response includes `priceSources` per investment ID so clients can show where each price came from. When the live provider is unreachable and the backend falls back to `historical_fallback` or `cached` sources, the frontend displays a warning toast (`portfolio.refreshedPricesStale`) with a count of stale prices instead of a plain success message, making the degradation explicit to the user.

Implementation notes:
- Yahoo provider resolution now follows Market Lookup style symbol handling by accepting `price_provider_id` first and falling back to `symbol` when needed.
- Kinesis provider now resolves symbol/timeframe/from-date through a shared helper for both live and historical paths, keeping lookup behavior consistent.
- Kinesis refresh eligibility accepts either explicit `price_provider_id` or name/symbol mapping via Kinesis asset config.
- Refresh price persistence updates inheritance storage tables directly (`investments_base` and asset-specific child tables), avoiding `UPDATE investments ...` against the compatibility view.
- Custom provider refresh can resolve latest quote either via explicit latest path, or from latest point in configured history payload when latest path is not provided.
- New API endpoint `GET /api/investments/:id/price-history` serves provider-backed history (yahoo/custom) with read-through DB persistence in `asset_price_history`.
- Legacy DB compatibility: if `investments` table/view does not yet contain new custom-provider columns, investment create automatically falls back to legacy provider fields (`price_provider_id`, `price_provider_url`) so custom latest-path setups still work during mixed-schema deployments.
- Migration dependency: `0017_investment_custom_provider_history` applies custom-provider latest/history columns to inheritance storage, conditionally patches legacy `investments` table only when relation kind is table/partition, creates `metals_investments` if missing, and refreshes the compatibility view/trigger for metals + new provider fields ([[alembic/versions/0017_investment_custom_provider_history.py]]).
- Migration dependency: `0021_update_price_provider_enum` migrates the `price_provider` enum from `coingecko`/`kraken` to `binance` by altering `investments_base.price_provider`, dropping the column default before enum type conversion and restoring `DEFAULT 'manual'` after conversion. To prevent dependency failures in PostgreSQL, it dynamically backs up and drops all dependent `public` views referencing `investments_base` (including column-level dependencies such as `price_provider`), recreates those views from captured definitions after the enum swap, and recreates the `update_investments_view_instead` trigger on `investments` when `investments_view_update_instead()` exists ([[alembic/versions/0021_update_price_provider_enum.py]]).
- Migration dependency: `0018_metals_transactions_inheritance_split` introduces dedicated `metals_transactions`, migrates existing metals transaction rows out of `stock_transactions`, and refreshes `portfolio_transactions` compatibility view joins ([[alembic/versions/0018_metals_transactions_inheritance_split.py]]).

## Portfolio Transactions

### Transaction Types

| Type | Description |
|------|-------------|
| buy | Purchase of units |
| sell | Sale of units |
| gift | Gifted units (optionally with basis amount) |
| dividend | Dividend payment |
| fee | Transaction fees |
| tax | Tax payments |
| interest | Interest income |
| rent_income | Rental income (real estate) |
| appreciation | Value appreciation |

### Recording Transactions
```javascript
POST /api/investments/:id/transactions
{
  "type": "buy",
  "date": "2026-01-15",
  "amount": 1855.00,
  "units": 10,
  "price_per_unit": 185.50,
  "fees": 5.00,
  "currency": "USD",
  "fx_rate_to_eur": 0.9200000000
}
```

- `fx_rate_to_eur` is optional and persisted per transaction to preserve the effective FX used at booking time.
- **Auto-resolve (2026-06-11, ADR-074):** On `POST /api/investments/:id/transactions` and `PATCH /api/investments/transactions/:txnId`, when `currency ≠ EUR` and `fx_rate_to_eur` is not supplied, the backend resolves the on-or-before stored rate from `exchange_rates` (≤7-day lookback, DB-only — no outbound HTTP). On PATCH, a date or currency change also recomputes `fx_rate_to_eur` unless the field is explicitly provided in the request.
- Add/Edit portfolio transaction dialogs now expose an optional `fx_rate_to_eur` input so users can lock a manual booking FX per transaction.
- Backend create path reuses preloaded investment metadata by passing `preloaded_asset_class` from investments route into `portfolioTransactionRepository.create(...)`, removing a duplicate asset-class lookup query while preserving validation and response behavior.
- Investment live price refresh now applies bounded write concurrency (batched updates) instead of an unbounded all-at-once write fan-out, reducing pool contention risk while preserving refresh result payload semantics.
- Investment list (`GET /api/investments`) and per-investment transaction list (`GET /api/investments/:id/transactions`) now use repository one-query pagination (`getAllWithCount`) instead of separate list/count round-trips, preserving filters, ordering, and response payloads while reducing DB calls ([[apps/node-backend/src/routes/investments.js]], [[apps/node-backend/src/repositories/investmentRepository.js]], [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]).
- Portfolio transaction update now reuses `existing.asset_class` from the already-loaded transaction and falls back to a DB lookup only when missing, reducing redundant lookups while preserving validation and write behavior ([[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]).

### Editing Portfolio Transactions

Portfolio transaction edits are supported via a dedicated edit modal.

Rules:
- `type` is immutable (cannot be changed after creation).
- All other transaction fields are editable, including date, amount/unit/price inputs, fees/taxes, note, and recurring settings.
- `fx_rate_to_eur` is editable as an optional field in the transaction dialogs.
- Unit-based buy/sell edit math keeps the same 2-of-3 pricing normalization rules as create.
- Unit-based `sell` validation enforces holdings sufficiency on both create and update (oversell transactions are rejected).
- `updated_at` captures edit timestamps.
- Migration compatibility: when `portfolio_transactions` is a compatibility view in inherited schemas, migration `0016_add_fx_rate_to_portfolio_transactions` guards `ALTER TABLE` by relation kind (`r`/`p` only), while preserving the view recreation path for `relkind='v'` ([[alembic/versions/0016_add_fx_rate_to_portfolio_transactions.py]], [[docs/guides/deployment|Deployment Guide]]).

When `fx_rate_to_eur` is left empty, portfolio FX conversion uses historical rates from `exchange_rates` by transaction date; missing historical rows are auto-backfilled from ECB historical data on startup, with nearest stored DB rate as fallback.

Code links: [[apps/frontend/src/components/portfolio/AddPortfolioTxnDialog.tsx]], [[apps/frontend/src/components/portfolio/EditPortfolioTxnDialog.tsx]], [[apps/frontend/src/hooks/usePortfolio.ts]], [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]], [[apps/node-backend/src/services/currency/currencyConversionService.js]], [[apps/node-backend/src/main.js]]

## Holdings Calculation

Portfolio calculates:
- **Total Units**: Net units across buy/gift/sell transactions
- **Average Cost**: Weighted average purchase price (displayed in investment native currency on Stocks/ETFs/Metals page)
- **Current Value**: Units × Current Price (displayed in investment native currency on Stocks/ETFs/Metals page)
- **Total Dividends**: Sum of all dividend transactions
- **Total Fees**: Sum of all fees
- **Gains/Losses**: Realized/Unrealized P&L is FX-aware using transaction `fx_rate_to_eur` when present, otherwise falling back to exchange-rate map conversion

Oversell safety behavior:
- Backend now blocks oversell create/update operations for unit-based assets (`stock`, `etf`, `crypto`, `metals`) by validating `sell` units against net holdings on the transaction date.
- Frontend calculation paths clamp sell processing to available pooled units so legacy invalid datasets do not produce exaggerated realized gains/losses.
- Investment detail modal can display both base portfolio metrics and FX-aware realized/unrealized values when provided by stocks/ETF listing flows.
- Metals listing explicitly uses base (non-FX-aware) realized/unrealized calculations.

Code links: [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/types/api.ts]], [[apps/node-backend/src/routes/investments.js]], [[alembic/versions/0016_add_fx_rate_to_portfolio_transactions.py]]

### Portfolio Unit Math — Shared Frontend Library (June 2026)

`apps/frontend/src/lib/portfolioUnitMath.ts` is a new shared module consumed by both the **Add** and **Edit** portfolio transaction dialogs:

```typescript
// Named precision constants (4 DP for units, 8 DP for price, 6 DP for FX)
export const UNIT_PRECISION = 4;
export const PRICE_PRECISION = 8;
export const FX_PRECISION = 6;
export const TOLERANCE = 0.0001;

// Derive the third field when two of amount/units/price are filled
export function deriveUnitMath(
  amount: number | null,
  units: number | null,
  price: number | null,
): { amount: number; units: number; price: number } | null
```

`deriveUnitMath` fills the missing field (whichever of amount/units/price is null) using the other two and rounds to the appropriate precision. It returns `null` when fewer than two inputs are non-null (nothing can be derived).

This eliminates the prior copy-paste inconsistency where Add and Edit dialogs used different rounding constants and tolerance checks.

### snapshotBuilder Improvements (June 2026)

`apps/node-backend/src/services/portfolio/snapshotBuilder.js` received three correctness fixes that make the historical Net Worth chart consistent with the live portfolio summary:

**1. Timezone-correct day-walk boundary**

The end-of-day boundary for the forward-simulation loop is now derived via `toAppDateString(new Date(), APP_TIMEZONE)` rather than UTC date. Portfolios with transactions close to midnight (in the user's timezone) were previously misattributed to the wrong day.

**2. `split` event type handling**

The day-loop now processes `split` transaction types. A stock split resets the per-investment unit count to the post-split total (rather than adding units as if it were a buy). This mirrors the live `calculateCostBasis` function and fixes Net Worth chart values for portfolios with historic splits.

**3. `return_of_capital` event type handling**

`return_of_capital` transactions now reduce the `runningInvested` cost basis by the returned amount, matching accounting convention and the live summary calculation.

**4. Buy/sell unit math uses Decimal**

`repositories/portfolioTxRepo.common.js` buy/sell/gift calculations now use Decimal `roundMoney()`, `multiply()`, and `divide()` instead of `roundTo()` with native float arithmetic. This eliminates the remaining FP drift in portfolio transaction math.

Code links: [[apps/node-backend/src/services/portfolio/snapshotBuilder.js]], [[apps/node-backend/src/repositories/portfolioTxRepo.common.js]], [[apps/frontend/src/lib/portfolioUnitMath.ts]]

### Portfolio Decimal Precision (May 2026 Audit)

All portfolio aggregation now uses Decimal.js to eliminate IEEE 754 floating-point drift:

**Monetary calculation paths:**
- `portfolioSummaryService.js`: Per-investment accumulators, FX multiplier aggregation, `aggregateTotals()` all use `multiply()` and Decimal accumulation
- `portfolio/snapshotBuilder.js`: `cumulativeInvested`, per-class totals, `totalValue`, `cumulativeInflation` computed via Decimal; `convertAmount()` returns Decimal for safe FX composition
- Frontend hooks: `usePortfolioSummaries.ts`, `usePortfolioCalculations.ts` (fixed gross/net bug: `totalSellProceeds` now scales by `sellRatio` via Decimal division)
- `portfolioMath.js`: `calculateAccruedInterest()`, `computeMetrics()` use `calendarDaysBetween` helper for precise day counts (not floating-point averages)

**Benefits:**
- No phantom balances from FX-aware composition (e.g., 3 FX rates × 20 stocks = exact sum, not ±0.01 rounding)
- Snapshot consistency: cost basis matches database NUMERIC precision
- Oversell prevention: unit holdings validated against precise cost basis, not approximated floats

## Belgian Tax Features

### Real Estate Fields
- `municipality`: Belgian municipality name
- `cadastral_income`: Kadastraal inkomen
- `municipality_tax_rate`: Municipal tax rate

These support Belgian tax reporting requirements.

## Watchlist

Track investments without owning them:

```javascript
POST /api/watchlist
{
  "name": "Tesla Inc.",
  "symbol": "TSLA",
  "asset_class": "stock",
  "target_price": 250.00,
  "currency": "USD"
}
```

Watchlist asset-class selection includes metals.

## Portfolio Routing and Reuse

### Metals Page DRY Refactor (Phase 3.5)

- Added a dedicated Metals page at `/portfolio/metals`.
- Sidebar navigation includes a Metals entry.
- Stocks listing page was refactored to accept configurable asset classes/title/empty state so Metals can reuse the same listing UX with metals-only filters.
- Default Stocks & ETFs page scope is now strictly `stock` + `etf` (metals excluded), while the Metals page remains metals-only via explicit props.
- Add Investment actions are context-restricted: Stocks & ETFs page allows only stock/etf classes, and Crypto page allows only crypto class.
- **Phase 3.5 Enhancement**: `MetalsPage.tsx` is now a thin DRY wrapper that passes configurable props to `StocksPage`: `assetClasses={["metals"]}`, `titleKey="metals.title"`, `emptyTitleKey="metals.noMetals"`, `emptyDescriptionKey="metals.noMetalsDesc"`, `allowedAddAssetClasses={["metals"]}`. FX-aware P&L is enabled by default. StocksPage handles all asset-class logic without code duplication.

Code links: [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]], [[apps/frontend/src/App.tsx]], [[apps/frontend/src/components/layout/AppSidebar.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]]

## Backend Enablement (Metals)

- `asset_class` enum now includes `metals` with an idempotent `ALTER TYPE ... ADD VALUE` guard for existing databases.
- Schema version was bumped to `20260324_1`.
- Investment repository adds metals child-table mapping, validation, and allowed-field handling.
- Portfolio value computation includes metals in market-priced classes.
- Yahoo provider docs/description explicitly include metals tickers such as `GC=F`.
- Migration `0017_investment_custom_provider_history` ensures `metals_investments` exists and updates the `investments` compatibility view/trigger to include metals rows in mixed-schema deployments.

Code links: [[apps/node-backend/src/repositories/investmentRepository.js]], [[apps/node-backend/src/repositories/infoRepository.js]], [[apps/node-backend/src/services/priceProviderService.js]]

## Net Worth Tracking

Portfolio automatically contributes to net worth calculations.

Current behavior:
- Net Worth chart uses **daily snapshots** instead of monthly snapshots.
- Net Worth chart header now includes a series toggle (**Total / Investments / Liquid**) so users can inspect one component at a time instead of always overlaying all three lines.
- Zoom interactions now guard against empty/invalid visible-domain slices and fall back to full displayed data domain to avoid blank chart rendering when zooming out aggressively.
- Net Worth x-axis month labels now follow the app language locale (EN/NL) rather than numeric formatting locale, preventing unexpected German month names when number format is set to EU-style separators.
- Net Worth chart supports horizontal scrolling across multi-year ranges while keeping month-based x-axis labels, and opens focused on the latest period.
- When scrolled away from the right edge, a subtle **Latest** action appears in the chart header to jump back to the newest period.
- Net Worth chart includes lightweight x-axis zoom controls so users can zoom out and fit more daily history into a single viewport.
- Net Worth zoom-out levels now include ultra-wide densities (down to quarter-day width equivalents), so full history can be viewed in one screen when desired.
- Net Worth zooming now preserves the user’s viewport anchor ratio, preventing sudden loss of visible context after zoom in/out actions.
- Net Worth chart now runs in **daily mode only** (Daily/Weekly toggle removed), with per-day hover tooltips for exact portfolio values by date.
- Net Worth chart y-axis uses a selected-series, visible-window domain with explicit fallback domain handling; this avoids broad `0..max` autoscale ranges when data remains tightly clustered.
- Net Worth summary cards use localized `% of net worth` text without duplicating the `%` symbol.
- Chart now renders a horizontal reference guide at the current value of the selected series (Total/Investments/Liquid) and denser Y-axis ticks to improve value readability.
- The Y-axis visible-domain calculation and reference guide now follow the selected series (total/investments/liquid), improving fluctuation readability when one component dominates absolute portfolio size.
- Y-axis quantity labels are rendered on the right side of the graph for direct value reading without a separate legend panel.
- Y-axis domain snaps to “nice” rounded steps (1/2/5 × 10^n), producing human-friendly tick values (e.g. 100, 500, 1,000, 5,000) instead of arbitrary decimal breakpoints.
- Daily breakdown now uses the shared `VirtualDataTable` pattern (virtualized rows) so large histories don’t render all table rows at once.
- Y-axis domain adapts to the currently visible window so local movement remains readable even when global historical peaks exist.
- Net Worth requests and renders values in `appSettings.defaultCurrency` (via `GET /api/info/net-worth?currency=...`) and formats amounts with app locale + decimal settings.
- Snapshot range starts at the first available data date and runs through today.
- Net-worth route response is cached in-memory per target currency for 60 seconds with in-flight request deduplication to reduce repeated expensive recomputation.
- Seed date is the minimum of first portfolio transaction date, first active investment creation date, and first active transaction date.
- Portfolio cashflow contribution is computed from that seed date onward, removing prior-year hard-cutoff behavior.
- For unit-priced assets (stocks/ETFs/crypto/metals), daily net worth valuation now starts from each investment’s own first activity date and values days with provider historical close quotes first; when quote history is missing, it falls back to the latest known transaction unit price carry-forward (never mutable `current_price` for past days).
- Liquid side now falls back to cumulative transaction flow when account balance snapshots are unavailable.
- If seed date discovery via active-only rows returns empty, net worth now retries with non-filtered seed discovery so legacy rows still produce non-zero snapshots.
- Latest-day investment snapshot is now reconciled against active holdings and `current_price`, so net worth no longer stays at zero when historical portfolio transaction aggregation is incomplete.
- Daily net worth snapshots sanitize isolated one-day investment needles (spike/trough reversal + local needle ratio check) by replacing only the outlier day with geometric interpolation between neighboring days; downstream monthly change/baseline values use the sanitized series.
- Net worth backend logs fallback paths and final computed summary metrics (currency, seed date, snapshot count, current totals) for easier debugging when users report zeroed dashboards.
- Regression tests cover transactions-only (no investments) workspaces to keep non-zero liquid/net worth responses correct.
- Regression tests cover isolated one-day unit investment spike sanitization in net worth snapshots ([[apps/node-backend/tests/infoRepository.test.js]]).
- Backend startup now triggers live price refresh after the API starts accepting requests, so startup remains non-blocking for users.
- For Kinesis investments that already have a persisted `current_price`, startup uses that stored value immediately and defers the external Kinesis refresh to a background task.
- If a Kinesis investment has no usable stored price, startup still includes it in the immediate refresh set to preserve first-load correctness.
- Portfolio hook transaction loading now uses a single bulk API call (`GET /api/investments/transactions`) with fallback to per-investment calls when bulk endpoint is unavailable.
- Portfolio summaries now pre-group transactions by `investment_id` before per-investment calculations, reducing repeated global scans during render/memo recompute.
- **Snapshot atomicity (2026-04-29)**: `computeAndStoreSnapshots()` now wraps DELETE + batched INSERTs in a single PostgreSQL transaction. This guarantees concurrent readers (e.g., `/api/info/net-worth` requests during startup warmup) see either fully-old or fully-new snapshots via MVCC, never a torn/partial table. Fixes a race condition where concurrent reads could trigger cache of zero portfolio value. See [[docs/adr/043-portfolio-snapshot-atomicity|ADR-043]].
- **Snapshot valuation parity (2026-05-18)**: `snapshotBuilder` non-unit asset formulas were rewritten to mirror `portfolioSummaryService` exactly, eliminating a 2,142.24 € divergence between Net Worth "Investments" and Portfolio Overview / Performance "Portfolio Value". Fixed-income (savings/bond): `value = runningInvested + accruedInterest` where accrual walks `interest`/`buy`/`gift`/`sell` transactions day-by-day. Real-estate: `value = runningInvested + cumulativeAppreciation` via explicit `appreciation` transactions. Unit-based assets: the latest-day snapshot uses `investments.current_price` directly, so Net Worth always reconciles with the live summary even after a price refresh. All three pages (Dashboard, Performance, Net Worth) now show the same value for the same day. Historical chart will redraw on next snapshot run as accrued interest and appreciation are applied retroactively. See [[docs/adr/061-snapshot-valuation-parity|ADR-061]].

- **Historical FX in snapshots (2026-05-29)**: `snapshotBuilder.js` now loads a full historical `exchange_rates` index (per currency, sorted day arrays) alongside the existing `is_latest` rates. A binary-search `rateToEurOnOrBefore(currency, day)` lookup finds the most recent stored rate on or before each day. `convertAmount(amount, currency, fxRateToEur, asOfDay)` uses this to convert values at the rate that applied at the time:
  - **Market value** (unit-based assets): converted at the rate on the snapshot day, not today's.
  - **Invested capital** (transaction amounts): converted at the rate on the transaction date, or at the stored `fx_rate_to_eur` when present.
  - **Latest day**: always uses the `is_latest` rate so the headline snapshot value reconciles with `/portfolio-summary` (and the Net Worth "Investments" total remains consistent with Portfolio Overview).

  > [!info] Invested cost-basis — resolved by ADR-074 (2026-06-11)
  > The snapshot `invested` column uses transaction-date FX rates. As of ADR-074, the live Portfolio Summary endpoint also converts invested capital at transaction-date rates (no longer at today's rate). Performance page "Total Invested" and Portfolio Overview "Total Invested" now use the same semantics — the prior divergence is closed.

Code links: [[apps/node-backend/src/repositories/infoRepository.js]], [[apps/node-backend/tests/infoRepository.test.js]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]], [[apps/frontend/src/lib/api.ts]], [[apps/node-backend/src/services/portfolio/snapshotBuilder.js]], [[apps/node-backend/tests/portfolioPerformanceSnapshotService.test.js]]

## Cross-Currency Display Normalization

- Portfolio Overview, Performance, Portfolio Tax, and asset listing pages now normalize displayed monetary amounts to `appSettings.defaultCurrency`.
- UI conversion uses live rates from `/api/info/exchange-rates` so cards, charts, and tables aggregate mixed-source currencies consistently in the selected target currency.
- Percentage metrics remain unchanged (no currency conversion applied).
- Asset page scope includes Stocks, Crypto, Real Estate, and Savings; Metals inherits the same behavior by reusing Stocks page logic.
- Performance chart valuation now consumes custom-provider historical points (when configured) for unit-based investments; past points without historical quotes are skipped instead of falling back to mutable `current_price`.
- Performance historical series determinism: historical unit-priced valuation no longer depends on live `current_price`, preventing retroactive chart shifts after startup price refresh.
- Performance startup rendering now avoids blocking day-level graph computation on net-worth snapshot availability; the chart can render immediately from portfolio transactions + persisted price history and later reconciles with net-worth overlays when snapshot data arrives.
- Performance price-history requests are bounded to the portfolio transaction date range (`from_ms`/`to_ms`) to reduce startup payload size and history-query latency.
- Performance graph history requests use DB-only mode (`db_only=true`) so chart rendering is decoupled from live provider latency/timeouts (for example Kinesis network timeouts) and uses persisted `asset_price_history` immediately.
- Performance inflation requests now use DB-only mode (`/api/info/inflation-rates?db_only=true`) so inflation-adjusted series render from persisted DB rates immediately while external Statbel/Eurostat refresh runs in background.
- Performance absolute class series (Stocks & ETFs, Crypto, Metals) no longer apply proportional rescaling to match net-worth total overlays; class lines remain true class-native valuations to avoid visual distortion.
- Performance top summary cards are now pinned to **overall portfolio** metrics (independent of selected chart period), matching portfolio-level totals.
- Performance invested-capital summary now aligns with dashboard semantics by using total buy cost aggregation in target currency.
- Performance total return uses aggregated `totalGain` semantics, while annualized return is computed as CAGR from current value vs invested capital over tracked duration.
- Performance value-over-time now uses day-level snapshot points (daily timeline) for absolute and relative charts, improving fluctuation fidelity versus month-only series.
- Performance value-over-time class series (stocks+ETFs/crypto/metals) now align to the same day-level timeline used by portfolio totals.
- Performance chart x-axis now keys by day (`YYYY-MM-DD`) internally and formats ticks as locale-aware month-year labels for readability.
- Relative performance now applies contribution adjustment using day-keyed net flows (`YYYY-MM-DD`) rather than month-bucket flow alignment for chart series.
- Performance flow/invested conversion now uses transaction `fx_rate_to_eur` when present, reducing historical drift from live FX-rate refreshes.
- Performance includes a relative-performance chart for entire portfolio, stocks+ETFs, crypto, and metals using contribution-adjusted return chaining (Modified Dietz-style cash-flow handling) to avoid inflated percentages when capital contributions are large.
- Relative chart scaling fix: chained performance index baseline is `1` (not `100`), and plotted percentage now uses `(index - 1) * 100`; this removes 10x/100x over-scaling (for example, `2000%` shown instead of `200%`).
- Performance absolute chart now explicitly plots class lines for stocks+ETFs, crypto, and metals; stocks+ETFs line uses a red stroke for faster visual separation from total portfolio.
- Relative performance chart keeps stocks+ETFs line in red to align class-color semantics between absolute and relative views.
- Performance Portfolio Value Over Time legend de-duplicates Area series so each label appears once (Stocks & ETFs, Crypto, Metals, Portfolio Value) with no visual regression in plotted data ([[apps/frontend/src/pages/portfolio/PerformancePage.tsx]]).
- Monthly heatmap remains **month-based** and represents relative monthly investment returns (%) (investment performance only; no liquid-cash component).
- Monthly heatmap return formula: `monthlyReturn = (currValue - prevValue - netFlow) / denominator`, with `denominator = prevValue + netFlow / 2` and fallback `denominator = prevValue` when computed denominator `<= 0`.
- Heatmap first month is now `null` (no data) instead of forced `0.00%`, so the first displayed month does not imply a measured return without a prior month anchor; YTD is compounded from available non-null monthly returns.
- Performance month labels for charts and heatmap now always follow app language locale (`en-US`/`nl-NL`) rather than number-format locale, preventing German month names when number format is set to EU style.
- Performance inflation adjustment now uses Belgian monthly rates from backend (`/api/info/inflation-rates`) instead of hardcoded EU annual assumptions; real return and inflation-adjusted value are compounded month-by-month using backend month keys (`YYYY-MM`).

## Offline Resilience: Stale Price Indicators & Empty States

When internet is unavailable and the backend cannot reach live price providers, the portfolio UI degrades gracefully:

### Online Status Detection & React Query Integration
- New hook `useOnlineStatus()` ([[apps/frontend/src/hooks/useOnlineStatus.ts]]) exposes browser online state via `navigator.onLine` and listens to window `online`/`offline` events for real-time updates.
- Components using online status gate expensive queries and refetch intervals:
  - **PortfolioNewsFeed**: query enabled only when `isOnline`, refetchInterval conditional, `retry: 1` only online, `refetchOnWindowFocus: false`, shows `WifiOff` empty-state when offline.
  - **WatchlistPage**: quotes query enabled only when `isOnline`, conditional refetchInterval, `retry: 1` only when online.
  - **AddToWatchlistDialog, WatchlistChartDialog**: queryFns wrapped in try/catch, `retry: false`, `refetchOnWindowFocus: false` to prevent unhandled rejections / spinner storms when offline.

### Price Guard Rails (2026-04-28 Bug Fixes)
- **WatchlistChartDialog**: Validates `target_price` against `Number.isFinite() && > 0` before rendering chart domain; falls back to `[0, 1]` when no valid prices exist; removed unsafe `priceDiff!` assertions to prevent NaN chart rendering.
- **AddToWatchlistDialog**: Guards `quoteData.price` with `Number.isFinite() && > 0` before `.toFixed()` to prevent "undefined" string interpolation and divide-by-zero in percentage calculations.
- **PortfolioOverviewPage**: Pre-computes `totalAllocation` to avoid O(N²) reduce calls inside legend `.map()`, improving render performance on large portfolios.

### Stale Price Indicators
- Frontend utility `priceStaleness.ts` detects investments with `price_updated_at` older than 24 hours.
- Component `StalePriceIndicator.tsx` renders a small clock icon next to stale prices in holdings tables with a tooltip showing the last-updated date.
- Manual-provider investments are never marked stale; missing/un-parseable `price_updated_at` is treated as stale.

### Stale Prices Banner
- Component `StalePricesBanner.tsx` appears above portfolio holdings tables (Stocks, ETFs, Metals, Crypto) when one or more holdings have stale prices.
- Banner shows count of stale holdings and includes a "Refresh Prices" button that triggers `usePortfolio().refreshPrices` for explicit retry.
- Wired in `StocksPage.tsx`, `MetalsPage.tsx` (via DRY props to `StocksPage`), `CryptoPage.tsx`, and `PortfolioOverviewPage.tsx`.

### News Feed Reconciliation (2026-04-28 Bug Fix)
- **PortfolioNewsFeed**: Replaced index-based React key with `article.link` (with `publishedAt+title` fallback) to prevent reconciliation issues on refetch reorder; ensures articles maintain correct component state across API refreshes.

### Performance & Net Worth Empty States
- `PerformancePage.tsx`: dedicated `<PerformanceEmptyState>` replaces spinner when snapshots are empty; shows "No performance history yet" + "Refresh Prices" CTA to trigger initial snapshot backfill.
- `NetWorthPage.tsx`: added empty-state branch ("No net worth history yet" + refresh CTA) when snapshots are empty; wires `StalePricesBanner` above the chart.
- Both pages show these states only when no snapshots have been recorded yet, allowing graceful display instead of indefinite spinners.

### Offline Error Handling
- `useInvestments()` hook's `refreshPricesMutation.onError` now checks `navigator.onLine` and shows i18n key `portfolio.refreshPricesOffline` instead of raw error message when offline.
- This provides user-friendly context-aware error messaging during connectivity issues.

### Report Timestamp Metadata (Phase 8)
- PDF report cover page now includes a "Prices as of <date>" row showing `MAX(price_updated_at)` across active holdings.
- If prices are >1 day old, age in days appears next to the date (e.g., "Prices as of 2026-04-25 (2 days old)").
- If no live prices have ever been recorded, shows "No live prices recorded" to indicate data freshness uncertainty.

Code links: [[apps/frontend/src/hooks/useOnlineStatus.ts]], [[apps/frontend/src/utils/priceStaleness.ts]], [[apps/frontend/src/components/portfolio/StalePriceIndicator.tsx]], [[apps/frontend/src/components/portfolio/StalePricesBanner.tsx]], [[apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]], [[apps/frontend/src/hooks/portfolio/useInvestments.ts]], [[apps/node-backend/src/services/reports/index.js]], [[apps/node-backend/src/repositories/investmentRepository.js]]

## Performance Page Rewrite (Server-Computed Response)

The Performance page architecture was significantly refactored to move heavy computations from the client to the server:

**Backend enhancements (`/api/info/portfolio-performance`):**
- New `period` query parameter: `5d|1m|3m|6m|1y|3y|all` (default `all`) for period-filtered chart data
- Response now includes **pre-computed metrics, heatmap, and per-investment breakdown** — not just snapshots
- `metrics` object: `currentValue`, `totalInvested`, `totalGainLoss`, `totalReturnPct`, `annualizedReturn`, `realReturnPct`, `cumulativeInflation`
- `heatmap` object: contribution-adjusted monthly returns per year-month (fixed formula: `((curr.value / curr.invested) / (prev.value / prev.invested) - 1) * 100`)
- `breakdownSummary` array: per-investment values all pre-converted to target currency server-side
- **Period-filtered snapshots** are downsampled to ~400 points server-side using LTTB, while metrics/heatmap always use full historical data
- Cache key includes period: `${currency}:${period}` for independent caching per period
- New service: [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]] with functions: `computeMetrics(snapshots)`, `computeHeatmap(snapshots)`, `getBreakdownSummary(currency)`
- New utility: [[apps/node-backend/src/utils/downsample.js]] — LTTB downsampler ported to backend

**Frontend simplification (`PerformancePage.tsx`, `PerformanceBreakdown.tsx`):**
- Removed 4 heavy useMemo blocks: `filteredSnapshots`, `downsampledSnapshots`, `overallMetrics`, `heatmapData`
- Kept only 2 lightweight mapping transforms: `chartData`, `relativePerformanceData`
- `selectedPeriod` now in query key and API call parameter
- `PerformanceBreakdown.tsx` now accepts pre-computed `breakdownSummary` and `heatmapData` as props (values already converted by server)
- Removed `usePortfolio()` hook (eliminated request waterfall)
- Removed `useQuery` for exchange rates in breakdown component
- Removed `convertToTarget` helper (server now does all conversions)

**Performance impact:**
- Page load requests: 4 sequential API calls → 1 single request
- Payload for 1-month view: ~1000 snapshot rows → ~30 rows + metrics + heatmap + breakdown
- Client-side memo chains: 6 heavy → 2 lightweight
- **Heatmap accuracy fix**: Contribution-adjusted returns now correctly account for cash flows; old formula conflated deposits/withdrawals with investment performance

**Short-period chart formatting:**
- **X-axis adaptive formatting**: For periods ≤ 6 months (5d, 1m, 3m, 6m), x-axis ticks display day + month (e.g., "15 Jan"). For periods > 6 months (1y, 3y, all), ticks display month + year (e.g., "Jan 26"). Locale-aware formatting follows app language (en-US/nl-NL) for month names.
- **Y-axis adaptive domain**: For short periods (5d, 1m, 3m), the Y-axis uses `auto/auto` domain to zoom into the data range and highlight price fluctuations. For longer periods (≥ 6m), Y-axis uses `0/auto` domain to anchor at zero, showing full historical context.

Code links: [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/components/portfolio/PerformanceBreakdown.tsx]], [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]]

Code links: [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]], [[apps/frontend/src/lib/api.ts]]

## Portfolio Summary: Single Source of Truth (Phase 14)

### Problem Solved

Prior to Phase 14 (2026-04-29), dashboard and performance page displayed portfolio totals via two separate computation paths with different FX timing, causing visible divergence:

- **Dashboard**: Client-side computation via loop over per-investment summaries; FX conversion applied at request time
- **Performance page**: Server-side computation from pre-computed daily snapshots; FX rates embedded from snapshot creation time (potentially stale by days)

Result: Same portfolio, same moment, different total values shown on two pages (e.g., EUR 100,000 vs EUR 99,999.50).

### Solution: `/api/info/portfolio-summary`

New realtime endpoint serves portfolio totals (currentValue, totalInvested, totalGainLoss, realized, unrealized, fees, taxes, income, totalReturnPct) as single source of truth:

**Backend:**
- New service `portfolioSummaryService.js` with `getPortfolioSummary(targetCurrency)` function
- Computes totals server-side with FX conversion applied pre-serialization
- Returns both aggregate `totals` object and per-asset-class `summaries` array
- 60-second in-memory cache with invalidation on any investment/transaction write
- Inflight request deduplication prevents cache stampede on cold start

**Frontend:**
- Dashboard headline cards now source from `usePortfolioSummaryQuery(displayCurrency)` instead of client-side FX loop
- Performance page headline metrics overridden with realtime values from portfolio-summary endpoint
- Snapshot timeseries (value-over-time chart) still uses historical performance snapshots; only headline totals come from realtime summary

**Reconciliation invariant** (verified by test):
```
sum(summaries[].currentValue) === totals.currentValue
sum(summaries[].invested) === totals.invested
(totalGainLoss / totalInvested) × 100 = totalReturnPct
```

### Cache Invalidation Strategy

Cache cleared atomically on any investment or transaction write:
- Investment creates, updates, deletes
- Portfolio transaction creates, updates, deletes
- Transaction creates, updates, deletes (affecting portfolio cash flows)

All invalidations cascade through `clearInvestmentsCaches()` → `invalidatePortfolioCaches()` for consistent state.

### Rate Limit & Performance

- **Rate limit**: 60 req/min (higher than portfolio-performance at 30 req/min due to frequent dashboard renders)
- **Cache TTL**: 60 seconds (balances freshness with latency; price refreshes happen on 5+ min intervals)
- **Latency**: ~200-400ms on cache miss (concurrent FX conversion + asset aggregation); instant on cache hit

### Reference

- **API doc**: [[docs/api/portfolio-summary|Portfolio Summary API]]
- **ADR**: [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044]]
- **Code**: [[apps/node-backend/src/services/portfolio/portfolioSummaryService.js]], [[apps/node-backend/src/routes/info/portfolioSummary.js]], [[apps/frontend/src/hooks/portfolio/usePortfolioSummary.ts]]

## Belgian Inflation Data Flow

- Backend now owns Belgian inflation sourcing and caching via Statbel-backed service with Eurostat fallback; frontend consumes monthly rates through the info API.
- Data path and fallback order: in-memory cache (24h) -> PostgreSQL persisted rows -> remote Statbel fetch -> remote Eurostat HICP index fallback; if both remote sources fail, service falls back to persisted DB data.
- Startup/scheduled behavior: backend warms inflation cache at startup and refreshes together with exchange-rate refresh cadence.
- New persistence table `belgian_inflation_rates` stores monthly values (`month_date`, `monthly_rate`, `source`, `fetched_at`, `updated_at`) for deterministic portfolio calculations and offline resilience.

Code links: [[apps/node-backend/src/services/belgianInflationService.js]], [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/main.js]], [[apps/frontend/src/lib/api.ts]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]]

### Performance Improvements (2026-05-08 Bug Hunt)

**Batch INSERT for Inflation Data:** `belgianInflationService.js` now chunks inflation rate inserts into 1000-row batches using multi-row `INSERT ... VALUES` instead of per-row INSERTs, eliminating N+1 round-trips and reducing import time by ~10x for full Statbel refreshes (400+ rates).

**UTC Date Handling in Quote Backfill:** `quoteBackfillService.js` now uses `getDayKeyUtc()` helper instead of local-time `new Date().getFullYear/Month/Date()` to compute day keys, avoiding off-by-one errors near UTC midnight. Ensures consistent key format regardless of server timezone.

## Historical Asset Quote Persistence

- Historical provider prices are now persisted in `asset_price_history` and reused by portfolio valuation flows.
- Price history endpoint and portfolio calculations use read-through behavior: DB history first, provider fetch when needed, then DB upsert.
- Startup backfill populates historical quotes for currently held unit-based assets (`stock`, `etf`, `crypto`, `metals`) from first transaction date.

Code links: [[apps/node-backend/src/services/priceProviderService.js]], [[apps/node-backend/src/main.js]], [[alembic/versions/0019_asset_price_history_cache.py]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]]

## Cost Basis Methods (Phase 6)

Portfolio tax calculations support multiple cost basis accounting methods, configurable as a user preference in Settings.

> [!info] Wired end-to-end since 2026-06-11 (ADR-073)
> Until Audit Round 7 the setting was persisted but never read — both the backend summary
> service and the frontend hooks hard-called weighted average. The calculators now live in
> `@vision/shared-utils/portfolio` ([[docs/adr/073-shared-portfolio-math-package|ADR-073]]) and
> `portfolioSummaryService` / `usePortfolioSummaries` both dispatch on the stored
> `cost_basis_method` (invalid/missing values fall back to `weighted_avg`).

**Available methods:**

1. **Weighted Average** (default) — Moving average cost per unit; commonly used for tax simplicity
2. **FIFO** (First-In, First-Out) — Oldest lots sold first; often minimizes tax in rising markets
3. **LIFO** (Last-In, First-Out) — Newest lots sold first; often maximizes deductions in falling markets

**Selection:** User can set preferred cost basis method in Settings → General tab (`settings.general.costBasisMethod` in i18n).

**Implementation:**

- Shared calculation functions in `@vision/shared-utils/portfolio` (re-exported by `[[apps/node-backend/src/utils/portfolioMath.js]]` and `apps/frontend/src/hooks/portfolio/usePortfolioCalculations.ts`):
  - `calculateCostBasis()` — Weighted average method
  - `calculateCostBasisFIFO()` — FIFO method (immutable-safe: uses spread operations, returns immutable lot copies)
  - `calculateCostBasisLIFO()` — LIFO method (immutable-safe: uses spread operations, returns immutable lot copies)
  - All calculators accept optional `opts.fxMultiplier` (per-transaction FX multiplier array) and `opts.defaultFxMultiplier` (fallback when a transaction has no stamped rate); they return a parallel **converted track** (`totalCostConv`, `avgCostBasisConv`, `realizedGainConv`, `totalBuyCostConv`, `totalSellProceedsConv`) — added in ADR-074 so both sides compute lot-accurate converted realized gains
  - `buildInvestmentSummaryCore(inv, txns, opts)` accepts `opts.fxMultiplierNow` (today's rate for current-value conversion) and returns a `converted` block alongside the native block; with no FX inputs it degrades to native numbers (previous behaviour)
  - All support `buy`, `sell`, `gift`, `split`, `return_of_capital`, `merger`, `spinoff` transaction types
  - `applyEventToLots()` helper handles corporate actions (splits, return_of_capital) with immutable lot transformations
- Frontend types in `[[apps/frontend/src/stores/settingsStore.ts]]`: `type CostBasisMethod = 'weighted_avg' | 'fifo' | 'lifo'`
- Settings storage: persisted in user `AppSettings` via Zustand + backend sync
- Tax page displays gains/losses using the selected method for accurate year-end reporting

**Corporate Action Support:**

All cost basis methods handle:
- **Stock splits** — Unit count adjusts; cost basis per lot unchanged
- **Spinoffs** — New units tracked separately
- **Mergers** — Cost-basis-neutral treatment
- **Return of Capital** — Reduces cost basis per unit across all lots

Code links: [[apps/node-backend/src/utils/portfolioMath.js]], [[apps/frontend/src/stores/settingsStore.ts]], [[apps/frontend/src/components/settings/DashboardSettingsDialog.tsx]]

## Info Card Security Hardening (Phase 9)

Portfolio info cards (Crypto, Savings, Real Estate, Stocks) previously rendered translations via `dangerouslySetInnerHTML`. This pattern was unnecessarily risky. Since translation strings are plain text with no embedded HTML, all info cards now render translations as plain text: `{t(...)}` instead of `dangerouslySetInnerHTML={{ __html: t(...) }}`. This eliminates the XSS surface while maintaining identical output.

Code links: [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[docs/security/data-protection#xss-prevention]]

## Portfolio Asset Page Loading and Error States (2026-05-29)

The four portfolio asset pages — Stocks & ETFs, Crypto, Savings, and Real Estate (Metals renders via `StocksPage` with `assetClasses={["metals"]}`) — now handle loading and error conditions explicitly rather than falling through to the empty state.

### `usePortfolio` hook surface

`usePortfolio()` now surfaces the underlying React Query state from `useInvestmentsQuery`:

```typescript
const {
  isLoading,   // true while the initial investments fetch is in flight
  isError,     // true when the fetch has failed
  error,       // Error object (or null)
  refetch,     // () => void — re-trigger the failed query
  ...
} = usePortfolio();
```

Previously a failed fetch would resolve to an empty `investments` array, silently rendering the "no holdings yet" empty state and masking the error from the user.

### Page-level states

Each asset page checks these values before rendering the holdings list:

| State | Rendered | Trigger |
|---|---|---|
| Loading | Skeleton placeholder | `isLoading === true` |
| Error | `PageError` component with "Retry" button | `isError === true` |
| Empty | Asset-class-specific empty state | Fetch succeeded; zero holdings |
| Populated | Holdings table / cards | Fetch succeeded; holdings present |

The "Retry" button on the error state calls `refetch()` so users can recover from transient network failures without a full page reload.

> [!tip]
> The `PageError` component is shared across portfolio pages. It accepts an `onRetry` callback prop and renders a localized error message with the underlying error detail.

Code links: [[apps/frontend/src/hooks/usePortfolio.ts]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]]

## PDF Report Export (Phase 8)

Portfolio data can be exported as a comprehensive PDF report via the [[docs/features/pdf-report-export|PDF Report Export]] feature. The portfolio report includes:

- **Portfolio Executive Summary** — KPI grid with total value, invested, unrealised P/L, realised P/L, dividends YTD, and return %
- **Portfolio Allocation** — Asset-class breakdown (stocks/ETFs, crypto, metals, cash) with horizontal bars and table
- **Top Holdings** — Top 10 holdings by current value
- **Performance Trend** — Line chart overlaying portfolio value vs invested + inflation-adjusted; per-month table
- **Asset Class Detail** — Grouped bar chart (invested vs value) per asset class with P/L summary
- **Dividend Income** — Monthly dividend bar chart + top dividend-paying investments

Portfolio report is available from the Portfolio Overview page (`/portfolio`) and Stocks page (`/portfolio/stocks`).

See [[docs/api/reports#post-apireportsportfolio|Reports API: Portfolio Endpoint]] for request/response details.

## Portfolio Overview Ticker Widget (2026-06-24)

A Wall-Street-style horizontally scrolling ticker tape was added to the Portfolio Overview page (`/portfolio`). It displays each owned stock's live day-change data — symbol, current price, and today's % change — in a continuous marquee.

### Behaviour

- **Source**: From the full set of holdings with a ticker symbol quotable by Yahoo Finance (the *manageable universe*), only those where `show_in_ticker !== false` are actually quoted and displayed (the *included* set). Non-symbol holdings such as real estate and savings are excluded from the manageable universe automatically.
- **Excluded holdings make no network requests**: symbols filtered out by `show_in_ticker === false` are not passed to the Yahoo batch quote call — a deliberate network saving.
- **Symbol resolution**: Prefers `price_provider_id` when `price_provider === 'yahoo'`; falls back to the bare `symbol`. This mirrors how the rest of the codebase requests Yahoo quotes (e.g. a holding named "Apple" priced via provider id `AAPL` quotes as `AAPL`).
- **Live data**: Fetches batch day-change quotes from `GET /api/market/quote` with `detail=basic` (same endpoint as the Market Overview research page and the command palette ticker lookup). Returns `price`, `change`, `changePercent`, `currency` per symbol.
- **React Query cadence**: `staleTime` 60 s, `refetchInterval` 60 s, `retry: 1`, query key `["portfolio-ticker", symbols]`. The query is disabled when offline (`useOnlineStatus`). Polling is gated on visibility — `refetchInterval` is `false` whenever the tape is off-screen or the tab is hidden, so a backgrounded Portfolio page makes no quote requests; a stale tape refreshes the moment it reappears.
- **Rendering**: Content is duplicated twice inside `.ticker-track` for a seamless CSS loop (`@keyframes ticker-scroll`: `translateX(0) → translateX(-50%)`). Animation speed scales linearly with item count (`4.5 s / item`, minimum 24 s total).
- **Visibility pause (perf)**: An `IntersectionObserver` (120 px root margin) plus the Page Visibility API drive a `data-active` attribute on `.ticker-mask`. When the tape scrolls off-screen or the tab is hidden, `.ticker-mask[data-active="false"] .ticker-track` sets `animation-play-state: paused`, so no compositor cycles are spent animating a tape nobody can see. It resumes seamlessly from the same offset on return.
- **Interactivity**: Marquee pauses on hover (`.ticker-mask:hover .ticker-track`). Respects `prefers-reduced-motion` — animation is disabled via the `animation: none` rule in `@layer utilities`.
- **Gain/loss colour**: Uses `text-gain` / `text-loss` tokens, which are the colorblind-aware gain/loss CSS variables (orange/blue by default, toggleable in Settings → Appearance → Accessibility).
- **Empty-tape persistence**: The bar renders even when the included set is empty (i.e. the user has hidden all holdings) — the tape shows a muted placeholder instead. `portfolio.ticker.allHidden` is shown when everything in the manageable universe is excluded; `portfolio.ticker.offline` is shown when offline with no cached quotes. The component returns `null` only when there are no quotable holdings at all (the manageable universe itself is empty).

### Per-Stock Ticker Toggle (2026-06-24, migration 0061)

Each investment can be individually included in or excluded from the ticker. The preference is persisted in a **side table** `investment_ticker_prefs` (not a column on `investments`) and managed from a `TickerManager` popover on the ticker bar itself.

**TickerManager popover**

- Opened via a sliders icon at the tape's right edge, outside the edge-fade mask.
- Lists every holding in the manageable universe (has a quotable ticker symbol) with a Radix `Switch` per row.
- Toggling a switch calls `apiClient.updateInvestment(id, { show_in_ticker })` (`PATCH /api/investments/:id`) with an **optimistic cache update** on `INVESTMENTS_QUERY_KEY`; the update rolls back on error and invalidates `investments` + `portfolio-summary` queries on settle.

**Side table** (`investment_ticker_prefs`):
- Schema: `investment_ticker_prefs(investment_id INTEGER PRIMARY KEY, show_in_ticker BOOLEAN NOT NULL DEFAULT true)`.
- Created by migration `0061_investments_show_in_ticker` (revision `0061_investments_show_in_ticker`, down_revision `0060_brokerage_import_routing`) via `CREATE TABLE IF NOT EXISTS`. Downgrade: `DROP TABLE IF EXISTS investment_ticker_prefs`.
- No FK on `investment_id` — `investments` may be a VIEW on legacy inheritance-schema installs; an orphaned pref row is harmless (it simply never joins). There is **no `investments.show_in_ticker` column**.
- An absent row means visible (`COALESCE(tp.show_in_ticker, true)`); only explicit opt-outs need storing — no backfill required for existing holdings.
- **Read path**: `investmentRepository` reads (`getById`, `getAll`, `getAllWithCount`) each `LEFT JOIN investment_ticker_prefs tp ON tp.investment_id = i.id` and select `COALESCE(tp.show_in_ticker, true) AS show_in_ticker`.
- **Write path**: `investmentRepository.update()` peels `show_in_ticker` out of the PATCH body — it is **not** in `allowed` / `BASE_ALLOWED_FIELDS` — and UPSERTs it via `INSERT ... ON CONFLICT (investment_id) DO UPDATE`, then returns the joined read.
- **Backup**: `investment_ticker_prefs` is registered in `BACKUP_COVERED_TABLES` in `apps/node-backend/src/backup/coverage.js` and is included in `.visionbak` exports.
- **NOT auto-applied** — the user runs `bun run db:upgrade`.

> [!warning] Apply migration 0061 before deploying the ticker manager
> Until `bun run db:upgrade` is run, the `investment_ticker_prefs` table does not exist. The `PATCH /api/investments/:id` call for `show_in_ticker` will be accepted by the Express route but the upsert into the side table will fail with a "relation does not exist" error. Apply the migration first.

### i18n keys

### Placement in PortfolioOverviewPage

The ticker is the **first widget** in `getPortfolioWidgets()` (id `ticker`, `defaultVisible: true`). It renders between `<StalePricesBanner>` and the summary cards grid — at the top of the overview content area, below the page header.

Users can hide it from the widget visibility dialog (`portfolio.widget.ticker` i18n key).

### i18n keys

| Key | en | nl |
|-----|----|----|
| `portfolio.widget.ticker` | "Price Ticker" | "Koersticker" |
| `portfolio.ticker.aria` | "Live price ticker for your holdings" | "Live koersticker van je posities" |
| `portfolio.ticker.manage` | "Manage Ticker" | "Ticker beheren" |
| `portfolio.ticker.manageTitle` | "Manage Price Ticker" | "Koersticker beheren" |
| `portfolio.ticker.manageCount` | "{shown} of {total} shown" | "{shown} van {total} zichtbaar" |
| `portfolio.ticker.allHidden` | "All holdings hidden from ticker" | "Alle posities verborgen uit ticker" |
| `portfolio.ticker.offline` | "Ticker offline" | "Ticker offline" |

### No new API endpoint

The ticker reuses the existing `/api/market/quote` batch endpoint and the existing `PATCH /api/investments/:id` endpoint (with the new `show_in_ticker` field). The `docs/reference/api-endpoint-matrix.md` count is unchanged.

Code links: [[apps/frontend/src/components/portfolio/PortfolioTicker.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/index.css]], [[apps/frontend/src/hooks/useOnlineStatus.ts]], [[apps/frontend/src/lib/api.ts]]

## Per-Account Holdings (2026-06-18, ADR-091 / ADR-100)

> [!warning] Holdings UI flag-gated — default OFF (ADR-103, 2026-06-20)
> The per-account **holdings** surfaces in this section are hidden when
> `VITE_ENABLE_PER_ACCOUNT_HOLDINGS` is `false` (the default). Specifically gated off:
> - Account pickers on `AddPortfolioTxnDialog` and `EditPortfolioTxnDialog` (new trades stay
>   global; no `account_id` / `cash_account_id` → no cash leg created).
> - The "Move Holdings" button, `MoveHoldingDialog`, and the per-investment per-account breakdown
>   card in `InvestmentDetailDialog`.
> - The holdings-transfer block inside `CloseAccountDialog` (the cash-account archive path stays).
>
> **Unaffected by the flag:** `AccountsPage` CRUD, the bank-balances widget (per-account cash),
> `bank_account` on transaction forms, liabilities, and statement-balance reconciliation. The
> backend `byAccount` data is still computed; it simply goes unused on the frontend.
> Set `VITE_ENABLE_PER_ACCOUNT_HOLDINGS=true` to restore the full surface. See
> [[docs/adr/103-per-account-holdings-ui-flag|ADR-103]].

### Per-account breakdown in portfolio summary (ADR-108 partitioned P&L, 2026-08-10)

`getPortfolioSummary`'s top-level `byAccount` array now carries full per-broker P&L, computed by the ADR-108 partitioned engine — the existing lot engine run per (investment, account) partition with the user's configured cost-basis method: buys/gifts create lots in their row's account, sells consume **same-account** lots, corporate actions (split, return of capital) apply investment-wide across partitions, and a re-tag (`UPDATE … SET account_id`) moves the whole lot with its basis. Each element is:

```typescript
{
  account_id: number | null,
  currentValue: number,
  totalInvested: number,   // gross buy cost, same grain as totals.totalInvested
  realizedGain: number,
  unrealizedGain: number,
  gainLoss: number,
}
```

For an instrument whose lots are fully broker-assigned, its per-investment summary **is** the sum of its partitions, so `Σ byAccount ≡ totals` holds field-by-field by construction (locked by the real-Postgres parity suite `tests/portfolioSummaryPartitionParity.db.test.js` under all three cost-basis methods). Each summary carries a `fullyAssigned` boolean; while an instrument still has unassigned lot rows (transition rule) its **entire** value/P&L sits on the `account_id: null` row and its global figures stay the exact flat-replay values — read surfaces render "assign lots to see per-broker figures" instead of wrong partitions. Non-unit-based investments (savings/bond/real estate — no lot machinery, non-linear interest accrual) are attributed whole to their single account, or to the null row when their rows span accounts.

Sell validation is account-scoped on fully-assigned instruments: a sell exceeding the broker-local units is rejected with an error naming the broker (display name), even if investment-wide units would cover it; unassigned sells and instruments in transition validate globally, as before. The per-account availability replay applies splits investment-wide, mirroring the engine.

Two ADR-108 semantic edges on fully-assigned multi-broker instruments (adversarially verified 2026-08-10): under **weighted_avg**, a `return_of_capital` larger than one partition's basis share now floors per partition instead of against the pooled basis, so the global invested/unrealized headline can differ from the old flat replay (the partitioned figure matches what FIFO/LIFO already reported for the same rows); and a sell tagged to a broker holding fewer units than it sold clamps to that partition's lots (partition oversell), so re-tagging lots away from an account with sells changes global units/value rather than raiding another broker's lots — assign sells alongside their lots.

Callers resolve names from the accounts list. See [[docs/api/portfolio-summary|Portfolio Summary API]] for the response shape and [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]] for the model.

Per-broker read surfaces (hub cards, net-worth by-account table, `InvestmentDetailDialog` holdings card) arrive in WP-C5; until then the frontend's client-side summaries (`usePortfolioSummaries.ts`) still run the flat core and can disagree with the API's partitioned figures on fully-assigned multi-broker instruments.

### Edit-trade account picker

`EditPortfolioTxnDialog` has an account selector. `PATCH /api/investments/transactions/:id` accepts `account_id` (integer to reassign a lot to a different account, or `null` to unassign it). No other transaction fields are required alongside it.

### Partial-move cost-basis strategy

`POST /api/investments/:id/move` accepts an optional `strategy` field:

| `strategy` | Behavior |
|------------|----------|
| `'fifo'` | Default. Move oldest buy lots first; boundary lot split pro-rata. |
| `'proportional'` | Average-cost: split *every* lot by the same fraction. Useful for mutual fund–style holdings. |

The strategy selector is shown in `MoveHoldingDialog` only for partial moves (`units < net`). `MoveHoldingService` implements both paths.

### Close-account workflow

`CloseAccountDialog` (wired into `AccountsPage`) lists all of an account's holdings, lets the user pick a destination account, transfers all lots in-specie (calls `POST /api/investments/:id/move` per holding), then archives the account (`PATCH /api/accounts/:id` with `{ is_active: false }`). This is a UI-level workflow with no dedicated backend endpoint; the `ON DELETE RESTRICT` FK on `portfolio_transactions_base.account_id` prevents hard-deletion of an account that still has lots.

Code links: [[apps/frontend/src/components/portfolio/CloseAccountDialog.tsx]], [[apps/node-backend/src/services/portfolio/moveHoldingService.js]]

### Brokerage fan-out core (ADR-095)

`apps/node-backend/src/services/importPipeline/brokerageFanout.js` is now wired and tested. It exports `planBrokerageFanout(rows, accountId)` and `commitBrokerageFanout(plan, db)`, which route one parsed brokerage statement into:
- cash ledger rows (deposits, withdrawals, fees, dividends, taxes, interest) → `transactions`
- trade rows (buys, sells) → `portfolio_transactions` with an ADR-090 cash leg

The double-count guard is enforced: a trade emits exactly one cash movement (its leg); no standalone cash row is also created for the same buy/sell.

> [!warning] Remaining surface
> The brokerage **parser kind** (mixed-row CSV classifier), the **staging schema** for mixed-row batches, and the **review UI integration** for per-row routing decisions are **not yet built**. The fan-out service is correct and tested but is not reachable through the import UI. See [[docs/adr/095-brokerage-account-import|ADR-095]] for the full status.

## FX Attribution (2026-06-11, ADR-074)

Multi-currency portfolios now expose a decomposition of total gain into **asset gain** (pure performance in the investment's native currency) and **FX gain** (currency movement). The identity `gainLoss = assetGain + fxGain` holds per investment and in totals.

### Where it appears in the UI

| Surface | What is shown |
|---------|--------------|
| **Portfolio Overview — Total Gain/Loss card** | Subline: "Asset gain: X · FX effect: Y" beneath the headline gain/loss |
| **Stocks & ETFs / Metals tables** | FX P/L column — shown only when at least one holding is in a foreign currency |
| **Crypto table** | FX P/L column — same condition |
| **Performance page — headline metrics** | FX attribution line below Total Gain/Loss |
| **Performance page — value-over-time chart** | Optional FX-neutral toggle (dashed series) showing `value_fx_neutral` when migration 0039 has been applied and snapshots recomputed |
| **Investment detail dialog** | FX Attribution card: shows `assetGain`, `fxGain`, `nativeCurrentValue` |

### Fallback rate disclosure

When a transaction lacked a transaction-date rate and the backend fell back to today's rate, the `usedFallbackRate` flag is `true` in the API response. The UI surfaces this as a small warning callout on the relevant card or row, indicating that the FX attribution figures may be approximate for that investment.

> [!warning]
> The FX-neutral chart toggle on the Performance page requires migration `0039_add_value_fx_neutral_to_snapshots` to be applied (`bun run db:upgrade`) and snapshots to be recomputed (happens automatically on next startup after migration). Until then, the toggle is hidden.

### Semantics of invested/gainLoss after ADR-074

Before ADR-074, `totalInvested` was restated at today's FX on every request. After ADR-074:

- **`totalInvested`** reflects what was actually paid in EUR-equivalent at the time of purchase. It does not move with the FX market.
- **`gainLoss`** includes the FX component. A USD holding that gained 0% in USD terms but whose currency strengthened 5% vs EUR will show a positive `gainLoss` driven entirely by `fxGain`.
- The live portfolio totals and the snapshot series now agree on semantics (both use purchase-date rates for invested capital), closing the contradiction that existed before.

Code links: [[apps/node-backend/src/services/portfolio/portfolioSummaryService.js]], [[apps/node-backend/src/routes/info/_performanceHelpers.js]], [[apps/node-backend/src/controllers/investmentController.js]], [[packages/shared-utils/src/portfolio.js]], [[docs/adr/074-fx-attribution-historical-rates|ADR-074]]

### Unified FX-Aware P&L in InvestmentDetailDialog (2026-06-28)

> [!info] Breaking change for component API — props removed
> `InvestmentDetailDialog` no longer accepts `fxAwarePnl` or `fxAwareCurrency` props. Both computed internally via the new `useFxAwarePnl` hook. Callers that previously passed these props (i.e. `StocksPage`) must be updated.

**Problem:** `fxAwarePnl` and `fxAwareCurrency` were previously passed only by `StocksPage`, so the same holding showed different FX P&L data depending on whether the dialog was opened from the Stocks page or from another surface (dashboard, overview, crypto, savings, real estate). EUR/base-currency holdings also rendered spurious FX rows because the props were unconditionally displayed when non-null.

**Solution — `useFxAwarePnl` hook:**

A new shared hook at [[apps/frontend/src/hooks/portfolio/useFxAwarePnl.ts]] encapsulates the EUR-pool realized/unrealized P&L computation:

```typescript
export function useFxAwarePnl(targetCurrency: string): (holding: InvestmentSummary) => FxAwarePnl
```

The hook:
- Converts each buy/sell/gift to EUR at its transaction-date `fx_rate_to_eur` (falls back to the live rate from `useCurrencyConverter` when the field is absent).
- Accumulates gains in EUR (handles `split` and `return_of_capital` events correctly, consistent with `snapshotBuilder` and `calculateCostBasis`).
- Returns `{ realizedTarget, unrealizedTarget, unrealizedPercent }` converted to `targetCurrency`.
- Returns stable references via `useCallback` — safe in `useMemo` dependency arrays.

**InvestmentDetailDialog behaviour after the change:**

- Calls `useFxAwarePnl(targetCurrency)` internally to compute the P&L.
- The FX-aware realized/unrealized rows and the FX attribution card are rendered **only** when the holding is in a genuinely foreign currency. The gate compares the holding's NATIVE currency (`holding.originalCurrency`) to `targetCurrency` — **not** `holding.currency`, which on an `InvestmentSummary` is the display/target currency (every monetary field is converted to it). The native-value row and the transactions tab also label amounts in the holding's own currency. This removes spurious FX rows for base-currency holdings while keeping them for foreign ones. (Editing the same `currency`-vs-`originalCurrency` distinction: [[apps/frontend/src/components/portfolio/EditInvestmentDialog.tsx]] edits `originalCurrency`.)
- The dialog renders identically regardless of which page opened it (Stocks, Crypto, Overview, dashboard, Real Estate, Savings).

**StocksPage:** Now uses `useFxAwarePnl` for its holdings table column as well, ensuring the table values match the detail dialog values. The previously passed-down props have been removed from the component signature.

**New i18n keys:**

| Key | Purpose |
|-----|---------|
| `invDetail.fxAwareRealized` | Label for the FX-aware realized P&L row (shows `{currency}`) |
| `invDetail.fxAwareUnrealized` | Label for the FX-aware unrealized P&L row (shows `{currency}`) |

Code links: [[apps/frontend/src/hooks/portfolio/useFxAwarePnl.ts]], [[apps/frontend/src/components/portfolio/InvestmentDetailDialog.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]]

## Cash-Aware Rebalancing (ADR-098, updated 2026-06-19)

The Rebalance page (`/portfolio/rebalance`, nav: Portfolio → Analysis → Rebalance) runs a
cash-deploy-only rebalancing calculation: given target sleeve weights and the user's available
spendable cash, it computes how much to put into each underweight sleeve without proposing any
sells. It calls `POST /api/cross-workspace/rebalance` (see [[docs/adr/098-cross-workspace-features|ADR-098]]).

### Allocation source

The page offers three mutually exclusive source modes:

| Mode | Description |
|------|-------------|
| **Presets** | Three built-in plans: `sixty_forty`, `all_weather`, `three_fund` |
| **Saved plans** | User-named custom allocations persisted across sessions (see below) |
| **Custom (new)** | Editable per-sleeve target-% rows; unsaved until explicitly named and saved |

### Sleeve vocabulary

Sleeve names match the `SLEEVE_ROLLUP` grouping in `crossWorkspaceDataService.js`:

`stocks` · `intl_stocks` · `bonds` · `gold` · `commodities` · `crypto` · `real_estate` · `savings`

### Optional cash cap

A numeric input limits how much spendable cash to deploy in a run. Blank = deploy all available
liquid cash. The UI clamps user input to `[0, availableCash]` before sending it as the existing
`availableCash` parameter on the route.

The **"Available cash"** summary card always shows the true spendable-balance sum drawn from
the uncapped inputs query, not the capped value. This means the card stays accurate regardless
of whether a cash cap is active -- the cap only limits deployment, not the displayed balance.

### Weight normalization

Target weights do not need to sum to 100%. The server's `normalizeWeights` function scales them
proportionally before running deployment math, so a user can enter rough ratios and get correct
allocation splits.

### Saved named plans

Custom allocations can be named, saved, updated, and deleted. They persist as a JSON array under
the `rebalance_plans` key in the settings store — no DB migration required.

**Plan shape:**

```typescript
interface RebalancePlan {
  id: string;
  name: string;              // 1–80 chars
  targetWeights: Record<string, number>;  // sleeve → non-negative %
  cashCap?: number;          // optional cap ≥ 0
}
```

- Max 50 saved plans per user. Enforced server-side with a 400 response on excess.
- Backend validation is in `assertRebalancePlansValue` inside `apps/node-backend/src/routes/settings.js`.
- The `rebalance_plans` key returns `[]` by default (same pattern as `backup_settings`).

### Deployment plan Target column

The **Target** column in the deployment-plan result table renders target percentages to **1 decimal
place** (e.g. 7.5% instead of 8%). This ensures fractional preset weights such as All Weather's
7.5% sleeves display accurately and the column no longer visually sums to 101% due to rounding.

### i18n keys (2026-06-19)

New keys in `rebalance.*` namespace (en + nl). Notable renames: `rebalance.plan` →
`rebalance.deploymentPlan` (the deployment-result card). New: `rebalance.plan.*` (saved-plan
management UI), `rebalance.editor.*` (custom editor rows), `rebalance.sleeve.*` (sleeve labels),
`rebalance.customNew`, `rebalance.presets`, `rebalance.savedPlans`.

Code links: [[apps/frontend/src/pages/portfolio/RebalancePage.tsx]], [[apps/frontend/src/hooks/useRebalancePlans.ts]], [[apps/frontend/src/lib/api/crossWorkspace.ts]], [[apps/node-backend/src/routes/settings.js]], [[apps/node-backend/src/routes/crossWorkspace.js]], [[apps/node-backend/tests/settingsStorage.test.js]]

See also: [[docs/api/settings|Settings API — `rebalance_plans` key]], [[docs/adr/098-cross-workspace-features|ADR-098]]

## Related

- [[docs/api/investments|API: Investments]]
- [[docs/api/watchlist|API: Watchlist]]
- [[docs/api/portfolio-summary|Portfolio Summary API]] — FX attribution response fields; `byAccount` breakdown
- [[docs/integrations/price-providers|Price Providers]] — Live and historical price data
- [[docs/integrations/kinesis-price-provider|Kinesis Price Provider]] — Metals and commodities
- [[docs/integrations/currency-conversion|Currency Conversion]] — ECB full-history tier, startup backfill
- [[docs/adr/103-per-account-holdings-ui-flag|ADR-103]] — Flag-gate for per-account holdings UI (default off)
- [[docs/adr/100-net-worth-account-native-holdings|ADR-100]] — Per-account holdings parity (Σ byAccount); UI scope narrowed by ADR-103
- [[docs/adr/091-per-account-positioning|ADR-091]] — Per-account lots, move-holding, close-account; UI scope narrowed by ADR-103
- [[docs/adr/095-brokerage-account-import|ADR-095]] — Brokerage fan-out (core built; parser/UI deferred)
- [[docs/adr/074-fx-attribution-historical-rates|ADR-074]] — FX attribution with purchase-date rates
- [[docs/adr/073-shared-portfolio-math-package|ADR-073]] — Shared portfolio math (converted track)
- [[docs/adr/002-database-schema|Database Schema]]

## Migrations

- `0004_portfolio_tables.py` — Initial portfolio tables (`investments`, `portfolio_transactions`)
- `0006_price_providers.py` — Added `price_provider` enum type
- `0010_investments_municipality_tax_fields.py` — Added `municipality` and `cadastral_income` to real estate investments
- `0013_investment_inheritance.py` — Migrated to PostgreSQL table inheritance (`investments_base` + child tables)
- `0014_investments_view_update_trigger.py` — Added UPDATE trigger on `investments` view for inheritance-compatible writes
- `0015_add_gift_portfolio_txn_type.py` — Added `gift` to `portfolio_txn_type` enum
- `0016_add_fx_rate_to_portfolio_transactions.py` — Added `fx_rate_to_eur` column for cross-currency portfolio transactions
- `0017_investment_custom_provider_history.py` — Added custom provider history/latest URL and path fields; updated metals view/trigger wiring
- `0018_metals_transactions_inheritance_split.py` — Split metals transactions from stock_transactions into dedicated `metals_transactions` inheritance child
- `0019_asset_price_history_cache.py` — Added `asset_price_history` table for persisted historical quotes
- `0020_drop_asset_price_history_fk.py` — Dropped FK constraint on `asset_price_history.investment_id`
- `0021_update_price_provider_enum.py` — Added `custom` to `price_provider` enum
- `0022_add_kinesis_price_provider_enum.py` — Added `kinesis` to `price_provider` enum
- `0023_portfolio_performance_snapshots.py` — Added `portfolio_performance_snapshots` table for daily performance caching
- `0024_per_class_invested_columns.py` — Added per-class invested columns (`stocks_etfs_invested`, `crypto_invested`, `metals_invested`) to performance snapshots
- `0039_add_value_fx_neutral_to_snapshots.py` — Added nullable `value_fx_neutral NUMERIC(18,2)` to `portfolio_performance_snapshots`; writer detects column presence and degrades gracefully (ADR-074)
- `0057_portfolio_import_batches_account_id.py` — Adds `account_id` FK to `portfolio_import_batches` so committed lots inherit the destination account (**authored, not applied** — run `bun run db:upgrade`)
- `0058_watchlist_added_price.py` — Adds `added_price NUMERIC(18,6) NULLABLE` to `watchlist` for the what-if backtest (**authored, not applied** — run `bun run db:upgrade`)
- `0061_investments_show_in_ticker.py` — Creates the `investment_ticker_prefs` side table (`investment_ticker_prefs(investment_id INTEGER PRIMARY KEY, show_in_ticker BOOLEAN NOT NULL DEFAULT true)`). Enables per-investment opt-out from the portfolio ticker tape without touching the `investments` table/view (which may be a VIEW on legacy inheritance-schema installs). Absent row = visible. Downgrade drops the table. (**authored, not applied** — run `bun run db:upgrade`)
