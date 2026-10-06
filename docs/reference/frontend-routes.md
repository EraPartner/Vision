---
title: Frontend Routes Reference
type: reference
status: active
date: 2026-10-06
updated: 2026-10-06
tags: [reference, frontend, routing, pages, react-router, admin, sidebar-sections]
description: Complete reference of all frontend routes and their page components, including admin routes and the sidebar sections that offer them
aliases: [routes, pages, navigation, url paths, frontend routes, admin routes]
---

# Frontend Routes Reference

Lazy page paths, literal chunk loaders, and admin-gate flags have one source of truth in
`apps/frontend/src/lib/routePreload.ts`'s ordered `appRouteManifest`. `App.tsx` derives route
elements from it. The wildcard catch-all remains explicit in `App.tsx` and renders `NotFound` for
every path absent from the manifest.

## Shareable page state

Portfolio Net Worth and Performance, Portfolio Rebalance, Planned Payments, Categories, Recipients, and Research Compare keep meaningful page state in validated query parameters. These surfaces omit their own defaults where supported, preserve unrelated parameters, and use replace-writes for high-frequency controls. Research Compare's shared tab helper still writes the selected tab, including its default. Rebalance uses repeated `target` values so partially completed allocation drafts survive reload; its URL can disclose the plan id, draft name, target percentages, and optional cash cap, but not account, holding, or transaction records.

Settings remain a dialog rather than a page route, but its section is deep-linkable as `?settings=general|appearance|statistics|behavior|ai|backup|about`. Opening from the app adds one history entry so Back closes the dialog. Section switches replace that entry; closing a directly loaded deep link removes only `settings` and preserves other query parameters.

