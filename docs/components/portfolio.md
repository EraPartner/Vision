---
title: Portfolio Components
type: component
status: active
date: 2026-04-02
tags: [components, portfolio, investments]
description: Components for investment portfolio management
aliases: [portfolio-components, investment-components, holdings-components]
related_code: ["apps/frontend/src/components/portfolio"]
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

Code links: [[apps/frontend/src/components/portfolio/InvestmentDetailDialog.tsx]], [[apps/frontend/src/components/shared/dateUtils.ts]]

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

## Additional Page Links

- [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]] - Savings maturity date display uses app date format
- [[apps/frontend/src/pages/portfolio/ExchangeRatesPage.tsx]] - Exchange-rate fetched-at/description timestamps use app date-time format
- [[apps/frontend/src/pages/MarketLookupPage.tsx]] - Chart tooltip timestamps and analyst/news dates use app date-time/date format
- [[apps/frontend/src/pages/portfolio/NetWorthPage.tsx]] - Month labels use app-language locale (`en-US`/`nl-NL`), while chart/table values use app settings; page includes Total/Investments/Liquid series toggle, daily-only timeline with per-day hover values, horizontal scroll/zoom controls, and a virtualized daily breakdown table
- [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]] - Absolute and relative charts run on day-level timeline points (`YYYY-MM-DD`) for more realistic fluctuation shape; relative contribution adjustment uses day-keyed net flows (not month-bucket chart alignment); chart x-axis keys by day internally while rendering locale-formatted month-year ticks for readability; relative performance keeps chained index baseline `1` with display conversion `(index - 1) * 100`; monthly heatmap remains month-based and keeps Modified Dietz-style monthly return denominator `prevValue + netFlow / 2` (fallback `prevValue` when denominator <= 0); first heatmap month is rendered as no data (`null`) rather than forced `0%`; inflation adjustment compounds backend Belgian monthly rates (`/api/info/inflation-rates`) keyed by `YYYY-MM`; when DB-only historical quote cache is empty for an investment, the page now performs a non-DB fallback fetch once to hydrate and use provider history instead of flattening that asset line.

- [[apps/frontend/src/lib/api.ts]] - Adds `getBelgianInflationRates({ start_month?, end_month? })` client helper for `GET /api/info/inflation-rates`.
- [[apps/node-backend/src/services/belgianInflationService.js]] - Statbel-backed monthly inflation service with memory cache, DB persistence, and remote fallback behavior.
- [[apps/node-backend/src/routes/info.js]] - Exposes `GET /api/info/inflation-rates` and admin-limited `POST /api/info/inflation-rates/refresh`.
- [[apps/node-backend/src/database/schemaInit.js]] - Creates `belgian_inflation_rates` table and indexes/triggers during schema init.
- [[apps/node-backend/src/main.js]] - Warms and schedules Belgian inflation cache refresh during backend startup lifecycle.
