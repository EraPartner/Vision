---
title: Components Documentation Index
type: components-index
date: 2025-03-18
---

# Components Documentation

Documentation for Vision's frontend React components.

## Component Categories

| Category | Description | Documentation |
|----------|-------------|---------------|
| [[docs/components/ui-components|UI Components]] | Base UI components (Radix-based) | Button, Card, Dialog, Table, etc. |
| [[docs/components/dashboard|Dashboard]] | Dashboard widgets and charts | StatCard, Charts, BankBalances |
| [[docs/components/form-dialogs|Form Dialogs]] | Add/edit data dialogs | Transaction, Category, Recipient |
| [[docs/components/layout|Layout]] | App shell and navigation | AppLayout, AppSidebar |
| [[docs/components/portfolio|Portfolio]] | Investment components | AddInvestment, Watchlist |
| [[docs/components/hooks|Hooks]] | Custom React hooks | useTransactions, usePortfolio |

## All Components

```dataview
TABLE title, description
FROM "docs/components"
WHERE type = "component"
SORT title ASC
```

## Quick Reference

### Data Hooks

| Hook | Purpose |
|------|---------|
| `useTransactions()` | Transaction CRUD |
| `useCategories()` | Category management |
| `useRecipients()` | Recipient management |
| `usePortfolio()` | Investment portfolio |
| `usePlannedPayments()` | Scheduled payments |
| `useStatistics()` | Analytics data |
| `useSplits()` | Debt tracking |
| `useWatchlist()` | Watchlist management |

### UI Hooks

| Hook | Purpose |
|------|---------|
| `useWidgetVisibility()` | Widget show/hide |
| `useFilteredDashboardStats()` | Dashboard data |
| `useConfirmDialog()` | Confirmation dialogs |

## Guidelines

- Document props, states, and usage patterns
- Include code examples
- Link to related components and APIs
