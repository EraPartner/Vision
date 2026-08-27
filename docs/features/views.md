---
title: Views & Pages
type: feature
status: active
date: 2026-04-10
updated: 2026-08-27
tags: [feature, views, pages, frontend, ui, liquid-glass-v2, june-2026, portfolio-ticker]
description: Complete overview of all views and pages in the Vision application. June 2026 Liquid Glass v2 — KPI/chart cards migrated to glass-regular, hero cards to glass-elevated, tables stay opaque, surface-elevated recipe superseded.
aliases: [views, pages, frontend views, application pages, ui views]
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
  - Overview
  - Stocks
  - Crypto
  - Metals
  - Real Estate
  - Savings
  - Performance
  - Net Worth
  - Exchange Rates
  - Watchlist
  - Market Lookup
  - Tax
```

---

## Dashboard (`/`)

The main landing page providing a quick overview of your finances.

### Widgets Available

| Widget | Description |
|--------|-------------|
| **Suggestions** | Contextual suggestion card — appears only when planned payments are due within 7 days (replaces the global upcoming-payments banner on the dashboard) |
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
- **Semantic date-label UX pass (dashboard)**: Cashflow month descriptions/headings and Monthly Trends x-axis labels now use `formatMonthYearWithAppSettings(date, appDateFormat, locale?)` from [[apps/frontend/src/components/shared/dateUtils.ts]] to avoid overly detailed full-date labels while respecting app settings
- **Hotfix (settings-refactor runtime safety)**: Dashboard cashflow month description labels used an in-scope `locale` (not undefined `language`) in [[apps/frontend/src/pages/DashboardPage.tsx]] and the since-removed `CashFlowComparisonChart.tsx`.

### Use Cases

- Daily overview of financial health
- Quick glance at account balances
- Spot unusual spending patterns

---

## Transactions (`/transactions`)

Full transaction management with advanced filtering and editing.

### Features

- **List View**: Paginated table of all transactions
- **Server Search Sync**: Search input is controlled and persists the typed value after execution (`VirtualDataTable` + `TransactionsPage`)
- **Progressive Search Updates**: Typing and backspacing both update search terms (including loosened queries) with debounced server requests
- **Filters**:
  - Date range (start/end date)
  - Category selection
  - Recipient selection
  - Amount range (min/max)
  - Bank account
  - Currency
  - Hidden/active status
- **Inline Editing**: Quick edit amount, category, recipient
- **Extra Info Inline Editing**: Edit existing extra information rows inline from the dialog via per-row pencil action (transaction ID remains read-only)
- **Bulk Actions**: Select multiple transactions for batch operations
- **Export**: Download filtered transactions as CSV
- **Search**: Full-text search on memo/description

### Search Behavior

- Search input state is maintained locally in `VirtualDataTable` while server filtering is driven by controlled `searchValue`/`onSearchChange` in `TransactionsPage`.
- Debounced server updates (200ms) provide a more live search feel while preserving immediate input feedback.
- Clearing search (button or character-by-character) updates the query consistently and avoids stale delayed requests.
- Virtual table rendering uses deferred data (`useDeferredValue`) to keep typing fluid during refreshes.

Code links: [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/components/shared/PageHeader.tsx]], [[apps/frontend/src/components/shared/EmptyState.tsx]], [[apps/frontend/src/components/shared/PageError.tsx]]

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
- Long category detail names truncate inside their badge and retain the full value in the native title tooltip.

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
- **Server Search Sync**: Shared virtual table search behavior with persistent input and debounced server filtering
- **Uncategorized Filter**: Toggle to view only recipients without default categories
- **Create/Edit**: Add new recipients with details
- **Merge**: Combine duplicate recipients
- **Merge Search Uses Full Dataset**: Merge dialog fetches all recipients (paged in the background) so primary/alias search is not limited to currently loaded table rows
- **Unmerge**: Separate merged recipients
- **Aliases**: Alternative names for matching
- **Default Categories**: Set default category per recipient (inline editing)
- **Bank Accounts**: Link bank accounts to recipients
- **Notes**: Add notes about recipients
- Long recipient and merge-target names truncate in the virtual table and retain their full value in native title tooltips.

### Search Behavior

- Recipients search uses the same controlled virtual-table flow as transactions.
- Search updates while typing and while removing characters, so broadening a query immediately reflects in the next debounced fetch.
- Input persistence and clear handling are implemented in `VirtualDataTable` and consumed by `RecipientsPage`.
- The page-level `PageHeader` is the sole "All recipients" heading. The table omits its optional
  title while retaining search and the Add/Merge/filter action toolbar.

Code links: [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/pages/RecipientsPage.tsx]], [[apps/frontend/src/features/recipients/MergeRecipientsDialog.tsx]], [[apps/frontend/src/components/shared/PageHeader.tsx]], [[apps/frontend/src/components/shared/EmptyState.tsx]], [[apps/frontend/src/components/shared/PageError.tsx]]

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
- **Currency Defaults Enforced**: New/reset planned payment currency now defaults to `appSettings.defaultCurrency`
- **Execute**: Mark as paid (creates transaction)
- **Overdue Alerts**: Highlight missed payments

Code links: [[apps/frontend/src/features/planned/PlannedPaymentForm.tsx]], [[apps/frontend/src/hooks/usePlannedPayments.ts]]

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
| **Category Pie** | Spending by category (top 10) |
| **Category Trend** | Category spending over time (top 5) |
| **Pivot Table** | Category × Month matrix with hierarchical grouping |
| **Top Recipients** | Biggest spending recipients |
| **Yearly Comparison** | Year-over-year analysis |
| **Yearly Summary** | Annual totals |
| **Custom Charts** | User-configurable category charts |
| **Saved Charts** | Reusable saved chart configurations |

### Features

- **Custom Charts**: Save chart configurations with selected categories
- **Per-graph Exclusions**: Each chart can independently toggle category/recipient exclusions
- **Currency-aware statistics requests**: Statistics and dashboard analytics endpoints are requested with the selected app currency, and query caches are keyed by currency to keep results isolated
- **Hierarchical Pivot Table**: Categories grouped by GENERAL with DETAIL sub-items
- **Pivot Metric Modes**: Category pivot table supports `Absolute (Income + Expense)`, `Net (Income - Expense)`, `Income only`, and `Expense only`
- **Pivot Mode Semantics**: Historical default behavior remains available as `Absolute` (sum of `abs(tx.amount)`), while `Net` includes negative values and sorts rows by absolute net magnitude
- **Combined Filtering**: Pivot year filter remains available and now combines with the selected metric mode
- **Top Recipients Year Filter**: Spending chart supports `All years` plus per-year filtering backed by pre-aggregated yearly recipient totals
- **Widget Visibility**: Show/hide widgets via visibility dialog
- **Chart Types**: Line, bar, and area charts for custom charts
- **Semantic date-label UX pass (portfolio pages)**: [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]] uses language-locale month labels on the x-axis and app date-format labels for tooltip/table day values; [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]] uses locale month-only labels for heatmap headers and month-year helper labels for chart x-axis keys
- **Cross-currency portfolio normalization**: Portfolio Overview, Performance, and Portfolio Tax monetary displays are converted to app default currency from live `/api/info/exchange-rates`; percentage values remain unchanged
- **Hotfix (settings-refactor runtime safety)**: Net Worth month-label callsites now consistently use in-scope `locale` in [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]] to prevent runtime `ReferenceError` from undefined aliases
- **Recipient Insights Pagination**: `defaultPageSize` is enforced for initial load and load-more behavior
- **Recipient Insights Reactivity**: Tab memo dependencies include `defaultPageSize` and paging inputs to avoid stale slices
- **Locale-safe Integer Rendering**: Integer counters use app locale formatting (dashboard/stats surfaces)
- **Currency Precision from Settings**: Currency displays follow `appSettings.showDecimalPlaces` across stats and tax views
- **Chart Tooltip Number Safety**: Shared chart tooltip numeric rendering is zero-safe and robust for mixed values

### Category Name Formatting

Categories follow the `GENERAL: DETAIL` format:
- **GENERAL**: Main category (e.g., FOOD, TRANSPORT, UTILITIES)
- **DETAIL**: Specific subcategory (e.g., GROCERIES, GAS, ELECTRICITY)

The statistics page normalizes all category names to ensure consistent formatting across:
- Pie chart labels
- Trend chart legends
- Pivot table rows
- Custom chart selections

### Use Cases

- Monthly spending analysis
- Year-over-year comparison
- Category trends identification
- Budget planning
- Recipient spending patterns

Code links: [[apps/frontend/src/features/statistics/RecipientInsightsTab.tsx]], [[apps/frontend/src/pages/DashboardPage.tsx]], [[apps/frontend/src/features/dashboard/BankBalancesWidget.tsx]], [[apps/frontend/src/pages/StatisticsPage.tsx]], [[apps/frontend/src/features/statistics/statisticsUtils.ts]], [[apps/frontend/src/hooks/useStatistics.ts]], [[apps/frontend/src/hooks/useFilteredDashboardStats.ts]], [[apps/frontend/src/locales/en.ts]], [[apps/frontend/src/locales/nl.ts]], [[apps/frontend/src/pages/TaxOverviewPage.tsx]], [[apps/frontend/src/features/tax/SuggestedDeductionsCard.tsx]], [[apps/frontend/src/features/portfolio/PortfolioTaxAdjustmentsDialog.tsx]], `apps/frontend/src/components/charts/` (chart.tsx removed in ADR-018 visx/d3 migration)

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
- **Bulk Settle (Per Person)**: Settle all currently listed outstanding splits for the selected person from the per-person view (with confirmation)
- **Split Source Context**: Per-person rows show both original transaction recipient and memo
- **Jump to Source Transaction**: Double-click a split row to open Transactions filtered to the source `transaction_id`
- **Recent Recipient Transactions Table**: Per-person detail now includes a bottom `VirtualDataTable` listing recent transactions for that recipient
- **Infinite Scroll (Recipient Detail)**: Loads an initial 10 rows and fetches 10 more as you scroll
- **Recipient Table Columns**: Date, Description, Category, Amount, Bank Account
- **Recipient Table Empty State**: Shows localized empty state text when no recent transactions exist for the recipient
- **Jump to Source Transaction (Recent Table)**: Double-click a recent transaction row to open Transactions filtered by that row's `transaction_id`

Code links: [[apps/frontend/src/pages/OwesPage.tsx]], [[apps/frontend/src/features/splits/owes/RecipientOwesDetail.tsx]], [[apps/frontend/src/features/splits/owes/RecentRecipientTransactionsTable.tsx]], [[apps/frontend/src/features/splits/owes/useRecentRecipientTransactions.ts]], [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/features/splits/SplitTransactionDialog.tsx]], [[apps/frontend/src/locales/en.ts]], [[apps/frontend/src/locales/nl.ts]]

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

- **Premium consistency updates**: page-level header/empty-state patterns are standardized across Overview, Stocks, Crypto, Real Estate, Savings, Performance, Net Worth, Exchange Rates, Watchlist, Market Lookup, and Tax pages using shared `PageHeader` and `EmptyState` where applicable
- **Surface consistency updates**: key summary/KPI cards in Exchange Rates, Recipient Insights, Tax Overview, and Portfolio Tax now use sanctioned surface recipes (`surface-elevated premium-frame micro-lift`) instead of ad-hoc elevated class chains
- **Touch ergonomics updates**: icon-only actions on portfolio/list/detail flows (including Planned Payments actions and dialog controls) use `icon-touch-target` for consistent hit areas

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
| **Metals** | `/portfolio/metals` | Precious metals holdings |
| **Performance** | `/portfolio/performance` | Performance analytics |
| **Net Worth** | `/portfolio/net-worth` | Total net worth |
| **Exchange Rates** (admin mode) | `/admin/exchange-rates` | Currency rates |
| **Watchlist** | `/portfolio/watchlist` | Track symbols |
| **Market Lookup** | `/portfolio/market` | Search & lookup |
| **Tax** | `/portfolio/tax` | Investment tax info |

### Portfolio Overview Features

- **Price Ticker**: Wall-Street-style scrolling marquee at the top of the overview showing each owned stock's live day-change (symbol · current price · today's % change). Fetches batch quotes from `/api/market/quote?detail=basic` on a 60 s interval; pauses on hover; respects `prefers-reduced-motion`; hidden offline. Toggleable via widget visibility dialog (id `ticker`, default visible). See [[docs/features/portfolio#portfolio-overview-ticker-widget-2026-06-24|Portfolio Ticker]].
- **Summary Cards**: Total value, gain/loss
- **Currency-normalized totals**: Summary cards, allocation chart values, and investment list amounts are converted to `appSettings.defaultCurrency` via `/api/info/exchange-rates`
- **Allocation Chart**: Asset class distribution
- **Allocation Group Source**: Overview allocation groups are derived from `getAssetClassGroups(t)` (not deprecated `ASSET_CLASS_GROUPS`), so metals are included with translated labels
- **Performance Widget**: Returns over time
- **Investment List**: All holdings with details
- **News Feed**: Related market news
- **Refresh Prices**: Update all prices
- **Default/Reset Currency Source**: Add investment dialog default/reset currency follows `appSettings.defaultCurrency`

Code links: [[apps/frontend/src/features/portfolio/AddInvestmentDialog.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]], [[apps/frontend/src/pages/admin/ExchangeRatesPage.tsx]], [[apps/frontend/src/pages/research/WatchlistPage.tsx]], [[apps/frontend/src/pages/research/MarketLookupPage.tsx]], [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx]], [[apps/frontend/src/features/portfolio/InvestmentDetailDialog.tsx]], [[apps/frontend/src/components/shared/PageHeader.tsx]], [[apps/frontend/src/components/shared/EmptyState.tsx]], [[apps/frontend/src/index.css]]

### Asset Classes

1. **Stocks**: Individual stocks, ETFs
2. **Crypto**: Cryptocurrencies
3. **Real Estate**: Properties
4. **Savings**: Savings accounts, CDs
5. **Bonds**: Government/corporate bonds
6. **Metals**: Precious metals tracked as unit-based holdings

### Investment Features

- Add/remove investments
- Record buy/sell transactions
- Track cost basis
- Calculate gains (realized/unrealized)
- Price refresh from providers
- Stocks, Crypto, Real Estate, and Savings page display amounts are normalized to app default currency using live `/api/info/exchange-rates` payload for totals and row currency amounts
- Metals page reuses Stocks page behavior and inherits the same currency normalization path
- Per-row and summary percentage metrics remain percentage-only (no currency conversion)

### Net Worth View Highlights

- Net Worth chart runs in daily mode with a series toggle (Total / Investments / Liquid) so users can focus on one line at a time.
- For long histories, Net Worth keeps horizontal scroll + zoom controls and shows a `Latest` jump action when not at the newest range.
- Net Worth values are fetched in the selected app currency (`/api/info/net-worth?currency=...`) and the daily breakdown table is virtualized for large histories.
- Y-axis domain is recalculated for the selected series in the visible viewport so Total/Investments/Liquid toggles expose detailed variation rather than sharing a fixed global scale.

### Performance View Highlights

- Monthly heatmap uses relative monthly returns (%) derived from investment value performance adjusted for monthly net contributions/withdrawals.
- Heatmap excludes liquid-cash effects and keeps month coverage from first investment month through current month.
- Portfolio Value Over Time chart removes duplicate Area series so legend labels are unique (Stocks & ETFs, Crypto, Metals, Portfolio Value) while preserving chart visuals and line semantics ([[apps/frontend/src/pages/portfolio/PerformancePage.tsx]]).

Code links: [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]]

### Price Providers

- Binance (crypto)
- Yahoo Finance (stocks)
- Kinesis (US stocks)
- Custom (manual)

### Related API

- [[docs/api/investments]] - Investment CRUD
- [[docs/api/watchlist]] - Watchlist management
- [[docs/api/marketLookup]] - Market data

---

## Market Lookup (`/portfolio/market`)

Real-time market data search and quotes.

### Features

- **Premium consistency updates**: top-level page heading now uses shared `PageHeader` while quote-level heading remains content-scoped

- **Symbol Search**: Find stocks/crypto by name
- **Quote Details**: Price, change, volume
- **Fundamentals**: P/E, market cap, dividends
- **Charts**: Historical price charts
- **News**: Latest market news
- **Analyst Ratings**: Buy/hold/sell consensus
- **Date/time formatting consistency**: Chart tooltips and analyst/news date labels follow app date format + locale settings
- **News image rendering fix**: backend CSP now permits remote HTTPS thumbnails, and market/portfolio news cards hide image fallback placeholders on thumbnail fetch failures

Code links: [[apps/frontend/src/pages/research/MarketLookupPage.tsx]], [[apps/frontend/src/components/shared/dateUtils.ts]], [[apps/frontend/src/components/shared/RemoteNewsImage.tsx]], [[apps/frontend/src/features/portfolio/PortfolioNewsFeed.tsx]], [[apps/node-backend/src/main.js]], [[apps/node-backend/src/routes/marketLookup.js]]

### Data Source

Powered by Yahoo Finance (yahoo-finance2)

---

## Watchlist (`/portfolio/watchlist`)

Track symbols without owning them.

### Features

- **Premium consistency updates**: page header and empty state use shared primitives, list cards use consistent premium surface recipes, and watchlist toasts run via Sonner (`toast.success` / `toast.error`)

- Add symbols to watchlist
- View current prices
- Price alerts (future)
- Performance tracking
- Long watchlist company names truncate before the asset-class badge and retain the full name in the native title tooltip.
- Date axis labels in chart dialog follow app date format
- Target/current price and currency displays follow app number format + decimal settings
- Net Worth and Performance chart axes share the same app-language-aware date roles: day/month for short periods and month/two-digit-year for longer periods; detailed tooltips use a four-digit year
- Runtime-safety hotfix: `formatDisplayCurrency` in [[apps/frontend/src/features/portfolio/WatchlistChartDialog.tsx]] is defined inside component scope so it closes over in-scope `locale` and `appSettings` (prevents runtime undefined-reference failures)

Code links: [[apps/frontend/src/pages/research/WatchlistPage.tsx]], [[apps/frontend/src/features/portfolio/WatchlistChartDialog.tsx]], [[apps/frontend/src/features/portfolio/AddToWatchlistDialog.tsx]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx]], [[apps/frontend/src/components/shared/dateUtils.ts]], [[apps/frontend/src/App.tsx]], [[apps/frontend/src/components/ui/sonner.tsx]]

---

## Settings

While not a separate view, settings are accessible via the sidebar/settings dialog.

### Tabs

- **General**: App-wide preferences (default currency, number/date format, decimal places, start of week, default page size, language)
- **Dashboard**: Dashboard/statistics exclusions and exclusion scope
- **App**: Setup wizard restart and app update controls
- **Backup**: Backup/restore configuration (Electron)

### Propagation Notes

- **Currency + number format**: `defaultCurrency` and `numberFormat` now propagate across add-transaction defaults and major displays (dashboard, owes, planned payments, portfolio, statistics)
- **Decimal places**: `showDecimalPlaces` is respected by statistics/custom category currency formatters, tax overview displays, suggested deductions, portfolio tax adjustments, and watchlist target/current price displays
- **Dates + calendar week start**: `dateFormat` is used across shared date pickers and transaction/date-heavy pages, plus update release dates (notification + settings), investment transaction/maturity dates, exchange-rate timestamps, market lookup chart/news/analyst labels, recurring-detection labels, watchlist chart labels, and add-from-market default note date; `startOfWeek` is used by calendar pickers
- **Pagination defaults**: `defaultPageSize` now drives Transactions, Recipients, and Recipient Insights load-more pagination
- **Reset behavior**: `Reset all` now resets both general app settings and dashboard exclusions
- **Strict date-format enforcement complete (frontend month labels)**: After the latest pass, no `toLocaleDateString(` remains under `apps/frontend/src`; month labels route through app helpers including `formatMonthYearWithAppSettings(date, appDateFormat, locale?)` and `formatMonthLabelWithLocale(date, locale?, width?)` in [[apps/frontend/src/components/shared/dateUtils.ts]]
- **Final readability + enforcement pass**: Dense month x-axes in [[apps/frontend/src/features/dashboard/MonthlyTrendsChart.tsx]] and [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]] enforce `interval="preserveStartEnd"` + `minTickGap={20}`; tooltip numeric fallback locale is sourced from `getCurrencyFormatDefaults().locale` in [[apps/frontend/src/utils/currency.ts]] via `apps/frontend/src/components/charts/` (chart.tsx removed in ADR-018 visx/d3 migration)
- **Grep verification snapshot**: no `toLocaleDateString(` or `toLocaleString(` in `apps/frontend/src`; no `form.currency || 'EUR'`; no persisted `defaultBankAccount` (removed — was unused)
- **Locale/language undefined-name sweep**: post-patch type/grep validation shows no `Cannot find name 'locale'` or `Cannot find name 'language'`; frontend build passes after watchlist formatter scoping fix in [[apps/frontend/src/features/portfolio/WatchlistChartDialog.tsx]]

Code links: [[apps/frontend/src/features/settings/DashboardSettingsDialog.tsx]], [[apps/frontend/src/components/notifications/UpdateNotification.tsx]], [[apps/frontend/src/contexts/AppSettingsContext.tsx]], [[apps/frontend/src/contexts/SettingsContext.tsx]], [[apps/frontend/src/components/shared/DatePicker.tsx]], [[apps/frontend/src/components/shared/dateUtils.ts]], [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/pages/RecipientsPage.tsx]], [[apps/frontend/src/features/statistics/RecipientInsightsTab.tsx]], [[apps/frontend/src/pages/PlannedPaymentsPage.tsx]], [[apps/frontend/src/features/planned/PlannedPaymentForm.tsx]], [[apps/frontend/src/hooks/usePlannedPayments.ts]], [[apps/frontend/src/features/planned/RecurringDetectionPanel.tsx]], [[apps/frontend/src/pages/OwesPage.tsx]], [[apps/frontend/src/pages/DashboardPage.tsx]], [[apps/frontend/src/features/dashboard/BankBalancesWidget.tsx]], [[apps/frontend/src/features/dashboard/CashFlowForecastChart.tsx]], [[apps/frontend/src/features/dashboard/MonthlyTrendsChart.tsx]], [[apps/frontend/src/pages/StatisticsPage.tsx]], [[apps/frontend/src/pages/TaxOverviewPage.tsx]], [[apps/frontend/src/features/tax/SuggestedDeductionsCard.tsx]], [[apps/frontend/src/features/portfolio/PortfolioTaxAdjustmentsDialog.tsx]], [[apps/frontend/src/features/portfolio/AddInvestmentDialog.tsx]], [[apps/frontend/src/features/portfolio/InvestmentDetailDialog.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/admin/ExchangeRatesPage.tsx]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/research/MarketLookupPage.tsx]], [[apps/frontend/src/features/portfolio/WatchlistChartDialog.tsx]], [[apps/frontend/src/pages/research/WatchlistPage.tsx]], [[apps/frontend/src/features/portfolio/AddInvestmentFromMarketDialog.tsx]], `apps/frontend/src/components/charts/` (chart.tsx removed in ADR-018 visx/d3 migration)

---

## NotFound Page

Simple 404 page displayed when no route matches.

### Features

- Centered layout with the Vision mark, display-face title, heading, and description
- "Back to Dashboard" link navigates to `/`
- Quiet secondary links navigate to Transactions and Import
- Logs the attempted route via `logger.warn` on mount
- Uses `useLocation` internally to access the unmatched path

**Code**: [[apps/frontend/src/pages/NotFound.tsx]]

---

## Premium UI Consistency Sweep (April 2026) + Liquid Glass v2 (June 2026)

Cross-page premium polish follows shared UI primitives and utility classes for consistent hierarchy, interaction ergonomics, and surface depth.

> [!info] June 2026 update — Liquid Glass v2 (ADR-070)
> The canonical card surface recipe changed. `surface-elevated premium-frame micro-lift` is superseded by `glass-regular premium-frame micro-lift` for KPI/chart cards and `glass-elevated` for hero cards. Tables stay opaque. See [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070]] and [[docs/reference/code-patterns#surface-shell-pattern-phase-9|Surface Shell Pattern]] for the updated rules.

### What was standardized (April 2026)

- **Page headers**: Top-level page title rows are standardized via `PageHeader` across budgeting and portfolio pages, including key detail subviews where appropriate.
- **Empty/error states**: Shared `EmptyState` and `PageError` are used in place of bespoke ad-hoc empty/error blocks on high-traffic pages. `EmptyState` upgraded in June 2026 (glass icon tile, display-serif title).
- **Touch ergonomics**: Icon-only actions now use `icon-touch-target` (`2.5rem` hit area) across table rows, dialogs, and detail action bars.
- **Surface recipes**: Ad-hoc elevated card class chains replaced with sanctioned recipes. As of June 2026 the canonical recipe is `glass-regular` (not `surface-elevated`) for KPI/chart cards.
- **Responsive forms**: Remaining narrow fixed two-column filter grids were upgraded to `grid-cols-1 sm:grid-cols-2` in Planned Payments link flow and related import/filter touchpoints.
- **Toast consistency**: App shell mounts Sonner as the active toaster; watchlist flows were migrated to Sonner toast API. Toasts use `glass-thick` material as of June 2026.
- **Toast cleanup completion**: Legacy Radix toast bridge/hook wrappers were removed; Sonner is now the only toast stack in frontend code.

### Coverage highlights

- **Budgeting pages**: Transactions, Recipients, Categories, Import, Planned Payments, Owes (including recipient detail actions), Tax Overview, Recipient Insights.
- **Portfolio pages**: Overview, Stocks, Crypto, Real Estate, Savings, Performance, Net Worth, Exchange Rates, Watchlist, Market Lookup, Portfolio Tax.
- **Dialogs/components**: SplitTransactionDialog, MergeRecipientsDialog, InvestmentDetailDialog, RecurringDetectionPanel, OnboardingWizard close action.

### Core code links

[[apps/frontend/src/components/shared/PageHeader.tsx]], [[apps/frontend/src/components/shared/EmptyState.tsx]], [[apps/frontend/src/components/shared/PageError.tsx]], [[apps/frontend/src/index.css]], [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/pages/DashboardPage.tsx]], [[apps/frontend/src/components/shared/StatCard.tsx]], [[apps/frontend/src/features/dashboard/CategoryPieChart.tsx]], [[apps/frontend/src/features/dashboard/MonthlyTrendsChart.tsx]], [[apps/frontend/src/features/dashboard/CashFlowForecastChart.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/pages/RecipientsPage.tsx]], [[apps/frontend/src/pages/CategoriesPage.tsx]], [[apps/frontend/src/pages/ImportPage.tsx]], [[apps/frontend/src/pages/PlannedPaymentsPage.tsx]], [[apps/frontend/src/pages/OwesPage.tsx]], [[apps/frontend/src/pages/TaxOverviewPage.tsx]], [[apps/frontend/src/features/statistics/RecipientInsightsTab.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]], [[apps/frontend/src/pages/admin/ExchangeRatesPage.tsx]], [[apps/frontend/src/pages/research/WatchlistPage.tsx]], [[apps/frontend/src/pages/research/MarketLookupPage.tsx]], [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx]], [[apps/frontend/src/features/portfolio/AddToWatchlistDialog.tsx]], [[apps/frontend/src/features/portfolio/WatchlistChartDialog.tsx]], [[apps/frontend/src/features/portfolio/InvestmentDetailDialog.tsx]], [[apps/frontend/src/features/recipients/MergeRecipientsDialog.tsx]], [[apps/frontend/src/features/splits/SplitTransactionDialog.tsx]], [[apps/frontend/src/features/planned/RecurringDetectionPanel.tsx]], [[apps/frontend/src/features/onboarding/OnboardingWizard.tsx]], [[apps/frontend/src/App.tsx]], [[apps/frontend/src/components/ui/sonner.tsx]], [[apps/frontend/package.json]]

---

## Recipient Insights Tab

Recipient spending analytics embedded in the Statistics page.

### Features

- Fetches `apiClient.getRecipientInsights()` for recipient-level analytics
- Applies exclusion filters from settings
- 3 KPI cards: top recipient, top-10 total spend, average transaction
- Horizontal bar chart of top 10 recipients by spend
- Month-over-month change alerts (increases in red, decreases in green)
- [[docs/components/shared-components|VirtualDataTable]] with paginated recipient details (rank, name, total spend, count, average, first/last seen)
- Accessible from the Recipients tab on the Statistics page

**Code**: [[apps/frontend/src/features/statistics/RecipientInsightsTab.tsx]]

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

The in-app help sheet (`?`) lists all active shortcuts. The table below mirrors what `ShortcutsOverlay` shows at runtime.

### General

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + K` | Open command palette |
| `Ctrl/Cmd + ,` | Open Settings |
| `Ctrl/Cmd + B` | Toggle sidebar |
| `[` / `]` | Cycle backward / forward through the three workspace sections (Budgeting → Portfolio → Research); wraps around; inert while typing or with modifier keys held |
| `Ctrl/Cmd + Z` | Undo last delete |
| `↑` / `↓` | Navigate table rows |
| `↵` | Open selected row |
| `Space` | Quick-look selected row |
| `?` | Show keyboard shortcuts help |
| `Esc` | Close dialog |

### Go-to sequences (`g`, then destination key)

| Shortcut | Destination |
|----------|-------------|
| `g d` | Dashboard (`/`) |
| `g t` | Transactions (`/transactions`) |
| `g s` | Statistics (`/statistics`) |
| `g c` | Categories (`/categories`) |
| `g r` | Recipients (`/recipients`) |
| `g i` | Import (`/import`) |
| `g p` | Portfolio (`/portfolio`) |
| `g n` | Net Worth (`/portfolio/net-worth`) |
| `g m` | Markets Overview (`/research/markets`) |
| `g a` | AI Chat (`/ai-chat`) |

### Command palette ticker lookup

Typing a bare ticker symbol (`AAPL`, `BRK-B`, `ASML.AS`, `BTC-USD`) or a `$`-cashtag (`$AAPL`) into the command palette triggers a debounced (250 ms) price-only quote via `GET /api/market/quote?...&detail=basic`. When a live quote returns, a **Market** group appears at the top of the palette showing the symbol, company name, current price, and percent change (green/red). Pressing **Enter** navigates to Market Lookup (`/research/market?symbol=<symbol>`). The card is hidden when no quote returns, so ordinary words that happen to match the ticker shape produce no false positives.

---

## AI Chat (`/ai-chat`)

Natural-language chat against the user's financial data — purely local (Ollama, no data egress).

### Features
- Conversation persistence via URL (`?c=<id>`) — share / resume by URL
- Module-level streaming store (ADR-048) keeps streams alive across navigation and component unmount
- Sidebar live indicator for active streams
- Tool-calling against repositories (transactions, categories, recipients, planned)
- Toggle to opt-out of tool calls per turn

**Code**: [[apps/frontend/src/pages/AIChatPage.tsx]], [[apps/frontend/src/features/ai-chat/]], [[apps/frontend/src/lib/aiChatStreamStore.ts]]

When Ollama is unreachable, the actionable setup/retry banner is the sole status message; the page
header does not repeat the same failure. Loading and ready states remain visible in the header.

**Related**: [[docs/features/ai-chat|AI Chat Feature]], [[docs/api/ai|AI Chat API]], [[docs/adr/024-local-llm-chat|ADR-024]], [[docs/adr/048-ai-chat-module-level-stream-store|ADR-048]]

---

## Import Review (`/import/review/:batchId`)

Post-upload review screen for ambiguous import rows.

### Features
- Per-row recipient override picker (driven by recipientClusterService suggestions)
- Per-row category override (ADR-046 — staged before commit, not inferred at parse-time)
- Cancel returns to ImportPage without committing
- Commit triggers `commitBatch()` → bulk insert → aggregation refresh

**Code**: [[apps/frontend/src/pages/ImportReviewPage.tsx]], [[apps/node-backend/src/services/importPipeline/commit.js]]

**Related**: [[docs/features/import|Import Feature]], [[docs/adr/046-import-review-category-assignment|ADR-046]]

---

## Admin pages (`/admin/*`)

Workspace-agnostic observability hub (gated by Settings → App → Developer toggle, ADR-034). All admin routes preserve last active workspace.

| Route | Page | Purpose |
|-------|------|---------|
| `/admin` | `AdminOverviewPage` | Summary tiles + links into the detail pages |
| `/admin/db` | `DbMaintenancePage` | Per-table row/size statistics + bulk/single VACUUM ANALYZE |
| `/admin/providers` | `ProviderHealthPage` | Rolling-window health metrics + on-demand probes for the 7 external data sources |
| `/admin/endpoints` | `EndpointLivenessPage` | Route manifest + p50/p95 request metrics from the in-memory rolling window |

**Code**: [[apps/frontend/src/pages/admin/]], [[apps/frontend/src/pages/DbMaintenancePage.tsx]]

**Related**: [[docs/features/admin-observability|Admin Observability]], [[docs/features/database-maintenance|Database Maintenance]], [[docs/features/provider-health|Provider Health]], [[docs/api/admin|Admin API]]

---

## Related Documentation

- [[docs/features/index]] - Feature documentation
- [[docs/api/index]] - API documentation
- [[docs/components/index]] - UI Components
- `docs/flow-visualizer.html` — interactive package + flow map (open in browser)
