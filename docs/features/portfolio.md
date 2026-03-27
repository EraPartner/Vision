---
title: Feature - Portfolio & Investments
type: feature
status: active
date: 2026-03-27
tags: [feature, portfolio, investments, stocks, crypto, metals]
description: Track stocks, ETFs, crypto, metals, real estate, savings, and bonds
related_code: ["apps/node-backend/src/routes/investments.js", "apps/node-backend/src/services/priceProviderService.js"]
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

### Price Providers

| Provider | Asset Classes | API |
|----------|---------------|-----|
| manual | all | User-entered prices |
| coingecko | crypto | CoinGecko API |
| yahoo | stock, etf, metals | Yahoo Finance |
| kraken | crypto | Kraken Exchange |
| custom | all | Custom API endpoint(s) for latest + historical quotes |

### Editing Investments

Investment details can be edited from portfolio details/list UIs via dedicated edit dialogs.

Editable fields:
- Name (`name`)
- Ticker/symbol (`symbol`) for unit-based assets
- Currency (`currency`)
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
- Refresh price persistence updates inheritance storage tables directly (`investments_base` and asset-specific child tables), avoiding `UPDATE investments ...` against the compatibility view.
- Custom provider refresh can resolve latest quote either via explicit latest path, or from latest point in configured history payload when latest path is not provided.
- New API endpoint `GET /api/investments/:id/price-history` serves provider-backed history (currently custom provider) without storing external provider price history in DB.
- Legacy DB compatibility: if `investments` table/view does not yet contain new custom-provider columns, investment create automatically falls back to legacy provider fields (`price_provider_id`, `price_provider_url`) so custom latest-path setups still work during mixed-schema deployments.
- Migration dependency: `0017_investment_custom_provider_history` applies custom-provider latest/history columns to inheritance storage, conditionally patches legacy `investments` table only when relation kind is table/partition, creates `metals_investments` if missing, and refreshes the compatibility view/trigger for metals + new provider fields ([[alembic/versions/0017_investment_custom_provider_history.py]]).
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

### Editing Portfolio Transactions

Portfolio transaction edits are supported via a dedicated edit modal.

Rules:
- `type` is immutable (cannot be changed after creation).
- All other transaction fields are editable, including date, amount/unit/price inputs, fees/taxes, note, and recurring settings.
- `fx_rate_to_eur` is editable as an optional field in the transaction dialogs.
- Unit-based buy/sell edit math keeps the same 2-of-3 pricing normalization rules as create.
- Unit-based `sell` validation enforces holdings sufficiency on both create and update (oversell transactions are rejected).
- `updated_at` captures edit timestamps.
- Migration/startup compatibility: when `portfolio_transactions` is a compatibility view in inherited schemas, migration and startup schema init now guard `ALTER TABLE` by relation kind (`r`/`p` only), while preserving the view recreation path for `relkind='v'` ([[alembic/versions/0016_add_fx_rate_to_portfolio_transactions.py]], [[apps/node-backend/src/database/schemaInit.js]], [[docs/guides/deployment|Deployment Guide]]).

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

Code links: [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/types/api.ts]], [[apps/node-backend/src/routes/investments.js]], [[alembic/versions/0016_add_fx_rate_to_portfolio_transactions.py]], [[apps/node-backend/src/database/schemaInit.js]]

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

- Added a dedicated Metals page at `/portfolio/metals`.
- Sidebar navigation includes a Metals entry.
- Stocks listing page was refactored to accept configurable asset classes/title/empty state so Metals can reuse the same listing UX with metals-only filters.
- Default Stocks & ETFs page scope is now strictly `stock` + `etf` (metals excluded), while the Metals page remains metals-only via explicit props.
- Add Investment actions are context-restricted: Stocks & ETFs page allows only stock/etf classes, and Crypto page allows only crypto class.

Code links: [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]], [[apps/frontend/src/App.tsx]], [[apps/frontend/src/components/layout/AppSidebar.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]]

## Backend Enablement (Metals)

- `asset_class` enum now includes `metals` with an idempotent `ALTER TYPE ... ADD VALUE` guard for existing databases.
- Schema version was bumped to `20260324_1`.
- Investment repository adds metals child-table mapping, validation, and allowed-field handling.
- Portfolio value computation includes metals in market-priced classes.
- Yahoo provider docs/description explicitly include metals tickers such as `GC=F`.
- Migration `0017_investment_custom_provider_history` ensures `metals_investments` exists and updates the `investments` compatibility view/trigger to include metals rows in mixed-schema deployments.

