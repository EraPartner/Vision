---
title: Portfolio Components
type: component
status: active
date: 2026-06-24
updated: 2026-06-28
tags: [components, portfolio, investments, phase-1, phase-3.6, portfolio-ticker, ticker-manager, show-in-ticker, migration-0061, fx-aware-pnl, unified-detail-dialog]
description: Components for investment portfolio management
aliases: [portfolio-components, investment-components, holdings-components]
related_code: ["apps/frontend/src/components/portfolio", "apps/frontend/src/pages/portfolio/WatchlistPage.tsx"]
---

# Portfolio Components

Components for managing investment portfolios, including stocks, crypto, metals, real estate, and savings.

## Component List

| Component | Description | File |
|-----------|-------------|------|
| AddInvestmentDialog | Add new investment | [[apps/frontend/src/components/portfolio/AddInvestmentDialog.tsx\|AddInvestmentDialog.tsx]] |
| AddPortfolioTxnDialog | Record buy/sell transactions | [[apps/frontend/src/components/portfolio/AddPortfolioTxnDialog.tsx\|AddPortfolioTxnDialog.tsx]] |
| EditInvestmentDialog | Edit existing investment details | [[apps/frontend/src/components/portfolio/EditInvestmentDialog.tsx\|EditInvestmentDialog.tsx]] |
| EditPortfolioTxnDialog | Edit existing portfolio transaction | [[apps/frontend/src/components/portfolio/EditPortfolioTxnDialog.tsx\|EditPortfolioTxnDialog.tsx]] |
| InvestmentDetailDialog | View investment details | [[apps/frontend/src/components/portfolio/InvestmentDetailDialog.tsx\|InvestmentDetailDialog.tsx]] |
| AddToWatchlistDialog | Add symbol to watchlist | [[apps/frontend/src/components/portfolio/AddToWatchlistDialog.tsx\|AddToWatchlistDialog.tsx]] |
| PortfolioNewsFeed | Market news for holdings | [[apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx\|PortfolioNewsFeed.tsx]] |
| WatchlistChartDialog | Chart for watchlist symbol | [[apps/frontend/src/components/portfolio/WatchlistChartDialog.tsx\|WatchlistChartDialog.tsx]] |
| AddInvestmentFromMarketDialog | Add investment from market search | [[apps/frontend/src/components/portfolio/AddInvestmentFromMarketDialog.tsx\|AddInvestmentFromMarketDialog.tsx]] |
| PortfolioTaxAdjustmentsDialog | Tax adjustments for investments | [[apps/frontend/src/components/portfolio/PortfolioTaxAdjustmentsDialog.tsx\|PortfolioTaxAdjustmentsDialog.tsx]] |
| PortfolioTicker | Live day-change scrolling ticker tape for the Portfolio Overview | [[apps/frontend/src/components/portfolio/PortfolioTicker.tsx\|PortfolioTicker.tsx]] |

---

## AddInvestmentDialog

Dialog for adding a new investment to the portfolio.

### Props

```typescript
interface AddInvestmentDialogProps {
  trigger?: React.ReactNode;
}
```

### Form Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Investment name |
| `symbol` | string | No | Ticker symbol |
| `asset_class` | string | Yes | Asset class (stocks, crypto, etc.) |
| `currency` | string | No | Currency code |
| `current_price` | number | No | Current price |
| `location` | string | No | Physical location (real estate) |
| `notes` | string | No | Notes |

### Asset Classes

```
stocks      - Individual stocks, ETFs
crypto      - Cryptocurrencies
metals      - Precious metals (unit-based holdings)
real_estate - Property investments
savings     - Savings accounts, CDs
bonds       - Government/corporate bonds
```

### Usage

```tsx
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";

<AddInvestmentDialog>
  <Button>Add Investment</Button>
</AddInvestmentDialog>
```

### Settings Propagation Notes

- Default form `currency` uses `appSettings.defaultCurrency`
- Reset/cancel path restores `currency` to `appSettings.defaultCurrency`
- Submit payload and initial buy-transaction currency fallback now use `defaultCurrency` (replacing fixed EUR fallback)
- Default crypto provider selection is `binance` (replacing legacy `coingecko` default)
- Add/Edit provider pickers include `kinesis` with dedicated UI hint text for provider-id guidance

