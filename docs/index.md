---
title: Vision Project Knowledge Base
type: index
status: active
date: 2026-03-31
tags: [knowledge-base, index, project, overview]
description: Main entry point to the Vision project documentation - financial transaction management application
aliases: [KB, docs, documentation, knowledge base, home]
---

# Vision Knowledge Base

> [!abstract] About This KB
> Welcome to the Vision project documentation. This knowledge base contains architectural decisions, API documentation, guides, and all project knowledge designed for both humans and AI agents. Use `Ctrl/Cmd+O` to quick-open any document.

## 🚀 Quick Start

| If you're... | Start here |
|---|---|
| **New developer** | [[docs/getting-started\|Getting Started MOC]] → [[docs/guides/setup\|Setup Guide]] |
| **Looking for an API** | [[docs/api/index\|API Overview]] or [[docs/api/transactions\|Transactions API]] |
| **Making an architectural decision** | [[docs/adr/index\|ADR Index]] → [[docs/adr/template\|Template]] |
| **Understanding the architecture** | [[docs/architecture/index\|Architecture Overview]] |
| **Working on a feature** | [[docs/features/index\|Feature Docs]] |
| **An AI agent** | Read [[docs/adr/index\|ADRs]] first, then check [[docs/api/index\|API docs]] |

> [!tip] AI Agent Quick Reference
> 1. **Read before writing** - Check existing docs before adding new content
> 2. **Use ADRs for decisions** - Document significant design choices in `docs/adr/`
> 3. **Update relevant docs** - Keep API, features, and guides docs in sync with code
> 4. **Use templates** - Start new documents from templates in each section
> 5. **Use wiki-links** - Link to code with `[[apps/node-backend/src/routes/file.js]]` format

## Knowledge Areas

| Area | Description | Count |
|------|-------------|-------|
| 🏗️ [[docs/adr/index\|Architecture Decisions]] | Major design decisions and rationale | `= length(rows(file))` |
| 📡 [[docs/api/index\|API Documentation]] | REST API endpoints and schemas | `= length(rows(file))` |
| 📖 [[docs/guides/index\|Guides]] | Setup, deployment, and contributing | `= length(rows(file))` |
| ⚡ [[docs/features/index\|Features]] | Feature documentation (Portfolio, Tax, etc.) | `= length(rows(file))` |
| 🔌 [[docs/integrations/index\|Integrations]] | External services, bank adapters | `= length(rows(file))` |
| 🌍 [[docs/i18n/index\|Localization]] | Internationalization and translations | `= length(rows(file))` |
| 🔒 [[docs/security/index\|Security]] | Security policies and practices | `= length(rows(file))` |
| 🚀 [[docs/performance/index\|Performance]] | Performance optimizations | `= length(rows(file))` |
| 🧩 [[docs/components/index\|Components]] | Frontend React components and hooks | `= length(rows(file))` |
| 🧪 [[docs/testing/index\|Testing]] | Testing strategies and patterns | `= length(rows(file))` |
| 📐 [[docs/architecture/index\|Architecture]] | System diagrams and architecture | `= length(rows(file))` |

## Reference

| Resource | Description |
|----------|-------------|
| 📚 [[docs/glossary\|Glossary]] | Key terms, aliases, and disambiguation |
| 🏷️ [[docs/tag-taxonomy\|Tag Taxonomy]] | Controlled vocabulary for KB tags |
| 🔧 [[docs/troubleshooting\|Troubleshooting]] | Common issues and solutions |
| 🗺️ [[docs/getting-started\|Getting Started]] | Map of Content for navigation |
| 📋 [[docs/common-tasks\|Common Tasks]] | Task-oriented quick reference |
| 🔑 [[docs/reference/environment-variables\|Environment Variables]] | All env vars in one place |
| 🔄 [[docs/reference/react-query-keys\|React Query Keys]] | All frontend query keys |
| 🛣️ [[docs/reference/frontend-routes\|Frontend Routes]] | Complete route table |
| ⚙️ [[docs/reference/scripts\|Scripts Reference]] | All bun/npm commands |
| 🗄️ [[docs/reference/database-triggers\|Database Triggers]] | All PostgreSQL triggers |
| 🔗 [[docs/reference/migration-dependencies\|Migration Dependencies]] | Migration chain and groups |
| 💻 [[docs/reference/code-patterns\|Code Patterns]] | Standard code patterns for all layers |
| ❌ [[docs/reference/error-codes\|Error Codes]] | All API error responses and status codes |

