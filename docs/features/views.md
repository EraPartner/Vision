---
title: Views & Pages
type: feature
status: active
date: 2025-03-18
tags: [feature, views, pages, frontend, ui]
description: Complete overview of all views and pages in the Vision application
related_code: ["apps/frontend/src/App.tsx", "apps/frontend/src/pages"]
---

# Views & Pages

Vision provides a comprehensive set of views for managing your finances. This document details each view, its purpose, and the actions you can perform.

---

## Navigation

The sidebar navigation provides access to all views:

```
Dashboard
Transactions
Categories
Recipients
Planned Payments
Statistics
Import
Owes (Splits)
Tax
Portfolio
```

---

## Dashboard (`/`)

The main landing page providing a quick overview of your finances.

### Widgets Available

| Widget | Description |
|--------|-------------|
| **Stat Cards** | Total income, expenses, net worth summary |
| **Bank Balances** | Current balance per bank account |
| **Monthly Trends** | Income vs expenses over time (bar chart) |
| **Category Distribution** | Spending by category (pie chart) |
| **Cashflow Comparison** | Current vs previous period |
| **Recent Transactions** | Latest transactions table |

### Features

- **Widget Customization**: Show/hide widgets via the visibility dialog
- **Exclusion Controls**: Filter categories/recipients from dashboard stats
- **Date Range**: View current month by default
- **Real-time Data**: Refreshes automatically

### Use Cases

- Daily overview of financial health
- Quick glance at account balances
- Spot unusual spending patterns

---

## Transactions (`/transactions`)

Full transaction management with advanced filtering and editing.

### Features

- **List View**: Paginated table of all transactions
- **Filters**:
  - Date range (start/end date)
  - Category selection
  - Recipient selection
  - Amount range (min/max)
  - Bank account
  - Currency
  - Hidden/active status
- **Inline Editing**: Quick edit amount, category, recipient
- **Bulk Actions**: Select multiple transactions for batch operations
- **Export**: Download filtered transactions as CSV
- **Search**: Full-text search on memo/description

### Actions

- Create new transaction
- Edit existing transaction
- Delete transaction
- Split transaction (see [[docs/features/transactions]])
- Assign category
- Hide transaction (soft delete)

### Related API

- [[docs/api/transactions]] - Full CRUD operations

---

## Categories (`/categories`)

Manage transaction categorization with hierarchical categories.

### Features

- **Hierarchical Structure**: Format `GENERAL:DETAIL` (e.g., `FOOD:GROCERIES`)
- **Category Management**:
  - Create new categories
  - Edit category name/details
  - Set default category for recipients
  - Activate/deactivate categories
- **Bulk Assignment**: Assign categories to multiple transactions
- **Usage Statistics**: See transaction count per category
- **Color Coding**: Visual identification (via category colors)

### Category Structure

```
FOOD
├── GROCERIES
├── DINING
└── DELIVERY

TRANSPORT
├── CAR
│   ├── GAS
│   └── INSURANCE
├── PUBLIC
└── TAXI

UTILITIES
├── ELECTRICITY
├── GAS
├── WATER
└── INTERNET
```

### Related API

- [[docs/api/categories]] - Category CRUD and assignment

---

## Recipients (`/recipients`)

Manage payees and payers (merchants, employers, etc.).

### Features

- **Recipient List**: All recipients with transaction counts
- **Create/Edit**: Add new recipients with details
- **Merge**: Combine duplicate recipients
- **Unmerge**: Separate merged recipients
- **Aliases**: Alternative names for matching
- **Default Categories**: Set default category per recipient
- **Bank Accounts**: Link bank accounts to recipients
- **Notes**: Add notes about recipients

### Actions

- Create recipient
- Edit recipient details
- Delete (soft) recipient
- Merge with another recipient
- Add/edit bank accounts
- View transaction history per recipient

### Related API

- [[docs/api/recipients]] - Recipient CRUD
- [[docs/api/recipientBankAccounts]] - Bank account management

---

## Planned Payments (`/planned`)

Track upcoming and recurring payments.

### Features

- **Upcoming Payments**: List of planned transactions
- **One-time Payments**: Single future payments
- **Recurring Payments**: Weekly, monthly, yearly schedules
- **Loan Tracking**: Special loan repayment management
- **Execute**: Mark as paid (creates transaction)
- **Overdue Alerts**: Highlight missed payments

### Transaction Types

1. **One-time**: Single future payment
2. **Recurring**: Regular schedule
3. **Loan**: Amortization schedule with interest

### Loan Types

- **Amortizing**: Standard mortgage/loan
- **Fixed Principal**: Equal principal payments
- **Interest Only**: Interest-only period

### Related API

- [[docs/api/plannedTransactions]] - Planned transaction CRUD

---

## Statistics (`/statistics`)

Comprehensive analytics and reporting dashboard.

### Tabs & Widgets

| Widget | Description |
|--------|-------------|
| **Summary Cards** | Total income, expenses, savings rate |
| **Monthly** | Monthly income/expense breakdown |
| **Net Trend** | Net worth trend over time |
| **Category Pie** | Spending by category |
| **Category Trend** | Category spending over time |
| **Pivot Table** | Category × Month matrix |
| **Top Recipients** | Biggest spending recipients |
| **Yearly Comparison** | Year-over-year analysis |
| **Yearly Summary** | Annual totals |

### Features