Code links: [[apps/frontend/src/components/portfolio/AddInvestmentDialog.tsx]], [[apps/frontend/src/components/portfolio/EditInvestmentDialog.tsx]], [[apps/frontend/src/contexts/AppSettingsContext.tsx]], [[apps/frontend/src/types/api.ts]], [[apps/frontend/src/types/portfolio.ts]]

### Custom Provider Advanced Fields

When `price_provider = custom`, the add/edit dialogs support advanced provider configuration:

- `price_provider_latest_url`: URL for latest quote payload
- `price_provider_latest_path`: JSON path to latest quote price
- `price_provider_history_url`: URL for historical quote payload
- `price_provider_history_path`: JSON path to array of history points
- `price_provider_history_ts_path`: JSON path (per point) to timestamp (ms)
- `price_provider_history_price_path`: JSON path (per point) to price

Compatibility note:
- legacy `price_provider_url` / `price_provider_id` remain accepted by backend and are still mapped in UI payloads.
- full compatibility for advanced latest/history fields in inheritance + legacy-schema bridge paths is provided by migration `0017_investment_custom_provider_history` ([[alembic/versions/0017_investment_custom_provider_history.py]]).

---

## AddPortfolioTxnDialog

Record buy or sell transactions for an investment.

### Form Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | "buy" or "sell" |
| `date` | date | Yes | Transaction date |
| `amount` | number | Yes | Total amount |
| `units` | number | No | Number of units |
| `price_per_unit` | number | No | Price per unit |
| `fees` | number | No | Transaction fees |
| `currency` | string | No | Currency |
| `note` | string | No | Notes |

### Usage

```tsx
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";

<AddPortfolioTxnDialog investmentId={123}>
  <Button>Record Transaction</Button>
</AddPortfolioTxnDialog>
```

---

## InvestmentDetailDialog

Shows detailed information about an investment.

### Displays

- Current value
- Cost basis
- Gain/loss (realized & unrealized)
- Transaction history
- Price chart
- Notes
- Transaction dates are formatted with app date settings
- Dedicated edit actions for both investment metadata and individual transactions
- FX-aware realized and unrealized P&L rows — shown only for foreign-currency holdings (2026-06-28)

### FX-Aware P&L (2026-06-28)

`InvestmentDetailDialog` now computes FX-aware P&L internally via the `useFxAwarePnl` hook. The props `fxAwarePnl` and `fxAwareCurrency` have been **removed** from the component interface — the dialog self-computes these values regardless of which page opens it (Stocks, Crypto, Overview, dashboard, Real Estate, or Savings).

The FX-aware realized/unrealized rows are gated on `holding.currency !== targetCurrency`. EUR or base-currency holdings never show the FX rows.

```typescript
// No longer accepted — these props are removed:
// fxAwarePnl?: { realized: number; unrealized: number; unrealizedPercent: number }
// fxAwareCurrency?: string
```

