---
title: Testing Documentation Index
type: testing-index
status: active
date: 2026-04-10
tags: [testing, index, quality, vitest]
description: Testing strategies, patterns, and best practices for the Vision project
aliases: [testing, tests, QA]
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
