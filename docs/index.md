---
title: Vision Project Knowledge Base
type: index
status: active
date: 2026-04-02
tags: [knowledge-base, index, project, overview]
description: Main entry point to the Vision project documentation - financial transaction management application
aliases: [KB, docs, documentation, knowledge base, home]
---

# Vision Knowledge Base

> [!abstract] About This KB
> Welcome to the Vision project documentation. This knowledge base contains architectural decisions, API documentation, guides, and all project knowledge designed for **humans**, **AI agents**, and **computer scientists**.
> 
> **Quick Open:** Press `Ctrl/Cmd+O` to quick-open any document
> **Search:** Use the search bar or `Cmd+Shift+F` for full-text search
> **Graph View:** Use `Cmd+G` to explore document relationships

## 🎯 Quick Navigation

```dataview
TABLE WITHOUT FILE
  choice(contains(file.tags, "guide"), "📖", "") + " " + choice(contains(file.tags, "api"), "📡", "") + " " + choice(contains(file.tags, "architecture"), "📐", "") + " " + choice(contains(file.tags, "feature"), "⚡", "") + " " + choice(contains(file.tags, "reference"), "📚", "") as "",
  title AS "Document",
  choice(date, dateformat(date, "yyyy-MM-dd"), "—") AS "Updated"
FROM "docs"
WHERE status = "active" AND type != "index"
SORT title ASC
LIMIT 20
```

## Quick Start

