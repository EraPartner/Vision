---
title: Frontend Routes Reference
type: reference
status: active
date: 2026-04-25
tags: [reference, frontend, routing, pages, react-router, admin, workspace]
description: Complete reference of all frontend routes and their page components, including admin routes and workspace-aware navigation
aliases: [routes, pages, navigation, url paths, frontend routes, admin routes]
---

# Frontend Routes Reference

> [!abstract] Overview
> All frontend routes in the Vision application. Organized by workspace for easy navigation.

## Budgeting Workspace

| Route | Component | Layout | Description | Code |
|-------|-----------|--------|-------------|------|
| `/` | `DashboardPage` | AppLayout | Financial overview dashboard | [[apps/frontend/src/pages/DashboardPage.tsx\|DashboardPage.tsx]] |
| `/transactions` | `TransactionsPage` | AppLayout | Transaction CRUD with virtual table | [[apps/frontend/src/pages/TransactionsPage.tsx\|TransactionsPage.tsx]] |
| `/categories` | `CategoriesPage` | AppLayout | Category management | [[apps/frontend/src/pages/CategoriesPage.tsx\|CategoriesPage.tsx]] |
| `/recipients` | `RecipientsPage` | AppLayout | Recipient management | [[apps/frontend/src/pages/RecipientsPage.tsx\|RecipientsPage.tsx]] |
| `/recipients/:id/insights` | `RecipientInsightsPage` | AppLayout | Recipient spending analytics | [[apps/frontend/src/pages/RecipientInsightsPage.tsx\|RecipientInsightsPage.tsx]] |
| `/planned` | `PlannedPaymentsPage` | AppLayout | Planned and recurring payments | [[apps/frontend/src/pages/PlannedPaymentsPage.tsx\|PlannedPaymentsPage.tsx]] |
| `/statistics` | `StatisticsPage` | AppLayout | Analytics and reporting | [[apps/frontend/src/pages/StatisticsPage.tsx\|StatisticsPage.tsx]] |
| `/import` | `ImportPage` | AppLayout | CSV import | [[apps/frontend/src/pages/ImportPage.tsx\|ImportPage.tsx]] |
| `/owes` | `OwesPage` | AppLayout | Transaction splits and debt tracking | [[apps/frontend/src/pages/OwesPage.tsx\|OwesPage.tsx]] |
| `/tax` | `TaxOverviewPage` | AppLayout | Belgian tax overview | [[apps/frontend/src/pages/TaxOverviewPage.tsx\|TaxOverviewPage.tsx]] |

## Portfolio Workspace

| Route | Component | Layout | Description | Code |
|-------|-----------|--------|-------------|------|
| `/portfolio` | `PortfolioOverviewPage` | AppLayout | Portfolio overview | [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx\|PortfolioOverviewPage.tsx]] |
| `/portfolio/stocks` | `StocksPage` | AppLayout | Stocks and ETFs | [[apps/frontend/src/pages/portfolio/StocksPage.tsx\|StocksPage.tsx]] |
| `/portfolio/crypto` | `CryptoPage` | AppLayout | Cryptocurrency holdings | [[apps/frontend/src/pages/portfolio/CryptoPage.tsx\|CryptoPage.tsx]] |
| `/portfolio/metals` | `MetalsPage` | AppLayout | Precious metals | [[apps/frontend/src/pages/portfolio/MetalsPage.tsx\|MetalsPage.tsx]] |
| `/portfolio/real-estate` | `RealEstatePage` | AppLayout | Real estate holdings | [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx\|RealEstatePage.tsx]] |
| `/portfolio/savings` | `SavingsPage` | AppLayout | Savings accounts | [[apps/frontend/src/pages/portfolio/SavingsPage.tsx\|SavingsPage.tsx]] |
| `/portfolio/performance` | `PerformancePage` | AppLayout | Portfolio performance charts | [[apps/frontend/src/pages/portfolio/PerformancePage.tsx\|PerformancePage.tsx]] |
| `/portfolio/net-worth` | `NetWorthPage` | AppLayout | Net worth tracking | [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx\|NetWorthPage.tsx]] |
| `/portfolio/exchange-rates` | `ExchangeRatesPage` | AppLayout | Exchange rate management | [[apps/frontend/src/pages/portfolio/ExchangeRatesPage.tsx\|ExchangeRatesPage.tsx]] |
| `/portfolio/watchlist` | `WatchlistPage` | AppLayout | Investment watchlist | [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx\|WatchlistPage.tsx]] |
| `/portfolio/market` | `MarketLookupPage` | AppLayout | Market data lookup | [[apps/frontend/src/pages/MarketLookupPage.tsx\|MarketLookupPage.tsx]] |
| `/portfolio/tax` | `PortfolioTaxPage` | AppLayout | Portfolio tax calculations | [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx\|PortfolioTaxPage.tsx]] |

