---
title: Components Documentation Index
type: components-index
status: active
date: 2026-04-23
updated: 2026-08-10
last_modified: 2026-08-10
tags:
  [
    components,
    index,
    frontend,
    react,
    design-system,
    phase-9,
    phase-13,
    phase-c,
    performance,
    refactor,
    phase-3,
    phase-4,
    export-dialog,
    admin,
    observability,
    dev-observability,
    devtools,
    phase-f,
    lazy-loading,
    memoization,
    useCallback,
    multi-select,
    export-filters,
    debounce,
    accessibility,
    aria-label,
  ]
description: Documentation for all frontend React components, hooks, and utilities with emerald + gold aesthetic and performance-optimized design tokens. Phase F adds 4 admin pages with observability dashboards. Phase 13 adds CategoryMultiCombobox and BankAccountMultiCombobox for multi-select export filtering.
aliases: [components, UI, frontend components, chart components, visx charts]
---

# Components Documentation

Page-level content uses `components/shared/PageShell.tsx` for standard spacing, with Dashboard as the sole airy-rhythm exception.

> [!abstract] Overview
> Documentation for Vision's frontend React components, custom hooks, and utility modules. Organized by category for easy navigation.

**Latest Updates (2026-04-25):**

- **Statistics Page**: Lazy-loaded chart components (8 total, deferred per tab) with `React.lazy()` + `Suspense`
- **Statistics Components**: All 6 chart components + SavedChartsSection wrapped with `React.memo()` to prevent re-renders
- **Settings Dialog**: All 6 tab components memoized; stable callbacks via `useCallback` + functional updater pattern
- See [[docs/features/statistics|Statistics Feature]] and [[docs/components/statistics|Statistics Components]] for details.

## Component Categories

| Category                                                       | Description                                                               | Documentation                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [[docs/components/ui-components\|UI Components]]               | Base UI components (Radix-based) with performance-optimized design tokens | Button, Card, Dialog, Table, etc.                                       |
| [[docs/components/charts\|Chart Primitives]]                   | visx + d3 charts with design-token styling                                | AreaChart, BarChart, PieChart, LineChart, Sparkline                     |
| [[docs/components/dashboard\|Dashboard]]                       | Dashboard widgets and stat cards                                          | StatCard, MonthlyTrends, CategoryPie, BankBalances                      |
| [[docs/components/statistics\|Statistics]]                     | Analytics page sub-components                                             | ChartCard, MonthlyRhythm, CategoryPieChart, CategoryPivotTable          |
| [[docs/components/form-dialogs\|Form Dialogs]]                 | Add/edit data dialogs with optimized glass surfaces                       | Transaction, Category, Recipient, Investment, Settings                  |
| [[docs/components/dashboard-settings-dialog\|Settings Dialog]] | Multi-tab settings with thin orchestrator pattern (Phase 3)               | General, Dashboard, App, Backup, Appearance tabs                        |
| [[docs/components/export-dialog\|Export Dialog]]               | PDF report export configuration (Phase 4)                                 | Report type, period, sections, currency selection                       |
| [[docs/components/layout\|Layout]]                             | App shell and navigation (M1-optimized)                                   | AppLayout, AppSidebar                                                   |
| [[docs/components/admin\|Admin Pages]]                         | System observability dashboards (Phase F)                                 | AdminOverview, ProviderHealth, EndpointLiveness, DbMaintenance          |
| [[docs/components/portfolio\|Portfolio]]                       | Investment components                                                     | AddInvestment, Watchlist, PerformanceChart                              |
| [[docs/components/hooks\|Hooks]]                               | Custom React hooks                                                        | useTransactions, usePortfolio, useChartCurrencyFormatter                |
| [[docs/components/shared-components\|Shared Components]]       | Cross-cutting utilities                                                   | VirtualDataTable, PageHeader, EmptyState, ErrorBoundary                 |
| [[docs/components/devtools\|Devtools]]                         | Dev-only observability UI                                                 | ApiInspector, RequestList, RequestDetail, MetricsPanel, InspectorToggle |

## State Management

- [[docs/components/state-management\|State Management Deep Dive]] — React Query + Context architecture, patterns, and optimization

## All Components

```dataview
TABLE WITHOUT FILE title AS "Component", description AS "Description", date AS "Updated"
FROM "docs/components"
WHERE type = "component"
SORT title ASC
```

## Quick Reference

### Data Hooks

| Hook                   | Purpose              | Documentation                    |
| ---------------------- | -------------------- | -------------------------------- |
| `useTransactions()`    | Transaction CRUD     | [[docs/components/hooks\|Hooks]] |
| `useCategories()`      | Category management  | [[docs/components/hooks\|Hooks]] |
| `useRecipients()`      | Recipient management | [[docs/components/hooks\|Hooks]] |
| `usePortfolio()`       | Investment portfolio | [[docs/components/hooks\|Hooks]] |
| `usePlannedPayments()` | Scheduled payments   | [[docs/components/hooks\|Hooks]] |
| `useStatistics()`      | Analytics data       | [[docs/components/hooks\|Hooks]] |
| `useSplits()`          | Debt tracking        | [[docs/components/hooks\|Hooks]] |

### UI Hooks

| Hook                          | Purpose                              | Documentation                    |
| ----------------------------- | ------------------------------------ | -------------------------------- |
| `useWidgetVisibility()`       | Widget show/hide                     | [[docs/components/hooks\|Hooks]] |
| `useFilteredDashboardStats()` | Dashboard data                       | [[docs/components/hooks\|Hooks]] |
| `useConfirmDialog()`          | Confirmation dialogs                 | [[docs/components/hooks\|Hooks]] |
| `useTabParam()`               | Page-level Tabs ↔ `?tab=` URL param  | [[docs/components/hooks\|Hooks]] |
| `useTaxYearParam()`           | Viewed tax year ↔ `?year=` URL param | [[docs/components/hooks\|Hooks]] |

### Shared Form Inputs

- `DatePicker` - Popover date input used in dialog and inline-edit forms (strict app-format typing, month/year jumps, clear, and portal container)
- `RecipientCombobox` - Searchable recipient selector
- `CategoryCombobox` - Searchable single-select category picker
- `CategoryMultiCombobox` - Multi-select category picker (Phase 13, export filters)
- `BankAccountMultiCombobox` - Multi-select bank account picker (Phase 13, export filters)
- `SymbolSearchBox` - Canonical tall-glass search input + floating dropdown chrome for all Research symbol pickers
- `SymbolSearchResultItem` - Canonical result row (ticker, name, type badge, exchange) used by all Research symbol pickers and `AddToWatchlistDialog`

## Guidelines

> [!tip] Documentation Standards
>
> - Document props, states, and usage patterns
> - Include code examples
> - Link to related components and APIs
> - Use `[[code links]]` to reference source files

## Related Documentation

- [[docs/features/views\|Views & Pages]] - How components are used in pages
- [[docs/architecture/frontend-architecture\|Frontend Architecture]] - Component structure diagrams
- [[docs/api/index\|API Documentation]] - Backend endpoints consumed by components