Code links: [[apps/node-backend/src/database/schemaInit.js]], [[apps/node-backend/src/repositories/investmentRepository.js]], [[apps/node-backend/src/repositories/infoRepository.js]], [[apps/node-backend/src/services/priceProviderService.js]]

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
- Seed date is the minimum of first portfolio transaction date, first active investment creation date, and first active transaction date.
- Portfolio cashflow contribution is computed from that seed date onward, removing prior-year hard-cutoff behavior.
- For unit-priced assets (stocks/ETFs/crypto/metals), daily net worth valuation now starts from each investment’s own first activity date and uses provider historical close quotes when available (Yahoo/custom), falling back to current price only when historical quotes are unavailable.
- Liquid side now falls back to cumulative transaction flow when account balance snapshots are unavailable.
- If seed date discovery via active-only rows returns empty, net worth now retries with non-filtered seed discovery so legacy rows still produce non-zero snapshots.
- Latest-day investment snapshot is now reconciled against active holdings and `current_price`, so net worth no longer stays at zero when historical portfolio transaction aggregation is incomplete.
- Net worth backend logs fallback paths and final computed summary metrics (currency, seed date, snapshot count, current totals) for easier debugging when users report zeroed dashboards.
- Regression tests cover transactions-only (no investments) workspaces to keep non-zero liquid/net worth responses correct.
- Backend startup now triggers a background investment price refresh for assets with live providers (Yahoo/CoinGecko/Kraken/custom), improving first-load portfolio and net worth freshness.

Code links: [[apps/node-backend/src/repositories/infoRepository.js]], [[apps/frontend/src/pages/portfolio/NetWorthPage.tsx]], [[apps/frontend/src/lib/api.ts]]

## Cross-Currency Display Normalization

- Portfolio Overview, Performance, Portfolio Tax, and asset listing pages now normalize displayed monetary amounts to `appSettings.defaultCurrency`.
- UI conversion uses live rates from `/api/info/exchange-rates` so cards, charts, and tables aggregate mixed-source currencies consistently in the selected target currency.
- Percentage metrics remain unchanged (no currency conversion applied).
- Asset page scope includes Stocks, Crypto, Real Estate, and Savings; Metals inherits the same behavior by reusing Stocks page logic.
- Performance chart valuation now consumes custom-provider historical points (when configured) for unit-based investments; when unavailable it falls back to current price approximation.
- Performance top summary cards are now pinned to **overall portfolio** metrics (independent of selected chart period), matching portfolio-level totals.
- Performance invested-capital summary now aligns with dashboard semantics by using total buy cost aggregation in target currency.
- Performance total return uses aggregated `totalGain` semantics, while annualized return is computed as CAGR from current value vs invested capital over tracked duration.
- Performance value-over-time now prefers monthly net-worth investment snapshots (`/api/info/net-worth`) to align chart behavior with the Net Worth page.
- Performance value-over-time class series (stocks+ETFs/crypto/metals) are proportionally normalized to the net-worth monthly investment total when available, keeping class overlays aligned with authoritative net-worth valuation.
- Performance uses locale-aware text month labels (`MMM YY`) for portfolio and relative charts, consistent with Net Worth chart labeling.
- Performance includes a relative-performance chart for entire portfolio, stocks+ETFs, crypto, and metals using **contribution-adjusted** monthly return chaining (net buy/gift/sell flows removed before return computation) to avoid inflated percentages when capital contributions are large.
- Monthly heatmap represents **relative monthly investment returns (%)** (investment performance only; no liquid-cash component).
- Monthly return computation now uses transaction-derived net monthly flows (`buy` + `gift` - `sell`) instead of invested-balance deltas, avoiding distortions from valuation reclassifications; first visible month is pinned to `0.00%` baseline and YTD is compounded from monthly returns.
- Performance month labels for charts and heatmap now always follow app language locale (`en-US`/`nl-NL`) rather than number-format locale, preventing German month names when number format is set to EU style.

Code links: [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioTaxPage.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]], [[apps/frontend/src/lib/api.ts]]

## Related

- [[docs/api/investments|API: Investments]]
- [[docs/api/watchlist|API: Watchlist]]
- [[docs/adr/002-database-schema|Database Schema]]
