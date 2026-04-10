---
title: Test Inventory
type: testing
status: active
date: 2026-04-10
tags: [testing, inventory, coverage, vitest, react-testing-library]
description: Inventory of existing tests and coverage areas across frontend and backend
aliases: [test coverage, test list, test inventory]
related_code:
  - apps/frontend/src/hooks/useStatistics.test.ts
  - apps/frontend/src/components/forms/addTransactionForm.test.ts
  - apps/frontend/src/components/shared/dateUtils.test.ts
  - apps/frontend/src/components/tax/__tests__/SuggestedDeductionsCard.test.tsx
---

# Test Inventory

## Overview

This document tracks the current state of test coverage across the Vision codebase. The project uses **Vitest** for backend tests and **React Testing Library** for frontend component tests.

## Frontend Tests

### Existing Tests

| File | Type | What It Tests |
|------|------|---------------|
| `apps/frontend/src/hooks/useStatistics.test.ts` | Hook test | `useStatistics` hook behavior, exclusion toggles, data processing |
| `apps/frontend/src/components/forms/addTransactionForm.test.ts` | Unit test | Transaction form validation logic (Zod schema) |
| `apps/frontend/src/components/shared/dateUtils.test.ts` | Unit test | Date formatting utilities with various app settings |
| `apps/frontend/src/components/tax/__tests__/SuggestedDeductionsCard.test.tsx` | Component test | SuggestedDeductionsCard rendering and interactions |
| `apps/frontend/src/utils/currency.test.ts` | Unit test | Currency formatting utilities |

### Test Framework

- **Runner**: Vitest
- **Component testing**: React Testing Library
- **Assertions**: Vitest expect API
- **Mocks**: Vitest `vi.fn()`, `vi.mock()`

## Backend Tests

The backend test coverage should be inventoried by running:

```bash
bun run test
```

Backend tests are located in `apps/node-backend/src/` alongside source files as `*.test.js` files.

### Recently Updated Backend Coverage (2026-04-10)

| File | Area | Coverage Added |
|------|------|----------------|
| `apps/node-backend/tests/config.test.js` | Config/security | `ADMIN_AUTH_TOKEN` mapping + trim behavior |
| `apps/node-backend/tests/routes/investments.test.js` | Performance/regression | Bulk transactions cache-key includes `limit` |
| `apps/node-backend/tests/routes/transactions.test.js` | Security | CSV formula neutralization + sanitized route errors |
| `apps/node-backend/tests/routes/import.test.js` | Security | Sanitized import errors and stream error expectations |
| `apps/node-backend/tests/routes/admin.test.js` | Security | Sanitized admin errors and auth behavior assertions |
| `apps/node-backend/tests/routes/info.test.js` | Security/perf | `/api/info/refresh-views` route + limiter assertions |

## Coverage Gaps

### High-Priority Missing Tests

| Area | Files | Why It Matters |
|------|-------|----------------|
| **Import pipeline** | `bankAdapters.js`, `importService.js`, `streamingImportService.js` | Core data ingestion — each bank adapter needs parsing tests |
| **Deduplication** | `deduplication.js` | SHA-256 hashing and field-based matching logic |
| **Recurring detection** | `recurringDetectionService.js` | Complex interval detection algorithm |
| **Currency conversion** | `currencyConversionService.js` | Multi-source rate resolution, historical rates |
| **Price providers** | `priceProviderService.js` | Spike sanitization, provider fallbacks |
| **Materialized views** | `materializedViewService.js` | Call coalescing, concurrent refresh |
| **Loan repayment** | `loanRepaymentService.js` | Amortization calculations for 3 loan types |
| **Text normalization** | `textNormalization.js` | Recipient name cleaning, European number parsing |

### Medium-Priority Missing Tests

| Area | Files | Why It Matters |
|------|-------|----------------|
| **Repository layer** | All 13 repositories | SQL query correctness, edge cases |
| **Route handlers** | All 14 route files | Request validation, error responses |
| **Portfolio performance** | `portfolioPerformanceSnapshotService.js` | Daily forward-fill, spike sanitization |
| **IBAN validation** | `iban.js` | Mod-97 checksum algorithm |
| **Recurrence service** | `recurrenceService.js` | Date calculation for patterns |

### Frontend Missing Tests

| Area | Files | Why It Matters |
|------|-------|----------------|
| **VirtualDataTable** | `VirtualDataTable.tsx` | Most complex shared component |
| **Net Worth page** | `NetWorthPage.tsx` | Complex chart domain computation |
| **Statistics page** | `StatisticsPage.tsx` | Multiple chart interactions |
| **Portfolio hooks** | `usePortfolio.ts` | Data fetching and processing |
| **Contexts** | All 7 contexts | Provider behavior, default values |
| **API client** | `api.ts` | Retry logic, error handling |

## Running Tests

```bash
# All backend tests
bun run test

# Watch mode
bun run test:watch

# Single test file
bun vitest run src/path/to/test.test.js

# Test name pattern
bun vitest run --test-name-pattern="testName"
```

## Testing Conventions

- Test files are colocated with source files (`*.test.ts` / `*.test.tsx` / `*.test.js`)
- Component tests use `__tests__/` subdirectory for multiple test files
- Hook tests test the hook's return values and side effects
- Unit tests test pure functions with various input/output combinations
- Integration tests test API endpoints with real database queries