## Admin Routes

Admin routes are workspace-agnostic and preserve the active workspace when navigating between them.

| Route | Component | Layout | Description | Code |
|-------|-----------|--------|-------------|------|
| `/admin` | `AdminOverviewPage` | AppLayout | Admin overview with summary tiles | [[apps/frontend/src/pages/admin/AdminOverviewPage.tsx\|AdminOverviewPage.tsx]] |
| `/admin/db` | `DbMaintenancePage` | AppLayout | Database table stats and VACUUM operations | [[apps/frontend/src/pages/DbMaintenancePage.tsx\|DbMaintenancePage.tsx]] |
| `/admin/providers` | `ProviderHealthPage` | AppLayout | Data source health tracking (7 providers) | [[apps/frontend/src/pages/admin/ProviderHealthPage.tsx\|ProviderHealthPage.tsx]] |
| `/admin/endpoints` | `EndpointLivenessPage` | AppLayout | Route liveness matrix with rolling metrics | [[apps/frontend/src/pages/admin/EndpointLivenessPage.tsx\|EndpointLivenessPage.tsx]] |

## Global Routes

| Route | Component | Layout | Description | Code |
|-------|-----------|--------|-------------|------|
| `/ai-chat` | `AIChatPage` | AppLayout | Local AI chat for natural-language queries | [[apps/frontend/src/pages/AIChatPage.tsx\|AIChatPage.tsx]] |

> Settings is no longer a route — it is rendered as `DashboardSettingsDialog` opened from the layout. See [[apps/frontend/src/components/settings/DashboardSettingsDialog.tsx\|DashboardSettingsDialog.tsx]] and [[docs/features/settings|Settings Feature]].

## Special Routes

| Route | Component | Layout | Description | Code |
|-------|-----------|--------|-------------|------|
| `*` (404) | `NotFound` | None | 404 page for unmatched routes | [[apps/frontend/src/pages/NotFound.tsx\|NotFound.tsx]] |

## Route Configuration

Routes are defined in [[apps/frontend/src/App.tsx\|App.tsx]] using React Router v6:

```tsx
<Routes>
  {/* Budgeting workspace */}
  <Route path="/" element={<AppLayout><DashboardPage /></AppLayout>} />
  <Route path="/transactions" element={<AppLayout><TransactionsPage /></AppLayout>} />
  {/* ... more routes ... */}

  {/* Portfolio workspace */}
  <Route path="/portfolio" element={<AppLayout><PortfolioOverviewPage /></AppLayout>} />
  <Route path="/portfolio/stocks" element={<AppLayout><StocksPage /></AppLayout>} />
  {/* ... more routes ... */}

  {/* 404 */}
  <Route path="*" element={<NotFound />} />
</Routes>
```

## Workspace Switching

Workspace switching is handled by the [[apps/frontend/src/contexts/WorkspaceContext.tsx\|useWorkspace]] hook, which derives the workspace from the current route path:
- `/portfolio/*` → `"portfolio"` workspace
- `/admin/*` → preserves the last active workspace from `sessionStorage` (workspace-agnostic routes)
- Everything else → `"budgeting"` workspace

**Admin Route Isolation:** When navigating to `/admin/*` pages from portfolio context, the sidebar retains the portfolio workspace and does not snap to "budgeting". The workspace switcher tabs remain functional — clicking a workspace tab navigates to the workspace root (`/portfolio` or `/`).

## Related

- [[docs/features/views\|Views & Pages]] - Detailed page documentation
- [[docs/components/layout\|Layout Components]] - AppLayout and AppSidebar
- [[docs/architecture/frontend-architecture\|Frontend Architecture]] - Routes diagram