## Recent Updates

```dataview
TABLE WITHOUT FILE title AS "Document", date AS "Date", type AS "Type"
FROM "docs"
WHERE date AND date >= date(today) - dur(7 days)
SORT date DESC
LIMIT 10
```

### 2026-03-31 Updates

- **Portfolio Performance Snapshots**: New service (`portfolioPerformanceSnapshotService.js`) computes and stores daily portfolio performance snapshots in `portfolio_performance_snapshots` table. Includes per-class invested/value breakdowns (stocks+ETFs, crypto, metals), inflation-adjusted values, and spike sanitization. Migrations: `0023_portfolio_performance_snapshots`, `0024_per_class_invested_columns`.
- **Chart Data Downsampling**: LTTB (Largest-Triangle-Three-Buckets) algorithm added to `apps/frontend/src/utils/downsample.ts` for efficient rendering of large time-series charts. Reduces thousands of data points to a configurable threshold while preserving visual shape.
- **Database Schema Updates**: Added `metals_investments` and `metals_transactions` inheritance tables, `portfolio_performance_snapshots`, and `belgian_inflation_rates` to database schema diagrams.
- **System Architecture**: Updated to reflect new services (BelgianInflationService, PortfolioPerformanceSnapshotService) and external data sources (Statbel, Eurostat HICP).
- **Kinesis History Sanitization**: Admin endpoint `POST /api/admin/investments/kinesis/sanitize-history` for correcting isolated price spikes in persisted Kinesis history.
- **KB Comprehensive Audit**: Full cross-reference audit of 146 frontend items, 16 backend services, 13 repositories, 14 route files, 25 migrations, and database schema. 146 frontend items audited (114 fully documented, 12 partially, 20 not), services 14/16 fully documented, repos 7/13 fully documented.
- **KB Fixes Applied**: 
  - **API docs**: Added missing query params to GET /api/recipients (name, default_category_id, uncategorized, sort_by, sort_dir), corrected GET /api/watchlist response shape, added fetched_at to exchange-rates, added response shape for GET /api/investments/transactions, fixed imports.md rate limit section.
  - **ADR-002**: Added 5 missing tables (asset_price_history, portfolio_performance_snapshots, belgian_inflation_rates, transaction_splits, split_payments), added fx_rate_to_eur to portfolio_transactions columns, added metals to asset_class enum, added gift to portfolio_txn_type enum, removed dropped custom_raw_transactions.
  - **PUML diagrams**: Removed deprecated custom_raw_transactions, fixed recipients→categories relationship arrow, fixed belgian_inflation_rates monthly_rate type, added 6 price_provider history columns to investments_base, added raw_csv_line to manual_raw_transactions, updated IBANService methods to match actual API.
  - **Code links**: Added rawTransactionRepository.js, watchlistRepository.js, categoryRepository.js, recipientRepository.js, iban.js to relevant docs.
  - **Frontend docs**: Documented addTransactionForm.ts, WorkspaceContext.tsx (useWorkspace hook), created migration guide, created backend configuration guide.

### 2026-03-28 Updates

