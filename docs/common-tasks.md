---
title: Common Tasks Quick Reference
type: map-of-content
status: active
date: 2026-04-22
updated: 2026-05-08
tags: [moc, tasks, quick-reference, navigation, how-to, phase-2, openapi, deployment, cicd, updates, april-2026, testing, e2e-testing, mutation-testing, bulk-actions]
description: Task-oriented navigation — find the right docs for what you want to do; includes Phase 2 OpenAPI and type generation; April 2026 adds deployment and update tasks; May 2026 bulk transaction operations
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
| Protect admin endpoints with token auth | [[docs/reference/environment-variables\|Environment Variables]] (`ADMIN_AUTH_TOKEN`) | [[docs/api/admin\|Admin API]], [[docs/security/index\|Security]] |
| Set up the project locally | [[docs/guides/setup\|Setup Guide]] | [[docs/reference/scripts\|Scripts Reference]] |
| Package for macOS distribution | [[docs/guides/deployment#packaging-for-macos\|Packaging for macOS]] | [[docs/architecture/electron\|Electron Architecture]] |
| Deploy to production | [[docs/guides/deployment\|Deployment Guide]] | [[docs/reference/environment-variables\|Environment Variables]] |

## Frontend Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Add a new page | [[docs/guides/how-to-add-new-page\|How to Add a New Page]] | [[docs/reference/frontend-routes\|Frontend Routes]] |
| Add a new component | [[docs/guides/how-to-add-react-component\|How to Add a React Component]] | [[docs/reference/code-patterns\|Code Patterns]] |
| Add a new hook | [[docs/reference/code-patterns\|Code Patterns]] | [[docs/components/hooks\|Hooks]] |
| Call an API endpoint | [[docs/reference/frontend-api-client\|Frontend API Client]] | [[docs/api/index\|API Documentation]] |
| Use OpenAPI types | [[docs/adr/031-openapi-type-generation-frontend\|ADR-031: OpenAPI Types]] | [[docs/reference/frontend-api-client\|API Client Architecture]] |
| Regenerate API types | `bun run generate:types` | [[docs/adr/031-openapi-type-generation-frontend\|ADR-031]], [[docs/reference/scripts\|Scripts Reference]] |
| Parse decimal values | [[docs/reference/code-patterns#decimal-pattern-frontend-phase-22\|Decimal Pattern]] | [[docs/adr/021-decimal-arithmetic-for-monetary-values\|ADR-021]] |
| Handle date strings safely | [[docs/reference/code-patterns#timezone-safe-date-utilities-frontend-phase-23\|Timezone Pattern]] | [[docs/adr/009-timezone-policy\|ADR-009]] |
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

## Portfolio & Tax Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Add a new investment | [[docs/features/portfolio\|Portfolio Feature]] | [[docs/api/investments\|Investments API]] |
| Check portfolio performance | [[docs/features/portfolio\|Portfolio Performance]] | [[docs/reference/react-query-keys\|React Query Keys]] |
| Understand inflation adjustment | [[docs/features/portfolio\|Portfolio]] | [[docs/api/info\|Info API]] |
| Update investment prices | [[docs/integrations/price-providers\|Price Providers]] | [[docs/api/investments\|Investments API]] |
| View a past tax year without changing my live profile | [[docs/features/belgian-tax#historical-year-viewer-adr-058\|Belgian Tax Historical Year Viewer]] | [[docs/adr/058-belgian-tax-historical-year-snapshots\|ADR-058]], [[docs/features/portfolio-tax\|Portfolio Tax]] |
| Create a profile snapshot for a historical year | [[docs/features/belgian-tax#historical-year-viewer-adr-058\|Historical Year Viewer]] | [[docs/components/tax/TaxYearSwitcher.tsx\|TaxYearSwitcher]] |

## Transaction Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Import bank statements | [[docs/features/import\|Import Feature]] | [[docs/integrations/bank-adapters\|Bank Adapters]] |
| Delete many transactions at once | [[docs/features/bulk-actions\|Bulk Actions]] | [[docs/api/transactions#post-apitransactionsbulk-delete\|Bulk Delete API]] |
| Recategorize or reassign many transactions | [[docs/features/bulk-actions\|Bulk Actions]] | [[docs/api/transactions#post-apitransactionsbulk-update\|Bulk Update API]] |
| Export a filtered transaction set | [[docs/features/bulk-actions\|Bulk Actions]] | [[docs/api/transactions#post-apitransactionsbulk-export\|Bulk Export API]] |
| Split a transaction | [[docs/api/splits\|Splits API]] | [[docs/features/views\|Owes Page]] |
| Create a planned payment | [[docs/features/plannedTransactions\|Planned Transactions]] | [[docs/api/plannedTransactions\|Planned Transactions API]] |
| Detect recurring payments | [[docs/features/plannedTransactions\|Recurring Detection]] | [[docs/diagrams/recurring-detection-flow.puml\|Recurring Detection Flow]] |

## Release & Deployment Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Release a new version | [[docs/guides/cicd-pipelines\|CI/CD Pipelines]] | [[docs/guides/deployment\|Deployment Guide]] |
| Understand update modes | [[docs/features/application-updates\|Application Updates]] | [[docs/architecture/electron\|Electron Architecture]] |
| Verify a release was published | [[docs/guides/cicd-pipelines#monitoring--alerts\|CI/CD Monitoring]] | GitHub Actions dashboard |
| Fix a failed CI/CD job | [[docs/guides/cicd-pipelines#common-failure-causes\|CI/CD Common Failures]] | [[docs/troubleshooting\|Troubleshooting]] |
| Publish Docker image | [[docs/guides/cicd-pipelines#docker--build-and-push-docker-image\|Docker Job]] | [[docs/guides/deployment\|Deployment Guide]] |
| Generate installer checksum | [[docs/adr/023-update-installer-checksum-verification\|ADR-023]] | [[docs/guides/cicd-pipelines#packagemac--build-macos-installer\|Release Workflow]] |

## Testing Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Run all tests | [[docs/reference/scripts\|Scripts Reference]] | `bun run test` |
| Run E2E tests | [[docs/testing/testing#phase-b-e2e-testing-2026-04-30--complete\|E2E Testing]] | `bun run test:e2e` |
| Run mutation tests | [[docs/testing/testing#phase-f6-mutation-testing-harness-2026-05-02--complete\|Mutation Testing]] | `bun run test:mutation` |
| Write a unit test | [[docs/testing/testing\|Testing Documentation]] | [[docs/reference/code-patterns\|Code Patterns]] |
| Write an integration test | [[docs/testing/frontend-component-integration\|Component-Integration Test Guide]] | [[docs/testing/test-inventory\|Test Inventory]] |
| Write an E2E test | [[docs/testing/frontend/e2e\|E2E Test Guide]] | [[docs/testing/test-inventory#phase-f4--playwright-parity-expansion-2026-05-02\|Phase F4: Playwright Specs]] |
| Check test coverage | `bun run test:coverage` | [[docs/reference/scripts\|Scripts Reference]] |
| Update Playwright snapshots | `bun run test:e2e:update-snapshots` | [[docs/testing/testing#phase-c-accessibility--visual-regression-2026-04-30--complete\|Visual Regression]] |

## Debugging Tasks

| I want to... | Start here | Also check |
|-------------|------------|------------|
| Fix a broken build | [[docs/troubleshooting\|Troubleshooting]] | [[docs/reference/scripts\|Scripts Reference]] |
| Fix a database connection | [[docs/troubleshooting\|Troubleshooting]] | [[docs/reference/environment-variables\|Environment Variables]] |
| Fix a migration failure | [[docs/guides/migrations\|Migration Guide]] | [[docs/troubleshooting\|Troubleshooting]] |
| Fix a rate limit error | [[docs/reference/error-codes\|Error Codes]] | [[docs/security/rate-limiting\|Rate Limiting]] |
| Fix a chart rendering issue | [[docs/performance/chart-downsampling\|Chart Downsampling]] | [[docs/troubleshooting\|Troubleshooting]] |
| Fix a React Query cache issue | [[docs/reference/react-query-keys\|React Query Keys]] | [[docs/performance/caching-strategies\|Caching Strategies]] |
| Fix a failing test | [[docs/testing/testing\|Testing Documentation]] | [[docs/testing/test-inventory\|Test Inventory]] |
| Remediate dependency vulnerabilities | [[docs/security/dependency-security-remediation-2026-04\|Dependency Security Remediation (2026-04)]] | [[docs/reference/scripts\|Scripts Reference]] |

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
bun run docker:dev       # Start Docker dev stack
bun run db:upgrade       # Run migrations

# Testing
bun run test             # Run all tests
bun run test:watch       # Watch mode
bun run test:e2e         # Run E2E tests (Playwright)
bun run test:mutation    # Run mutation tests (Stryker)

# Building
bun run build            # Production build
bun run build:dev        # Development build

# Docker
bun run docker:dev       # Start Docker dev environment
bun run docker:dev:down  # Stop Docker dev environment
```

See [[docs/reference/scripts\|Scripts Reference]] for the complete list.

## Related

- [[docs/getting-started\|Getting Started MOC]] - Entry point for new developers
- [[docs/index\|Knowledge Base Home]] - Main entry point
- [[docs/reference/scripts\|Scripts Reference]] - All available commands
- [[docs/guides/kb-maintenance\|KB Maintenance Guide]] - How to keep docs in sync
