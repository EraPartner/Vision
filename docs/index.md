---
title: Vision Project Knowledge Base
type: index
---

# Vision Knowledge Base

Welcome to the Vision project documentation. This knowledge base contains architectural decisions, API documentation, guides, and all project knowledge designed for both humans and AI agents.

## Quick Links

- [[docs/adr/index|Architecture Decisions]] - Major project decisions and their rationale
- [[docs/guides/index|Guides]] - Setup, deployment, and contributing guides
- [[docs/api/index|API Overview]] - REST API endpoints and schemas

## Recent Updates

```dataview
TABLE title, date, type
FROM "docs"
WHERE date >= date(today) - dur(14 days)
SORT date DESC
LIMIT 10
```

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

## Knowledge Areas

| Area | Description |
|------|-------------|
| [[docs/adr/index|Architecture]] | ADRs - Major design decisions |
| [[docs/api/index|API]] | REST API endpoints and schemas |
| [[docs/guides/index|Guides]] | Setup, development, deployment guides |
| [[docs/features/index|Features]] | Feature documentation (Portfolio, Tax, etc.) |
| [[docs/integrations/index|Integrations]] | External services, bank adapters |
| [[docs/i18n/index|Localization]] | Internationalization and translations |
| [[docs/security/index|Security]] | Security policies and practices |
| [[docs/performance/index|Performance]] | Performance optimizations |

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

## Contributing

AI agents should:
1. **Read before writing** - Check existing docs before adding new content
2. **Use ADRs for decisions** - Document significant design choices in `docs/adr/`
3. **Update relevant docs** - Keep API, features, and guides docs in sync with code
4. **Use templates** - Start new documents from templates in each section
