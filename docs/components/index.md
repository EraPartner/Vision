---
title: Components Documentation Index
type: components-index
status: active
date: 2026-04-02
tags: [components, index, frontend, react]
description: Documentation for all frontend React components, hooks, and utilities
aliases: [components, UI, frontend components]
---

# Components Documentation

> [!abstract] Overview
> Documentation for Vision's frontend React components, custom hooks, and utility modules. Organized by category for easy navigation.

## Component Categories

| Category | Description | Documentation |
|----------|-------------|---------------|
| [[docs/components/ui-components\|UI Components]] | Base UI components (Radix-based) | Button, Card, Dialog, Table, etc. |
| [[docs/components/dashboard\|Dashboard]] | Dashboard widgets and charts | StatCard, Charts, BankBalances |
| [[docs/components/form-dialogs\|Form Dialogs]] | Add/edit data dialogs | Transaction, Category, Recipient |
| [[docs/components/layout\|Layout]] | App shell and navigation | AppLayout, AppSidebar |
| [[docs/components/portfolio\|Portfolio]] | Investment components | AddInvestment, Watchlist |
| [[docs/components/hooks\|Hooks]] | Custom React hooks | useTransactions, usePortfolio |
| [[docs/components/shared-components\|Shared Components]] | Cross-cutting utilities | VirtualDataTable, dateUtils, ErrorBoundary |

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

| Hook | Purpose | Documentation |
|------|---------|---------------|
| `useTransactions()` | Transaction CRUD | [[docs/components/hooks\|Hooks]] |
| `useCategories()` | Category management | [[docs/components/hooks\|Hooks]] |
| `useRecipients()` | Recipient management | [[docs/components/hooks\|Hooks]] |
| `usePortfolio()` | Investment portfolio | [[docs/components/hooks\|Hooks]] |
| `usePlannedPayments()` | Scheduled payments | [[docs/components/hooks\|Hooks]] |
| `useStatistics()` | Analytics data | [[docs/components/hooks\|Hooks]] |
| `useSplits()` | Debt tracking | [[docs/components/hooks\|Hooks]] |

### UI Hooks

| Hook | Purpose | Documentation |
|------|---------|---------------|
| `useWidgetVisibility()` | Widget show/hide | [[docs/components/hooks\|Hooks]] |
| `useFilteredDashboardStats()` | Dashboard data | [[docs/components/hooks\|Hooks]] |
| `useConfirmDialog()` | Confirmation dialogs | [[docs/components/hooks\|Hooks]] |

### Shared Form Inputs

- `DatePicker` - Popover calendar input used in dialog forms (supports clear + portal container)
- `RecipientCombobox` - Searchable recipient selector
- `CategoryCombobox` - Searchable category selector

## Guidelines

> [!tip] Documentation Standards
> - Document props, states, and usage patterns
> - Include code examples
> - Link to related components and APIs
> - Use `[[code links]]` to reference source files

## Related Documentation

- [[docs/features/views\|Views & Pages]] - How components are used in pages
- [[docs/architecture/frontend-architecture\|Frontend Architecture]] - Component structure diagrams
- [[docs/api/index\|API Documentation]] - Backend endpoints consumed by components