See [[docs/features/portfolio#unified-fx-aware-pl-in-investmentdetaildialog-2026-06-28|Portfolio — Unified FX-Aware P&L]] for the full description of the computation logic.

Code links: [[apps/frontend/src/components/portfolio/InvestmentDetailDialog.tsx]], [[apps/frontend/src/hooks/portfolio/useFxAwarePnl.ts]], [[apps/frontend/src/components/shared/dateUtils.ts]]

### EditInvestmentDialog

Dedicated modal used from investment details/list contexts to update investment metadata without changing asset class.

Editable fields:
- name
- symbol (unit-based assets)
- currency
- current price (`current_price`) when provider is `manual` (unit-based assets)
- price provider + provider identifiers

Validation highlights:
- symbol required for unit-based assets in UI
- backend enforces non-empty + globally unique symbol and immutable `asset_class`

Code link: [[apps/frontend/src/components/portfolio/EditInvestmentDialog.tsx]]

### EditPortfolioTxnDialog

Dedicated modal used from transaction rows to edit existing portfolio transactions.

Behavior:
- transaction type is displayed but immutable
- buy/sell keeps two-of-three amount/units/price validation and auto-derivation
- supports recurring fields and note updates

Code link: [[apps/frontend/src/components/portfolio/EditPortfolioTxnDialog.tsx]]

### Settings Propagation Notes

- Uses app date format for transaction date labels displayed in the dialog

### Usage

```tsx
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";

<InvestmentDetailDialog investmentId={123}>
  <Button>View Details</Button>
</InvestmentDetailDialog>
```

---

## PortfolioNewsFeed

Displays market news related to portfolio holdings.

### Props

```typescript
interface PortfolioNewsFeedProps {
  symbols: string[];  // List of symbols to fetch news for
  limit?: number;     // Max number of articles
}
```

### Usage

```tsx
const symbols = ["AAPL", "BTC", "ETH"];

<PortfolioNewsFeed symbols={symbols} limit={10} />
```

### Features

- Fetches news from Yahoo Finance
- Filters by portfolio symbols
- Renders thumbnails via shared `RemoteNewsImage` with URL sanitization
- Uses hidden fallback styling on image load failure to avoid placeholder icon boxes in card grids
- Links to full articles
- **Locale-aware timestamps (2026-04-25):** Relative date formatting respects the user's configured language (en/nl) via `useLanguage()` context, eliminating hardcoded English in news item timestamps

Code links: [[apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx]], [[apps/frontend/src/components/shared/RemoteNewsImage.tsx]], [[apps/frontend/src/pages/MarketLookupPage.tsx]]

---

## AddToWatchlistDialog

Add a symbol to the watchlist.

Supports metals as a watchlist asset-class option.

### Props

```typescript
interface AddToWatchlistDialogProps {
  trigger?: React.ReactNode;
}
```

### Form Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | Ticker symbol |
| `target_price` | number | No | Target price for alerts |
| `notes` | string | No | Notes |

### Usage

```tsx
import { AddToWatchlistDialog } from "@/components/portfolio/AddToWatchlistDialog";

<AddToWatchlistDialog>
  <Button>Add to Watchlist</Button>
</AddToWatchlistDialog>
```

---

## Portfolio Tax Components

### PortfolioTaxAdjustmentsDialog

Manage tax adjustments for investment holdings.

### Settings Propagation Notes

- Currency amounts in adjustments follow app decimal precision (`appSettings.showDecimalPlaces`)

Code links: [[apps/frontend/src/components/portfolio/PortfolioTaxAdjustmentsDialog.tsx]], [[apps/frontend/src/contexts/AppSettingsContext.tsx]]

### Usage

```tsx
import { PortfolioTaxAdjustmentsDialog } from "@/components/portfolio/PortfolioTaxAdjustmentsDialog";

<PortfolioTaxAdjustmentsDialog investmentId={123}>
  <Button>Tax Adjustments</Button>
</PortfolioTaxAdjustmentsDialog>
```

---

## AddInvestmentFromMarketDialog

Adds a new investment directly from market lookup results.

### Settings Propagation Notes

- Default generated note date now follows app date format + locale
- Transaction date form input remains persisted as `YYYY-MM-DD` for data consistency

Code links: [[apps/frontend/src/components/portfolio/AddInvestmentFromMarketDialog.tsx]], [[apps/frontend/src/components/shared/dateUtils.ts]]

### Metals Support Notes

- Unit-based behavior now includes metals for add transaction, detail valuation, and performance/overview calculations.

Code links: [[apps/frontend/src/components/portfolio/AddInvestmentDialog.tsx]], [[apps/frontend/src/components/portfolio/AddPortfolioTxnDialog.tsx]], [[apps/frontend/src/components/portfolio/InvestmentDetailDialog.tsx]], [[apps/frontend/src/components/portfolio/AddInvestmentFromMarketDialog.tsx]], [[apps/frontend/src/hooks/usePortfolio.ts]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/components/portfolio/AddToWatchlistDialog.tsx]]

---

---

## PortfolioTicker

Wall-Street-style horizontally scrolling ticker tape shown at the top of the Portfolio Overview page. Displays each owned stock's live day-change: symbol, current price, and today's % change.

### Props

```typescript
interface PortfolioTickerProps {
  /** Holdings to surface — only those with a ticker symbol Yahoo can quote appear. */
  items: InvestmentSummary[];
}
```

`InvestmentSummary` carries the `show_in_ticker?: boolean` field (from `apps/frontend/src/types/portfolio.ts`). The component splits the full prop set into a *manageable universe* (holdings with a quotable symbol) and an *included set* (`show_in_ticker !== false`). Only the included set is passed to the Yahoo batch quote call.

### Behaviour summary

- **Manageable universe**: `items` filtered to holdings where `quoteSymbolFor(inv)` resolves to a non-empty string (prefers `price_provider_id` when `price_provider === 'yahoo'`, falls back to `symbol`). Non-symbol holdings (real estate, savings) are excluded here.
- **Included set**: manageable universe further filtered to `show_in_ticker !== false`. Excluded holdings make no Yahoo quote requests.
- Fetches batch day-change quotes via `apiClient.getMarketQuotes<TickerQuote>(symbols, { detail: 'basic' })` — the same `/api/market/quote` endpoint used by Market Overview and the command palette. No new endpoint is introduced.
- React Query: `staleTime` 60 s, `refetchInterval` 60 s (online-gated via `useOnlineStatus`), `retry: 1`, query key `["portfolio-ticker", symbols]`.
- Content is duplicated twice in `.ticker-track` for a seamless CSS loop. Animation speed: `max(24s, items.length × 4.5s)`.
- Pauses on hover (`.ticker-mask:hover .ticker-track`); animation disabled under `prefers-reduced-motion`.
- Gain/loss colour via `text-gain` / `text-loss` (colorblind-aware tokens).
- **Empty tape**: the bar persists even when the included set is empty. Shows `portfolio.ticker.allHidden` placeholder when all manageable holdings are excluded, `portfolio.ticker.offline` when offline. Returns `null` only when the manageable universe itself is empty (no quotable holdings at all).

### TickerManager Popover (2026-06-24)

A sliders icon at the tape's right edge (outside the edge-fade mask) opens a `TickerManager` popover listing every holding in the manageable universe. Each row has a Radix `Switch` bound to `show_in_ticker`.

**Toggle behaviour:**
1. Optimistically updates the `INVESTMENTS_QUERY_KEY` React Query cache to flip `show_in_ticker` on the target investment.
2. Calls `apiClient.updateInvestment(id, { show_in_ticker })` (`PATCH /api/investments/:id`).
3. On error: rolls back the optimistic cache update.
4. On settle: invalidates `investments` and `portfolio-summary` queries.

The popover header shows a count badge: `portfolio.ticker.manageCount` with `{shown}` / `{total}` placeholders. The backend persists the value in the **`investment_ticker_prefs` side table** via an UPSERT in `investmentRepository.update()` (migration `0061_investments_show_in_ticker` creates this table; **not auto-applied** — run `bun run db:upgrade`). There is no `investments.show_in_ticker` column; reads `LEFT JOIN` the side table with `COALESCE(tp.show_in_ticker, true)`.

### Usage

```tsx
import { PortfolioTicker } from "@/components/portfolio/PortfolioTicker";

// In PortfolioOverviewPage — rendered when isVisible('ticker') is true:
<PortfolioTicker items={summaries} />
```

Code links: [[apps/frontend/src/components/portfolio/PortfolioTicker.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/index.css]], [[apps/frontend/src/hooks/useOnlineStatus.ts]], [[apps/frontend/src/types/api.ts]], [[apps/frontend/src/types/portfolio.ts]]

---

## Related Hooks

| Hook | Description |
|------|-------------|
| `usePortfolio()` | Portfolio data and operations |
| `usePortfolioTaxAdjustments()` | Tax adjustment data |

---

## TypeScript Types

### Watchlist Types

**File:** [[apps/frontend/src/types/watchlist.ts]]

```typescript
interface WatchlistItem {
  id: number;
  name: string;
  symbol: string | null;
  asset_class: 'stock' | 'etf' | 'crypto' | 'metals';
  target_price: number;
  currency: string;
  notes: string | null;
  price_provider_id: string | null;
  created_at: string;
  updated_at: string;
}

interface WatchlistCreate {
  name: string;
  symbol?: string;
  asset_class: 'stock' | 'etf' | 'crypto' | 'metals';
  target_price: number;
  currency?: string;
  notes?: string;
  price_provider_id?: string;
}

interface WatchlistUpdate {
  name?: string;
  symbol?: string;
  asset_class?: 'stock' | 'etf' | 'crypto' | 'metals';
  target_price?: number;
  currency?: string;
  notes?: string;
  price_provider_id?: string;
}

interface WatchlistListResponse {
  items: WatchlistItem[];
  total: number;
  limit: number;
  offset: number;
}
```

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/api/investments]] - Investments API
- [[docs/api/watchlist]] - Watchlist API
- [[docs/features/portfolio]] - Portfolio Features

