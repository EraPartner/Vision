---
title: Testing Documentation Index
type: testing-index
status: active
date: 2026-04-11
tags:
  - testing
  - index
  - quality
  - vitest
description: Testing strategies, patterns, and best practices for the Vision project
aliases:
  - testing
  - tests
  - QA
---

# Testing Documentation

> [!abstract] Overview
> Testing documentation for Vision. Covers frameworks, patterns, and best practices for both backend and frontend.

## Test Documentation

```dataview
TABLE WITHOUT FILE title AS "Topic", description AS "Description", date AS "Updated"
FROM "docs/testing"
WHERE type = "testing"
SORT title ASC
```

## Quick Reference

| Topic | Description |
|-------|-------------|
| [[docs/testing/testing\|Testing Guide]] | Comprehensive testing guide with patterns and best practices |
| [[docs/testing/test-inventory\|Test Inventory]] | Current test coverage status and gaps |

## Test Types

| Type | Scope | Framework |
|------|-------|-----------|
| **Unit Tests** | Individual functions/services | Vitest |
| **Integration Tests** | API endpoints | Vitest + Supertest |
| **Component Tests** | Frontend UI | React Testing Library |

## Test Coverage Areas

- Input validation
- Currency conversion
- Bank adapters
- API routes
- Security hardening regressions (sanitized errors, auth middleware, CSV export safety)
- Split route validation and CSV export responses
- Investment repository inheritance compatibility tests
- React components

## Tools

- **Vitest** - Backend unit tests
- **React Testing Library** - Frontend component tests
- **Bun** - Test runner

## Running Tests

```bash
# All tests
bun test

# Watch mode
bun test:watch

# Specific file
bun vitest run src/path/to/test.test.js
```

## Coverage Goals

> [!tip] Testing Guidelines
> - All new features require tests
> - Focus on user-facing behavior
> - Test error handling and edge cases
> - Never modify original code to make testing easier

## Related Documentation

- [[docs/guides/contributing\|Contributing Guide]] - Development workflow
- [[docs/features/index\|Feature Docs]] - What to test for each feature
- [[docs/api/index\|API Documentation]] - Endpoints to test

## Coverage Update (2026-04-11)

- Targeted backend coverage was added for currency conversion fallback behavior and planned/transaction route patch validation branches.
- Tests: [[apps/node-backend/tests/currencyConversionService.test.js]], [[apps/node-backend/tests/routes/plannedTransactions.test.js]], [[apps/node-backend/tests/routes/transactions.test.js]]
- Details: [[docs/testing/testing|Testing Documentation]] and [[docs/testing/test-inventory|Test Inventory]]

### Coverage update addendum (2026-04-11)

- Additional backend coverage was added for schema bootstrap behavior and repository-level regressions (category upsert/get semantics and planned-transaction pagination query paths).
- Tests: [[apps/node-backend/tests/schemaInit.test.js]], [[apps/node-backend/tests/categoryRepository.test.js]], [[apps/node-backend/tests/plannedTransactionRepository.test.js]]
- Related code: [[apps/node-backend/src/database/schemaInit.js]], [[apps/node-backend/src/repositories/categoryRepository.js]], [[apps/node-backend/src/repositories/plannedTransactionRepository.js]]


### Coverage update addendum (2026-04-11, adapters/raw import)

- Added targeted backend adapter/import branch coverage for Wise, SABB, and Vision adapters plus raw-transaction import service fallback/delegation/routing paths.
- Tests: [[apps/node-backend/tests/wiseAdapter.test.js]], [[apps/node-backend/tests/sabbAdapter.test.js]], [[apps/node-backend/tests/visionAdapter.test.js]], [[apps/node-backend/tests/rawTransactionImportService.test.js]]
- Related code: [[apps/node-backend/src/services/bankAdapters.js]], [[apps/node-backend/src/services/rawTransactionImportService.js]]
- Details and validation context: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]]


### Coverage update addendum (2026-04-11, info route dependency branches)

- Added targeted backend coverage for info-route dependency orchestration, stale FX refresh branching, recurring-pattern fallback semantics, and cache prewarm failure isolation.
- Tests: [[apps/node-backend/tests/routes/info.test.js]]
- Related source: [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/database/connection.js]], [[apps/node-backend/src/services/recurringDetectionService.js]], [[apps/node-backend/src/services/materializedViewService.js]], [[apps/node-backend/src/services/currencyConversionService.js]], [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]]
- Validation + coverage snapshot: `bun vitest run tests/routes/info.test.js`; `npm test -- --coverage`; overall `81.12/66.86/84.49/84.53`, `info.js` `93.62/78.72/100/94.58` (statements/branches/functions/lines).
- Details: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]]

### Coverage update addendum (2026-04-11, portfolio transaction repository)

- Added targeted backend repository coverage for portfolio transaction query/filter branches and grouped summary return paths.
- Test: [[apps/node-backend/tests/portfolioTransactionRepository.test.js]]
- Related source: [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]
- Validation + coverage snapshot: `bun vitest run tests/portfolioTransactionRepository.test.js` (25 tests); `npm test -- --coverage` (827 tests); overall `81.81/67.61/85.42/85.25`; repositories bucket `68.47/63.45/67.02/72.66`; `portfolioTransactionRepository.js` `78.73/71.5/84.84/82.95` (statements/branches/functions/lines).
- Details: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]]