- **Portfolio Performance Charts**: Performance page now uses day-level snapshots with per-class breakdowns. Relative performance uses contribution-adjusted return chaining (Modified Dietz-style). Monthly heatmap shows investment returns only.
- **Cross-Currency Display**: All portfolio pages normalize amounts to `appSettings.defaultCurrency` using live exchange rates.
- **Belgian Inflation Integration**: Backend sources inflation from Statbel with Eurostat HICP fallback, persisted to `belgian_inflation_rates` table for deterministic portfolio calculations.
- **Historical Asset Quotes**: Provider prices persisted in `asset_price_history` with read-through caching (DB → provider → DB upsert).
- **Net Worth Improvements**: Daily snapshots, series toggle (Total/Investments/Liquid), zoom controls, locale-aware month labels, spike sanitization.

### 2026-03-23 Updates

- **Settings API defaults**: Documented `widget_visibility` as a defaulted setting key and updated Settings API docs to match current `GET/PUT/DELETE` behavior, including single-key and bulk upsert flows.
- **Splits API payloads**: Updated owed summary and recipient-detail response docs to include `total_paid`, `remaining`, `split_count`, `transaction_currency`, `bank_account`, and `amount_paid` fields returned by the backend.
- **Owes workflow improvements**: Documented per-recipient `settle-all`, owed CSV export, and double-click deep links into Transactions using `transaction_id` filter.

### 2026-03-22 Updates

- **Bug Fix - RecipientsPage**: Fixed UI state inconsistency when assigning categories in uncategorized view. Added `cancelEditingRef` mechanism to VirtualDataTable.
- **Bug Fix - Statistics**: Fixed category name formatting and duplicate categories in statistics charts. Added `normalizeCategoryName()` helper for consistent `GENERAL: DETAIL` format.
- **Bug Fix - Dashboard**: Fixed charts disappearing when toggling filters. Unfiltered data queries are now always enabled to support per-graph filter toggles.
- **Bug Fix - Planned Payments**: Fixed white box appearing over date picker in Link Transaction dialog. Replaced native date input with Popover + Calendar component.
- **Bug Fix - Watchlist**: Simplified display to show either price OR percentage, not both. Above target shows percentage, at/below target shows price.
- **Bug Fix - Transactions**: Fixed transaction table not updating after add/delete. Added `transactions-virtual` to React Query invalidation.
- **Bug Fix - Search**: Virtual table search now keeps input text after execution, updates on every keystroke (including loosening searches), clears safely without stale delayed terms, and now uses a 200ms debounce plus deferred row rendering for a more live typing experience during refresh.
- **Bug Fix - Edit Mode**: Fixed transaction table losing edit state during auto-refresh. Added `onEditingChange` callback to VirtualDataTable to track editing state.
- **Database - Investment Table Inheritance**: Implemented PostgreSQL table inheritance with separate tables for each investment type (stocks, ETFs, crypto, real estate, savings, bonds). Real estate-specific columns (municipality, cadastral income) now only exist in the real estate table.
- **New ADR**: [[docs/adr/003-bugfixes-ui-state-category-names|ADR-003]] - Documents all bug fixes and the database schema change.

## Project Overview

Vision is a comprehensive **financial transaction management application** supporting:

- **Transactions**: Income/expense tracking with categories and recipients
- **Planned Transactions**: Future scheduled and recurring payments
- **Portfolio**: Stocks, crypto, real estate, savings tracking
- **Tax**: Belgian tax profile and deduction tracking
- **Imports**: CSV bank statement imports with deduplication
- **Multi-workspace**: Support for multiple workspaces/users

### Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + Radix UI
- **Backend**: Node.js (Bun) + Express
- **Database**: PostgreSQL with Alembic migrations
- **Desktop**: Electron
- **Testing**: Vitest + React Testing Library

## Key Concepts

> [!info] Transaction Amounts
> - **Negative amounts**: Expenses (money leaving your account)
> - **Positive amounts**: Income (money entering your account)

> [!info] Categories
> Categories use `GENERAL:DETAIL` format:
> - `FOOD:GROCERIES`, `TRANSPORT:GAS`, `UTILITIES:ELECTRICITY`

> [!info] Bank Adapters
> Supported banks for import: Belfius, Revolut, KBC, SABB, Wise, Vision (internal format), Custom (configurable)