## WatchlistPage Integration (Phase 3.6)

The `WatchlistPage.tsx` was refactored to use encapsulated `apiClient` watchlist methods instead of raw `fetch()` calls:

**Before (Phase 3.5):** Three separate raw fetch calls for watchlist, market quotes, and deletion.
**After (Phase 3.6):** Centralized via `apiClient.getWatchlist()`, `apiClient.getMarketQuotes(symbols)`, and `apiClient.deleteWatchlistItem(id)`.

Benefits:
- Shared retry logic and timeout handling
- Built-in error formatting and user feedback
- React Query integration for caching and invalidation
- Typed method signatures for better IDE support

Code link: [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx]], [[apps/frontend/src/lib/api.ts]]

## Additional Page Links

- [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]] - Savings maturity date display uses app date format
- [[apps/frontend/src/pages/admin/ExchangeRatesPage.tsx]] - Exchange-rate fetched-at/description timestamps use app date-time format
- [[apps/frontend/src/pages/MarketLookupPage.tsx]] - Chart tooltip timestamps and analyst/news dates use app date-time/date format
- [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]] - Month labels use app-language locale (`en-US`/`nl-NL`), while chart/table values use app settings; page includes Total/Investments/Liquid series toggle, daily-only timeline with per-day hover values, horizontal scroll/zoom controls, and a virtualized daily breakdown table
- [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]] - Absolute and relative charts run on day-level timeline points (`YYYY-MM-DD`) for more realistic fluctuation shape; relative contribution adjustment uses day-keyed net flows (not month-bucket chart alignment); chart x-axis keys by day internally while rendering locale-formatted month-year ticks for readability; relative performance keeps chained index baseline `1` with display conversion `(index - 1) * 100`; monthly heatmap remains month-based and keeps Modified Dietz-style monthly return denominator `prevValue + netFlow / 2` (fallback `prevValue` when denominator <= 0); first heatmap month is rendered as no data (`null`) rather than forced `0%`; inflation adjustment compounds backend Belgian monthly rates (`/api/info/inflation-rates`) keyed by `YYYY-MM`; when DB-only historical quote cache is empty for an investment, the page now performs a non-DB fallback fetch once to hydrate and use provider history instead of flattening that asset line.
- [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx]] - Phase 3.6 refactored to use `apiClient` watchlist methods (`getWatchlist()`, `getMarketQuotes()`, `deleteWatchlistItem()`) instead of raw fetch calls; 60s auto-refresh interval on market quotes via React Query

- [[apps/frontend/src/lib/api.ts]] - Adds `getBelgianInflationRates({ start_month?, end_month? })` client helper for `GET /api/info/inflation-rates`; Phase 3.6 adds watchlist methods (`getWatchlist()`, `createWatchlistItem()`, `updateWatchlistItem()`, `deleteWatchlistItem()`) and market quotes method (`getMarketQuotes(symbols)`).
- [[apps/node-backend/src/services/belgianInflationService.js]] - Statbel-backed monthly inflation service with memory cache, DB persistence, and remote fallback behavior.
- [[apps/node-backend/src/routes/info.js]] - Exposes `GET /api/info/inflation-rates` and admin-limited `POST /api/info/inflation-rates/refresh`.
- [[alembic/versions/0001_initial_database_schema.py]] - Creates `belgian_inflation_rates` table and indexes via Alembic baseline migration.
- [[apps/node-backend/src/main.js]] - Warms and schedules Belgian inflation cache refresh during backend startup lifecycle.
