---
title: Feature - Portfolio & Investments
type: feature
status: active
date: 2026-04-21
tags: [feature, portfolio, investments, stocks, crypto, metals, phase-1, phase-3.5, phase-3.6, phase-9]
aliases: [portfolio-feature, investments-feature, holdings, net-worth, stocks, crypto, real-estate, savings, bonds, metals, performance, watchlist]
description: Track stocks, ETFs, crypto, metals, real estate, savings, and bonds
related_code: ["apps/node-backend/src/routes/investments.js", "apps/node-backend/src/services/priceProviderService.js", "apps/node-backend/src/services/portfolioPerformanceSnapshotService.js", "apps/frontend/src/pages/portfolio/PerformancePage.tsx", "apps/frontend/src/pages/portfolio/MetalsPage.tsx", "apps/frontend/src/lib/api.ts"]
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

The refresh API response includes `priceSources` per investment ID so clients can show where each price came from.

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

Code links: [[apps/frontend/src/components/portfolio/AddPortfolioTxnDialog.tsx]], [[apps/frontend/src/components/portfolio/EditPortfolioTxnDialog.tsx]], [[apps/frontend/src/hooks/usePortfolio.ts]], [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]], [[apps/node-backend/src/services/currencyConversionService.js]], [[apps/node-backend/src/main.js]]

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

Code links: [[apps/node-backend/src/repositories/infoRepository.js]], [[apps/node-backend/tests/infoRepository.test.js]], [[apps/frontend/src/pages/portfolio/NetWorthPage.tsx]], [[apps/frontend/src/lib/api.ts]]

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

## Performance Page Rewrite (Server-Computed Response)

The Performance page architecture was significantly refactored to move heavy computations from the client to the server:

**Backend enhancements (`/api/info/portfolio-performance`):**
- New `period` query parameter: `1m|3m|6m|1y|3y|all` (default `all`) for period-filtered chart data
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

Code links: [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/components/portfolio/PerformanceBreakdown.tsx]], [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]]

Code links: [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioTaxPage.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]], [[apps/frontend/src/lib/api.ts]]

## Belgian Inflation Data Flow

- Backend now owns Belgian inflation sourcing and caching via Statbel-backed service with Eurostat fallback; frontend consumes monthly rates through the info API.
- Data path and fallback order: in-memory cache (24h) -> PostgreSQL persisted rows -> remote Statbel fetch -> remote Eurostat HICP index fallback; if both remote sources fail, service falls back to persisted DB data.
- Startup/scheduled behavior: backend warms inflation cache at startup and refreshes together with exchange-rate refresh cadence.
- New persistence table `belgian_inflation_rates` stores monthly values (`month_date`, `monthly_rate`, `source`, `fetched_at`, `updated_at`) for deterministic portfolio calculations and offline resilience.

Code links: [[apps/node-backend/src/services/belgianInflationService.js]], [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/main.js]], [[apps/frontend/src/lib/api.ts]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]]

## Historical Asset Quote Persistence

- Historical provider prices are now persisted in `asset_price_history` and reused by portfolio valuation flows.
- Price history endpoint and portfolio calculations use read-through behavior: DB history first, provider fetch when needed, then DB upsert.
- Startup backfill populates historical quotes for currently held unit-based assets (`stock`, `etf`, `crypto`, `metals`) from first transaction date.

Code links: [[apps/node-backend/src/services/priceProviderService.js]], [[apps/node-backend/src/main.js]], [[alembic/versions/0019_asset_price_history_cache.py]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]]

## Cost Basis Methods (Phase 6)

Portfolio tax calculations now support multiple cost basis accounting methods, configurable as a user preference in Settings.

**Available methods:**

1. **Weighted Average** (default) — Moving average cost per unit; commonly used for tax simplicity
2. **FIFO** (First-In, First-Out) — Oldest lots sold first; often minimizes tax in rising markets
3. **LIFO** (Last-In, First-Out) — Newest lots sold first; often maximizes deductions in falling markets

**Selection:** User can set preferred cost basis method in Settings → General tab (`settings.general.costBasisMethod` in i18n).

**Implementation:**

- Backend calculation functions in `[[apps/node-backend/src/utils/portfolioMath.js]]`:
  - `calculateCostBasis()` — Weighted average method
  - `calculateCostBasisFIFO()` — FIFO method
  - `calculateCostBasisLIFO()` — LIFO method
  - All support `buy`, `sell`, `gift`, `split`, `return_of_capital`, `merger`, `spinoff` transaction types
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

## Related

- [[docs/api/investments|API: Investments]]
- [[docs/api/watchlist|API: Watchlist]]
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