| If you're... | Start here |
|---|---|
| **New developer** | [[docs/getting-started|Getting Started MOC]] → [[docs/guides/setup|Setup Guide]] |
| **Looking for an API** | [[docs/api/index|API Overview]] or [[docs/api/transactions|Transactions API]] |
| **Making an architectural decision** | [[docs/adr/index|ADR Index]] → [[docs/adr/template|Template]] |
| **Understanding the architecture** | [[docs/architecture/index|Architecture Overview]] |
| **Working on a feature** | [[docs/features/index|Feature Docs]] |
| **An AI agent** | Read [[docs/adr/index|ADRs]] first, then check [[docs/api/index|API docs]] |
| **Computer scientist** | See [[#For Computer Scientists]] section below |

## Audience-Specific Paths

### 👨‍💻 For Developers

```dataview
TABLE WITHOUT FILE title AS "Document", description AS "Description"
FROM "docs/guides"
WHERE type = "guide"
SORT title ASC
LIMIT 5
```

**Start here:** [[docs/guides/setup|Setup Guide]] → [[docs/guides/contributing|Contributing Guide]]

### 🤖 For AI Agents

> [!tip] AI Agent Quick Reference
> 1. **Read before writing** - Check existing docs before adding new content
> 2. **Use ADRs for decisions** - Document significant design choices in `docs/adr/`
> 3. **Update relevant docs** - Keep API, features, and guides docs in sync with code
> 4. **Use templates** - Start new documents from templates in `docs/templates/`
> 5. **Use wiki-links** - Link to code with `[[apps/node-backend/src/routes/file.js]]` format
> 6. **Search first** - Use `obsidian_simple_search` to find existing docs

**Start here:** [[docs/guides/ai-agent-kb-usage|AI Agent KB Usage]] → [[docs/guides/kb-maintenance|KB Maintenance]]

### 🔬 For Computer Scientists

> [!abstract] Algorithms & Complexity
> This section documents the algorithmic foundations of Vision for developers interested in computational complexity, data structures, and optimization techniques.

| Document | Description | Complexity |
|----------|-------------|-------------|
| [[docs/reference/algorithms|Algorithms & Data Structures]] | LTTB, SHA-256 deduplication, recurring detection, Modified Dietz | O(n), O(1) |
| [[docs/reference/database-query-patterns|Database Query Patterns]] | PostgreSQL CTEs, window functions, materialized views | Index analysis |
| [[docs/reference/data-model|Data Model]] | Entity relationships and schema design | Schema patterns |
| [[docs/performance/chart-downsampling|Chart Downsampling]] | LTTB implementation for time-series | O(n) time, O(k) space |
| [[docs/adr/005-materialized-views|ADR-005: Materialized Views]] | Pre-computed aggregation strategy | Query vs view trade-offs |
| [[docs/adr/004-postgresql-table-inheritance|ADR-004: Table Inheritance]] | PostgreSQL inheritance for investments | Schema design patterns |
| [[docs/adr/006-three-layer-architecture|ADR-006: Three-Layer Architecture]] | Routes → Services → Repositories | Layer separation patterns |
| [[docs/adr/007-streaming-imports|ADR-007: Streaming Imports]] | SSE progress + parallel batch processing | Pipeline architecture |

## Knowledge Areas

| Area | Description |
|------|-------------|
| [[docs/adr/index|🏗️ Architecture Decisions]] | Major design decisions and rationale |
| [[docs/api/index|📡 API Documentation]] | REST API endpoints and schemas |
| [[docs/guides/index|📖 Guides]] | Setup, deployment, and contributing |
| [[docs/features/index|⚡ Features]] | Feature documentation (Portfolio, Tax, etc.) |
| [[docs/integrations/index|🔌 Integrations]] | External services, bank adapters |
| [[docs/i18n/index|🌍 Localization]] | Internationalization and translations |
| [[docs/security/index|🔒 Security]] | Security policies and practices |
| [[docs/performance/index|🚀 Performance]] | Performance optimizations |
| [[docs/components/index|🧩 Components]] | Frontend React components and hooks |
| [[docs/testing/index|🧪 Testing]] | Testing strategies and patterns |
| [[docs/architecture/index|📐 Architecture]] | System diagrams and architecture |
| [[docs/reference/index|📚 Reference]] | Code patterns, types, algorithms, env vars |
| [[docs/templates/index|📝 Templates]] | Documentation templates for new docs |

## 📊 PlantUML Diagrams

> [!info] All Diagrams
> Vision uses 23 PlantUML diagrams across backend, frontend, and system categories.

```dataview
TABLE WITHOUT FILE
  choice(contains(file.name, "backend"), "🖥️", "") + choice(contains(file.name, "frontend"), "🎨", "") + choice(contains(file.name, "import"), "📥", "") + choice(contains(file.name, "price"), "💹", "") + choice(contains(file.name, "currency"), "💱", "") + choice(contains(file.name, "system"), "🌐", "") as "",
  file.name AS "Diagram",
  choice(contains(file.name, "-flow") OR contains(file.name, "-sequence"), "Flow", "Architecture") AS "Type"
FROM "docs/diagrams"
WHERE file.name != "index.md"
SORT file.name ASC
LIMIT 20
```

**View all diagrams:** [[docs/diagrams/index|Diagrams Index]] | [[docs/architecture/index|Architecture Overview]]

| Resource | Description |
|----------|-------------|
| [[docs/glossary|📚 Glossary]] | Key terms, aliases, and disambiguation |
| [[docs/tag-taxonomy|🏷️ Tag Taxonomy]] | Controlled vocabulary for KB tags |
| [[docs/troubleshooting|🔧 Troubleshooting]] | Common issues and solutions |
| [[docs/getting-started|🗺️ Getting Started]] | Map of Content for navigation |
| [[docs/common-tasks|📋 Common Tasks]] | Task-oriented quick reference |
| [[docs/diagrams/index|📊 Diagrams Index]] | All PlantUML diagrams organized by category |
| [[docs/reference/data-model|🗃️ Data Model]] | Complete entity reference — core, portfolio, planning |
| [[docs/reference/environment-variables|🔑 Environment Variables]] | All env vars in one place |
| [[docs/reference/react-query-keys|🔄 React Query Keys]] | All frontend query keys |
| [[docs/reference/frontend-routes|🛣️ Frontend Routes]] | Complete route table |
| [[docs/reference/scripts|⚙️ Scripts Reference]] | All bun/npm commands |
| [[docs/reference/database-triggers|🗄️ Database Triggers]] | All PostgreSQL triggers |
| [[docs/reference/migration-dependencies|🔗 Migration Dependencies]] | Migration chain and groups |
| [[docs/reference/code-patterns|💻 Code Patterns]] | Standard code patterns for all layers |
| [[docs/reference/error-codes|❌ Error Codes]] | All API error responses and status codes |
| [[docs/reference/typescript-types|🔢 TypeScript Types]] | All frontend type definitions |
| [[docs/reference/algorithms|🧮 Algorithms]] | LTTB, deduplication, recurring detection, currency conversion |
| [[docs/reference/service-layer|🗂️ Service Layer]] | All 16 backend services reference |
| [[docs/reference/database-query-patterns|🗄️ Database Query Patterns]] | PostgreSQL patterns, indexes, optimization |
| [[docs/reference/agent-navigation-map|🗺️ Agent Navigation Map]] | File navigation by feature, layer, task |
| [[docs/reference/api-client-methods|🔌 API Client Methods]] | Complete frontend API client reference |
| [[docs/reference/schema-initialization|🗃️ Schema Initialization]] | Database startup schema initialization |
| [[docs/reference/api-endpoint-matrix|📊 API Endpoint Matrix]] | Complete matrix of all 108 API endpoints |

## Recent Updates

```dataview
TABLE WITHOUT FILE title AS "Document", date AS "Date", type AS "Type"
FROM "docs"
WHERE date AND date >= date(today) - dur(7 days)
SORT date DESC
LIMIT 10
```

### 2026-04-02 KB Enhancements

- **Documentation Templates**: Created `docs/templates/` with templates for API endpoints, features, components, guides, and hooks
- **Data Model Reference**: Created `docs/reference/data-model.md` with complete entity documentation
- **Diagrams Index**: Created `docs/diagrams/index.md` with organized diagram catalog
- **Fixed frontend-architecture.md**: Removed stray `@enduml` artifacts and fixed bare wiki-links
- **Enhanced main index**: Added audience-specific navigation paths for developers, AI agents, and computer scientists
- **Updated tag taxonomy**: Added `template` tag for documentation templates

### 2026-04-02 KB Consistency Updates

- **Fixed broken wiki-links**: Corrected bare wiki-links in `docs/architecture/index.md` to use proper path-based links
- **Fixed duplicate entries**: Removed duplicate entries in `docs/performance/index.md`
- **Updated dates**: Fixed 2025 → 2026 date typos in 4 files (layout, recipientBankAccounts, rate-limiting, materialized-views)
- **Added aliases**: Added missing aliases field to 14 files (API docs, component docs, guide docs)
- **Added orphan docs**: Added missing links to `docs/adr/001`, `004`, `005`, `006`, `007`, `how-to-add-new-page`, `api-endpoint-matrix`
- **Enhanced index**: Added "For Computer Scientists" section with algorithm complexity references

### 2026-03-31 Updates

- **Portfolio Performance Snapshots**: New service (`portfolioPerformanceSnapshotService.js`) computes and stores daily portfolio performance snapshots in `portfolio_performance_snapshots` table. Includes per-class invested/value breakdowns (stocks+ETFs, crypto, metals), inflation-adjusted values, and spike sanitization. Migrations: `0023_portfolio_performance_snapshots`, `0024_per_class_invested_columns`.
- **Chart Data Downsampling**: LTTB (Largest-Triangle-Three-Buckets) algorithm added to `apps/frontend/src/utils/downsample.ts` for efficient rendering of large time-series charts. Reduces thousands of data points to a configurable threshold while preserving visual shape.
- **Database Schema Updates**: Added `metals_investments` and `metals_transactions` inheritance tables, `portfolio_performance_snapshots`, and `belgian_inflation_rates` to database schema diagrams.
- **System Architecture**: Updated to reflect new services (BelgianInflationService, PortfolioPerformanceSnapshotService) and external data sources (Statbel, Eurostat HICP).
- **Kinesis History Sanitization**: Admin endpoint `POST /api/admin/investments/kinesis/sanitize-history` for correcting isolated price spikes in persisted Kinesis history.
- **KB Comprehensive Audit**: Full cross-reference audit of 146 frontend items, 16 backend services, 13 repositories, 14 route files, 25 migrations, and database schema. 146 frontend items audited (114 fully documented, 12 partially, 20 not), services 14/16 fully documented, repos 7/13 fully documented.

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