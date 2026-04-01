---
title: Frontend Routes Reference
type: reference
status: active
date: 2026-03-31
tags: [reference, frontend, routing, pages, react-router]
description: Complete reference of all frontend routes and their page components
aliases: [routes, pages, navigation, url paths, frontend routes]
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
| `/portfolio/net-worth` | `NetWorthPage` | AppLayout | Net worth tracking | [[apps/frontend/src/pages/portfolio/NetWorthPage.tsx\|NetWorthPage.tsx]] |
| `/portfolio/exchange-rates` | `ExchangeRatesPage` | AppLayout | Exchange rate management | [[apps/frontend/src/pages/portfolio/ExchangeRatesPage.tsx\|ExchangeRatesPage.tsx]] |
| `/portfolio/watchlist` | `WatchlistPage` | AppLayout | Investment watchlist | [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx\|WatchlistPage.tsx]] |
| `/portfolio/market` | `MarketLookupPage` | AppLayout | Market data lookup | [[apps/frontend/src/pages/MarketLookupPage.tsx\|MarketLookupPage.tsx]] |
| `/portfolio/tax` | `PortfolioTaxPage` | AppLayout | Portfolio tax calculations | [[apps/frontend/src/pages/portfolio/PortfolioTaxPage.tsx\|PortfolioTaxPage.tsx]] |

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
- Everything else → `"budgeting"` workspace

## Related

- [[docs/features/views\|Views & Pages]] - Detailed page documentation
- [[docs/components/layout\|Layout Components]] - AppLayout and AppSidebar
- [[docs/architecture/frontend-architecture\|Frontend Architecture]] - Routes diagram
