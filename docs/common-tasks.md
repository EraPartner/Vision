---
title: Common Tasks Quick Reference
type: map-of-content
status: active
date: 2026-03-31
tags: [moc, tasks, quick-reference, navigation, how-to]
description: Task-oriented navigation — find the right docs for what you want to do
aliases: [common tasks, quick reference, i want to, task navigation, cheat sheet]
---

# Common Tasks Quick Reference

> [!abstract] Purpose
> Find the right documentation for your task. Organized by what you want to accomplish, not by document structure.

## Backend Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Add a new API endpoint | [[docs/guides/how-to-add-api-endpoint\|How to Add an API Endpoint]] | [[docs/reference/code-patterns\|Code Patterns]], [[docs/api/index\|API Index]] |
| Add a new database table | [[docs/adr/002-database-schema\|Database Schema ADR]] | [[docs/guides/migrations\|Migration Guide]], [[docs/reference/database-triggers\|Triggers]] |
| Add a new service | [[docs/reference/code-patterns\|Code Patterns]] | [[docs/architecture/backend-architecture\|Backend Architecture]] |
| Add a new bank adapter | [[docs/integrations/bank-adapters\|Bank Adapters]] | [[docs/features/import\|Import Feature]] |
| Add a new price provider | [[docs/integrations/price-providers\|Price Providers]] | [[docs/features/portfolio\|Portfolio]] |
| Create a database migration | [[docs/guides/migrations\|Migration Guide]] | [[docs/reference/migration-dependencies\|Migration Dependencies]] |
| Debug a database issue | [[docs/troubleshooting\|Troubleshooting]] | [[docs/reference/database-triggers\|Triggers]] |
| Configure environment variables | [[docs/reference/environment-variables\|Environment Variables]] | [[docs/guides/backend-configuration\|Backend Configuration]] |
| Set up the project locally | [[docs/guides/setup\|Setup Guide]] | [[docs/reference/scripts\|Scripts Reference]] |
| Deploy to production | [[docs/guides/deployment\|Deployment Guide]] | [[docs/reference/environment-variables\|Environment Variables]] |

## Frontend Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Add a new page | [[docs/guides/how-to-add-new-page\|How to Add a New Page]] | [[docs/reference/frontend-routes\|Frontend Routes]] |
| Add a new component | [[docs/guides/how-to-add-react-component\|How to Add a React Component]] | [[docs/reference/code-patterns\|Code Patterns]] |
| Add a new hook | [[docs/reference/code-patterns\|Code Patterns]] | [[docs/components/hooks\|Hooks]] |
| Add translations | [[docs/i18n/translations\|Translations]] | [[docs/guides/how-to-add-new-page\|How to Add a New Page]] |
| Debug a cache issue | [[docs/reference/react-query-keys\|React Query Keys]] | [[docs/performance/caching-strategies\|Caching Strategies]] |
| Add a chart | [[docs/performance/chart-downsampling\|Chart Downsampling]] | [[docs/components/dashboard\|Dashboard Components]] |
| Style a component | [[docs/components/ui-components\|UI Components]] | [[AGENTS.md]] (Tailwind guidelines) |

## API Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Test an API endpoint | [[docs/api/index\|API Index]] (curl examples in each doc) | [[docs/reference/error-codes\|Error Codes]] |
| Understand error responses | [[docs/reference/error-codes\|Error Codes]] | [[docs/reference/code-patterns\|Code Patterns]] |
| Check rate limits | [[docs/reference/error-codes\|Error Codes]] | [[docs/security/rate-limiting\|Rate Limiting]] |
| Understand API authentication | [[docs/api/index\|API Index]] | [[docs/security/index\|Security]] |

## Portfolio Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Add a new investment | [[docs/features/portfolio\|Portfolio Feature]] | [[docs/api/investments\|Investments API]] |
| Check portfolio performance | [[docs/features/portfolio\|Portfolio Performance]] | [[docs/reference/react-query-keys\|React Query Keys]] |
| Understand inflation adjustment | [[docs/features/portfolio\|Portfolio]] | [[docs/api/info\|Info API]] |
| Update investment prices | [[docs/integrations/price-providers\|Price Providers]] | [[docs/api/investments\|Investments API]] |

## Transaction Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Import bank statements | [[docs/features/import\|Import Feature]] | [[docs/integrations/bank-adapters\|Bank Adapters]] |
| Split a transaction | [[docs/api/splits\|Splits API]] | [[docs/features/views\|Owes Page]] |
| Create a planned payment | [[docs/features/plannedTransactions\|Planned Transactions]] | [[docs/api/plannedTransactions\|Planned Transactions API]] |
| Detect recurring payments | [[docs/features/plannedTransactions\|Recurring Detection]] | [[docs/diagrams/recurring-detection-flow.puml\|Recurring Detection Flow]] |

## Debugging Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Fix a broken build | [[docs/troubleshooting\|Troubleshooting]] | [[docs/reference/scripts\|Scripts Reference]] |
| Fix a database connection | [[docs/troubleshooting\|Troubleshooting]] | [[docs/reference/environment-variables\|Environment Variables]] |
| Fix a migration failure | [[docs/guides/migrations\|Migration Guide]] | [[docs/troubleshooting\|Troubleshooting]] |
| Fix a rate limit error | [[docs/reference/error-codes\|Error Codes]] | [[docs/security/rate-limiting\|Rate Limiting]] |
| Fix a chart rendering issue | [[docs/performance/chart-downsampling\|Chart Downsampling]] | [[docs/troubleshooting\|Troubleshooting]] |
| Fix a React Query cache issue | [[docs/reference/react-query-keys\|React Query Keys]] | [[docs/performance/caching-strategies\|Caching Strategies]] |

## KB Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Update docs after a code change | [[docs/guides/kb-maintenance\|KB Maintenance Guide]] | [[docs/guides/ai-agent-kb-usage\|AI Agent KB Usage]] |
| Find docs by tag | [[docs/tag-taxonomy\|Tag Taxonomy]] | Use `obsidian_complex_search` |
| Find docs about a topic | [[docs/glossary\|Glossary]] | Use `obsidian_simple_search` |
| Create a new doc | Use template from relevant section | [[docs/guides/kb-maintenance\|KB Maintenance Guide]] |

## Quick Command Reference

```bash
# Development
bun run dev              # Start backend + frontend
bun run db:start         # Start PostgreSQL
bun run db:upgrade       # Run migrations

# Testing
bun run test             # Run all tests
bun run test:watch       # Watch mode

# Building
bun run build            # Production build
bun run build:dev        # Development build

# Docker
bun run docker:dev       # Start Docker dev environment
```

See [[docs/reference/scripts\|Scripts Reference]] for the complete list.

## Related

- [[docs/getting-started\|Getting Started MOC]] - Entry point for new developers
- [[docs/index\|Knowledge Base Home]] - Main entry point
- [[docs/reference/scripts\|Scripts Reference]] - All available commands
- [[docs/guides/kb-maintenance\|KB Maintenance Guide]] - How to keep docs in sync