> [!abstract] Overview
> All frontend routes in the Vision application. Grouped by area; the sidebar shows them as sections ([[#Sidebar sections]]).

## Budgeting Pages (top and Money sections)

| Route                     | Component             | Layout    | Description                          | Code                                                                         |
| ------------------------- | --------------------- | --------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `/`                       | `DashboardPage`       | AppLayout | Home: month-to-date hero and lists   | [[apps/frontend/src/pages/DashboardPage.tsx\|DashboardPage.tsx]]             |
| `/transactions`           | `TransactionsPage`    | AppLayout | Transactions list, filters, inspector | [[apps/frontend/src/pages/TransactionsPage.tsx\|TransactionsPage.tsx]]       |
| `/categories`             | `CategoriesPage`      | AppLayout | Category management                  | [[apps/frontend/src/pages/CategoriesPage.tsx\|CategoriesPage.tsx]]           |
| `/accounts`               | `AccountsPage`        | AppLayout | Account management                   | [[apps/frontend/src/pages/AccountsPage.tsx\|AccountsPage.tsx]]               |
| `/accounts/:id`           | `AccountDetailPage`   | AppLayout | Account ledger and reconciliation    | [[apps/frontend/src/pages/AccountDetailPage.tsx\|AccountDetailPage.tsx]]     |
| `/recipients`             | `RecipientsPage`      | AppLayout | Recipient management                 | [[apps/frontend/src/pages/RecipientsPage.tsx\|RecipientsPage.tsx]]           |
| `/planned`                | `PlannedPaymentsPage` | AppLayout | Planned and recurring payments       | [[apps/frontend/src/pages/PlannedPaymentsPage.tsx\|PlannedPaymentsPage.tsx]] |
| `/statistics`             | `StatisticsPage`      | AppLayout | Analytics and reporting              | [[apps/frontend/src/pages/StatisticsPage.tsx\|StatisticsPage.tsx]]           |
| `/import`                 | `ImportPage`          | AppLayout | CSV import                           | [[apps/frontend/src/pages/ImportPage.tsx\|ImportPage.tsx]]                   |
| `/import/:batchId/review` | `ImportReviewPage`    | AppLayout | Review a budgeting import batch      | [[apps/frontend/src/pages/ImportReviewPage.tsx\|ImportReviewPage.tsx]]       |
| `/owes`                   | `OwesPage`            | AppLayout | Transaction splits and debt tracking | [[apps/frontend/src/pages/OwesPage.tsx\|OwesPage.tsx]]                       |
| `/tax`                    | `TaxOverviewPage`     | AppLayout | Belgian tax overview                 | [[apps/frontend/src/pages/TaxOverviewPage.tsx\|TaxOverviewPage.tsx]]         |

## Portfolio Pages (Wealth section)

| Route                               | Component                   | Layout    | Description                             | Code                                                                                               |
| ----------------------------------- | --------------------------- | --------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/portfolio`                        | `PortfolioOverviewPage`     | AppLayout | Portfolio overview                      | [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx\|PortfolioOverviewPage.tsx]]         |
| `/portfolio/stocks`                 | `StocksPage`                | AppLayout | Stocks and ETFs                         | [[apps/frontend/src/pages/portfolio/StocksPage.tsx\|StocksPage.tsx]]                               |
| `/portfolio/crypto`                 | `CryptoPage`                | AppLayout | Cryptocurrency holdings                 | [[apps/frontend/src/pages/portfolio/CryptoPage.tsx\|CryptoPage.tsx]]                               |
| `/portfolio/metals`                 | `MetalsPage`                | AppLayout | Precious metals                         | [[apps/frontend/src/pages/portfolio/MetalsPage.tsx\|MetalsPage.tsx]]                               |
| `/portfolio/real-estate`            | `RealEstatePage`            | AppLayout | Real estate holdings                    | [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx\|RealEstatePage.tsx]]                       |
| `/portfolio/savings`                | `SavingsPage`               | AppLayout | Savings accounts                        | [[apps/frontend/src/pages/portfolio/SavingsPage.tsx\|SavingsPage.tsx]]                             |
| `/portfolio/performance`            | `PerformancePage`           | AppLayout | Portfolio performance charts            | [[apps/frontend/src/pages/portfolio/PerformancePage.tsx\|PerformancePage.tsx]]                     |
| `/portfolio/net-worth`              | `NetWorthPage`              | AppLayout | Net worth tracking                      | [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx\|NetWorthPage.tsx]]                 |
| `/portfolio/import`                 | `PortfolioImportPage`       | AppLayout | Brokerage import                        | [[apps/frontend/src/pages/portfolio/PortfolioImportPage.tsx\|PortfolioImportPage.tsx]]             |
| `/portfolio/import/:batchId/review` | `PortfolioImportReviewPage` | AppLayout | Review a brokerage import batch         | [[apps/frontend/src/pages/portfolio/PortfolioImportReviewPage.tsx\|PortfolioImportReviewPage.tsx]] |
| `/portfolio/tax`                    | `PortfolioTaxPage`          | AppLayout | Portfolio tax calculations              | [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx\|PortfolioTaxPage.tsx]]               |
| `/portfolio/rebalance`              | `RebalancePage`             | AppLayout | Portfolio allocation and rebalance plan | [[apps/frontend/src/pages/portfolio/RebalancePage.tsx\|RebalancePage.tsx]]                         |

## Research Pages (Research section)

| Route                 | Component               | Layout    | Description                |
| --------------------- | ----------------------- | --------- | -------------------------- |
| `/research`           | `ResearchHomePage`      | AppLayout | Research overview          |
| `/research/markets`   | `MarketOverviewPage`    | AppLayout | Market overview            |
| `/research/market`    | `MarketLookupPage`      | AppLayout | Instrument lookup          |
| `/research/watchlist` | `WatchlistPage`         | AppLayout | Investment watchlist       |
| `/research/compare`   | `ResearchComparePage`   | AppLayout | Instrument comparison      |
| `/research/forecast`  | `PortfolioForecastPage` | AppLayout | Portfolio forecast         |
| `/research/charts`    | `ChartBuilderPage`      | AppLayout | Configurable market charts |

## Admin Routes

Admin routes appear in the sidebar's Admin section, shown only when admin mode is on.

| Route                   | Component              | Layout                   | Description                                | Code                                                                                 |
| ----------------------- | ---------------------- | ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `/admin`                | `AdminOverviewPage`    | AppLayout + RequireAdmin | Admin overview with summary tiles          | [[apps/frontend/src/pages/admin/AdminOverviewPage.tsx\|AdminOverviewPage.tsx]]       |
| `/admin/db`             | `DbMaintenancePage`    | AppLayout + RequireAdmin | Database table stats and VACUUM operations | [[apps/frontend/src/pages/DbMaintenancePage.tsx\|DbMaintenancePage.tsx]]             |
| `/admin/db/:table`      | `TableDataEditorPage`  | AppLayout + RequireAdmin | Inspect and edit one database table        | [[apps/frontend/src/pages/admin/TableDataEditorPage.tsx\|TableDataEditorPage.tsx]]   |
| `/admin/providers`      | `ProviderHealthPage`   | AppLayout + RequireAdmin | Data source health tracking                | [[apps/frontend/src/pages/admin/ProviderHealthPage.tsx\|ProviderHealthPage.tsx]]     |
| `/admin/endpoints`      | `EndpointLivenessPage` | AppLayout + RequireAdmin | Route liveness matrix with rolling metrics | [[apps/frontend/src/pages/admin/EndpointLivenessPage.tsx\|EndpointLivenessPage.tsx]] |
| `/admin/exchange-rates` | `ExchangeRatesPage`    | AppLayout + RequireAdmin | Exchange-rate management                   | [[apps/frontend/src/pages/admin/ExchangeRatesPage.tsx\|ExchangeRatesPage.tsx]]       |

## Global Routes

| Route       | Component               | Layout    | Description                                               | Code                                                                             |
| ----------- | ----------------------- | --------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `/analysis` | `AnalysisWorkspacePage` | AppLayout | Manual visual, SQL, spreadsheet, and saved-analysis tools | [[apps/frontend/src/pages/AnalysisWorkspacePage.tsx\|AnalysisWorkspacePage.tsx]] |
| `/ai-chat`  | `AIChatPage`            | AppLayout | Local AI chat for natural-language queries                | [[apps/frontend/src/pages/AIChatPage.tsx\|AIChatPage.tsx]]                       |

> Settings is no longer a route — it is rendered as `DashboardSettingsDialog` opened from the layout. See [[apps/frontend/src/features/settings/DashboardSettingsDialog.tsx\|DashboardSettingsDialog.tsx]] and [[docs/features/settings|Settings Feature]].

## Unsupported Former Routes

The legacy aliases `/portfolio/exchange-rates`, `/research/symbol/:symbol`, `/portfolio/market`,
and `/portfolio/watchlist` were retired on 2026-09-11. They now reach the wildcard and render
`NotFound`; use `/admin/exchange-rates`, `/research/market?symbol=<symbol>`, `/research/market`, and
`/research/watchlist` respectively. `/accounts?account=<id>` no longer forwards and instead opens
the accounts hub. See
[[docs/adr/136-same-release-http-import-and-navigation-contract|ADR-136]].

| Route | Result            |
| ----- | ----------------- |
| `*`   | Render `NotFound` |

## Route Configuration

Page routes are declared once in `appRouteManifest`. Each loader stays a literal dynamic import so
Vite can generate a separate lazy chunk. [[apps/frontend/src/App.tsx\|App.tsx]] maps those records
to React Router elements and applies `RequireAdmin` only when `admin` is true:

```tsx
export const appRouteManifest = [
  { path: "/", loader: () => import("@/pages/DashboardPage"), admin: false },
  {
    path: "/admin",
    loader: () => import("@/pages/admin/AdminOverviewPage"),
    admin: true,
  },
  // ...all other ordinary page routes...
];

const lazyAppRoutes = appRouteManifest.map(({ path, loader, admin }) => ({
  path,
  admin,
  Component: lazy(loader),
}));

{
  lazyAppRoutes.map(({ path, admin, Component }) => (
    <Route
      key={path}
      path={path}
      element={
        admin ? (
          <RequireAdmin>
            <Component />
          </RequireAdmin>
        ) : (
          <Component />
        )
      }
    />
  ));
}
```

## Sidebar sections

The three sidebar workspaces and their switcher were replaced by one labelled sidebar
([[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]]). `lib/navigation.ts` maps routes to sidebar sections: the top items (Home, Transactions, Accounts, Planned Payments), **Money**, **Wealth**, **Research** (hidden until the user shows it) and **Admin** (admin mode only). The route groups above are page groupings, not modes; no route derives or persists a workspace. A registry test (`lib/__tests__/navigation.test.ts`) asserts that every parameterless route in `appRouteManifest` has exactly one navigation entry and that admin routes appear only in the Admin section.

- Landing on a page inside a hidden section shows that section and persists the choice (`vision.sidebar.hiddenSections`).
- `G` then a key jumps to a page (Home is `G H`, previously `G D`); `[` and `]` cycle Home (`/`), Portfolio (`/portfolio`) and Research (`/research`).
- `data-tint` on the canvas is `wealth` under `/portfolio`, otherwise `money`.

## Related

- [[docs/features/views\|Views & Pages]] - Detailed page documentation
- [[docs/components/layout\|Layout Components]] - AppLayout and AppSidebar
- [[docs/adr/180-sidebar-sections-replace-workspaces\|ADR-180: Sidebar sections replace workspaces]]
- [[docs/architecture/frontend-architecture\|Frontend Architecture]] - Routes diagram
- [[docs/adr/136-same-release-http-import-and-navigation-contract\|ADR-136: Same-Release HTTP, Import, and Navigation Contract]]
