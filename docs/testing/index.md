---
title: Testing Documentation Index
type: testing-index
date: 2026-03-23
---

# Testing Documentation

Testing strategies and patterns for Vision.

## Test Documentation

```dataview
TABLE title, description
FROM "docs/testing"
WHERE type = "testing"
SORT title ASC
```

## Quick Reference

| Topic | Description |
|-------|-------------|
| [[docs/testing/testing|Testing Guide]] | Comprehensive testing guide |

## Test Types

- **Unit Tests** - Individual function/component testing
- **Integration Tests** - API endpoint testing
- **Component Tests** - Frontend UI testing

## Test Coverage Areas

- Input validation
- Currency conversion
- Bank adapters
- API routes
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

- All new features require tests
- Focus on user-facing behavior
- Test error handling and edge cases
