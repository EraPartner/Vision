---
title: Portfolio Components
type: component
status: active
date: 2025-03-18
tags: [components, portfolio, investments]
description: Components for investment portfolio management
related_code: ["apps/frontend/src/components/portfolio"]
---

# Portfolio Components

Components for managing investment portfolios, including stocks, crypto, real estate, and savings.

## Component List

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/add-investment-dialog|AddInvestmentDialog]] | Add new investment | `AddInvestmentDialog.tsx` |
| [[docs/components/add-portfolio-txn-dialog|AddPortfolioTxnDialog]] | Record buy/sell transactions | `AddPortfolioTxnDialog.tsx` |
| [[docs/components/investment-detail-dialog|InvestmentDetailDialog]] | View investment details | `InvestmentDetailDialog.tsx` |
| [[docs/components/add-to-watchlist-dialog|AddToWatchlistDialog]] | Add symbol to watchlist | `AddToWatchlistDialog.tsx` |
| [[docs/components/portfolio-news-feed|PortfolioNewsFeed]] | Market news for holdings | `PortfolioNewsFeed.tsx` |
| [[docs/components/watchlist-chart-dialog|WatchlistChartDialog]] | Chart for watchlist symbol | `WatchlistChartDialog.tsx` |
| [[docs/components/add-investment-from-market-dialog|AddInvestmentFromMarketDialog]] | Add investment from market search | `AddInvestmentFromMarketDialog.tsx` |
| [[docs/components/portfolio-tax-adjustments-dialog|PortfolioTaxAdjustmentsDialog]] | Tax adjustments for investments | `PortfolioTaxAdjustmentsDialog.tsx` |

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
- Shows thumbnails when available
- Links to full articles

---

## AddToWatchlistDialog

Add a symbol to the watchlist.

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

### Usage

```tsx
import { PortfolioTaxAdjustmentsDialog } from "@/components/portfolio/PortfolioTaxAdjustmentsDialog";

<PortfolioTaxAdjustmentsDialog investmentId={123}>
  <Button>Tax Adjustments</Button>
</PortfolioTaxAdjustmentsDialog>
```

---

## Related Hooks

| Hook | Description |
|------|-------------|
| `usePortfolio()` | Portfolio data and operations |
| `useWatchlist()` | Watchlist management |
| `usePortfolioTaxAdjustments()` | Tax adjustment data |

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/api/investments]] - Investments API
- [[docs/api/watchlist]] - Watchlist API
- [[docs/features/portfolio]] - Portfolio Features