- **Custom Charts**: Save chart configurations
- **Date Range**: Custom period selection
- **Exclusions**: Filter out categories/recipients
- **Export**: Download reports
- **Saved Charts**: Reusable chart configs

### Use Cases

- Monthly spending analysis
- Year-over-year comparison
- Category trends identification
- Budget planning

---

## Import (`/import`)

Import transactions from bank CSV files.

### Features

- **CSV Upload**: Drag-and-drop file upload
- **Bank Detection**: Auto-detect bank format
- **Custom Mapping**: Map CSV columns to fields
- **Duplicate Detection**: Identify existing transactions
- **Preview**: Review before import
- **Category Prediction**: Auto-suggest categories
- **Recurring Detection**: Identify subscription patterns

### Supported Banks

- Belfius
- Revolut
- KBC
- SABB
- Wise
- Vision (internal)
- Custom (configurable)

### Import Process

1. Upload CSV file
2. Select bank adapter or custom
3. Map columns (if custom)
4. Preview transactions
5. Confirm import
6. View results

### Related API

- [[docs/api/imports]] - Import endpoints
- [[docs/features/import]] - Import feature details

---

## Owes (`/owes`)

Track shared expenses and debts between people.

### Features

- **Owed Summary**: Who owes whom
- **Split Transactions**: Divide expenses
- **Payment Tracking**: Record partial payments
- **Settlement**: Mark debts as settled
- **Per-Person View**: Detailed breakdown per person

### Use Cases

- Roommate expense splitting
- Group dinner bills
- Shared vacation costs
- Family lending

### Related API

- [[docs/api/splits]] - Split and debt management

---

## Tax (`/tax`)

Belgian tax profile and deduction tracking.

### Features

- **Tax Profile**: Municipality, income details
- **Cadastral Income**: Property tax tracking
- **Deductions**: Tax-deductible expenses
- **Real Estate**: Property investment details
- **Tax Reports**: Summary for tax filing

### Data Tracked

- Municipality name
- Municipality tax rate
- Cadastral income
- Property details

### Related

- [[docs/adr/002-database-schema]] - Tax fields in schema

---

## Portfolio (`/portfolio`)

Investment portfolio management across multiple asset classes.

### Portfolio Views

| View | Path | Description |
|------|------|-------------|
| **Overview** | `/portfolio` | Summary of all investments |
| **Stocks** | `/portfolio/stocks` | Equity holdings |
| **Crypto** | `/portfolio/crypto` | Cryptocurrency holdings |
| **Real Estate** | `/portfolio/real-estate` | Property investments |
| **Savings** | `/portfolio/savings` | Savings accounts |
| **Performance** | `/portfolio/performance` | Performance analytics |
| **Net Worth** | `/portfolio/net-worth` | Total net worth |
| **Exchange Rates** | `/portfolio/exchange-rates` | Currency rates |
| **Watchlist** | `/portfolio/watchlist` | Track symbols |
| **Market Lookup** | `/portfolio/market` | Search & lookup |
| **Tax** | `/portfolio/tax` | Investment tax info |

### Portfolio Overview Features

- **Summary Cards**: Total value, gain/loss
- **Allocation Chart**: Asset class distribution
- **Performance Widget**: Returns over time
- **Investment List**: All holdings with details
- **News Feed**: Related market news
- **Refresh Prices**: Update all prices

### Asset Classes

1. **Stocks**: Individual stocks, ETFs
2. **Crypto**: Cryptocurrencies
3. **Real Estate**: Properties
4. **Savings**: Savings accounts, CDs
5. **Bonds**: Government/corporate bonds

### Investment Features

- Add/remove investments
- Record buy/sell transactions
- Track cost basis
- Calculate gains (realized/unrealized)
- Price refresh from providers

### Price Providers

- CoinGecko (crypto)
- Yahoo Finance (stocks)
- Kraken (crypto)
- Custom (manual)

### Related API

- [[docs/api/investments]] - Investment CRUD
- [[docs/api/watchlist]] - Watchlist management
- [[docs/api/marketLookup]] - Market data

---

## Market Lookup (`/portfolio/market`)

Real-time market data search and quotes.

### Features

- **Symbol Search**: Find stocks/crypto by name
- **Quote Details**: Price, change, volume
- **Fundamentals**: P/E, market cap, dividends
- **Charts**: Historical price charts
- **News**: Latest market news
- **Analyst Ratings**: Buy/hold/sell consensus

### Data Source

Powered by Yahoo Finance (yahoo-finance2)

---

## Watchlist (`/portfolio/watchlist`)

Track symbols without owning them.

### Features

- Add symbols to watchlist
- View current prices
- Price alerts (future)
- Performance tracking

---

## Settings

While not a separate view, settings are accessible via the sidebar/settings:

### Categories

- **General**: Language, currency, date format
- **Dashboard**: Exclusion scope, default views
- **Categories**: Custom category management
- **Workspace**: Multi-workspace settings

---

## Widget System

Many pages use a **widget visibility system** that allows users to:

- Show/hide specific widgets
- Reset to default layout
- Persist preferences per page

This is available on:
- Dashboard
- Statistics
- Portfolio Overview

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + K` | Search/command palette |
| `Ctrl/Cmd + N` | New transaction |
| `Escape` | Close dialogs |

---

## Related Documentation

- [[docs/features/index]] - Feature documentation
- [[docs/api/index]] - API documentation
- [[docs/components/index]] - UI Components
