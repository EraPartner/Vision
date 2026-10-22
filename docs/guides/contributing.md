---
title: Contributing Guide
type: guide
status: active
date: 2026-10-22
tags:
  [
    guide,
    contributing,
    development,
    workflow,
    code-standards,
    typescript,
    error-handling,
    type-safety,
  ]
description: How to contribute to Vision — development workflow, code standards, testing, and type-safe TypeScript patterns
aliases:
  [
    contributing-guide,
    development-workflow,
    code-standards,
    pull-requests,
    typescript-standards,
    error-handling-guide,
  ]
related_code: [[AGENTS.md]]
---

# Contributing Guide

This guide covers how to contribute to Vision, including development workflow, code standards, and best practices.

## Getting Started

### 1. Fork and Clone

```bash
# Fork the repository on GitHub
# Then clone your fork
git clone https://github.com/YOUR_USERNAME/Vision.git
cd Vision

# Add upstream remote
git remote add upstream https://github.com/original/Vision.git
```

### 2. Setup Development Environment

Follow the [[docs/guides/setup|Setup Guide]] to configure your local development environment.

**Install pre-commit hooks:**

`bun install` points git at `.githooks/` through the root `prepare` script
(`scripts/setup-git-hooks.ts`); run `bun run hooks:setup` to redo it by hand.

```bash

# Install gitleaks (required for secrets scanning)
brew install gitleaks
```

The `.githooks/pre-commit` script runs before every `git commit`, scanning staged changes for hardcoded secrets (API keys, credentials, passphrases). If gitleaks is not installed, the hook gracefully skips with a warning; the gitleaks step in the CI `Repo Checks` job will catch any leaks during PR review.

See [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050]] for details.

### 3. Create a Feature Branch

```bash
# Sync with upstream
git fetch upstream
git checkout main
git merge upstream/main

# Create feature branch
git checkout -b feature/your-feature-name
# Or bugfix/issue-description
```

## Development Workflow

### Making Changes

1. **Read first**: Check existing documentation in [[docs/index|Knowledge Base]]
2. **Check ADRs**: Review [[docs/adr/index|Architecture Decision Records]] for design decisions
3. **Look at API docs**: See [[docs/api/index|API Documentation]] before adding endpoints
4. **Make changes**: Follow code style guidelines below
5. **Write tests**: Cover new functionality with tests
6. **Update docs**: Keep documentation in sync

### Committing Changes

```bash
# Stage changes
git add .

# Commit with descriptive message
git commit -m "feat: add transaction categorization feature

- Add category selection to transaction form
- Implement auto-categorization based on recipient
- Add category statistics to dashboard"
```

#### Commit Message Format

Use conventional commits:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Code style (formatting)
- `refactor`: Code refactoring
- `test`: Tests
- `chore`: Maintenance

### Pull Request Process

1. **Update branch**: Rebase onto latest main
2. **Run tests**: Ensure all tests pass
3. **Lint code**: Run `bun run lint`
4. **Push branch**: `git push origin feature/your-feature`
5. **Create PR**: Use clear title and description
6. **Link issues**: Reference related issues

## Code Style Guidelines

### TypeScript (Frontend)

```typescript
// Use interfaces for props and state
interface TransactionFormProps {
  initialData?: Transaction;
  onSubmit: (data: Transaction) => void;
}

// Use union types for variants
type ButtonVariant = "default" | "destructive" | "outline";

// Type-safe error handling (Phase 5+)
try {
  const result = await apiClient.loadData();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  toast.error(message);
}

// Explicit type annotations for variables
let currentValue: number; // ✅ Clear intent
let values: string[] = []; // ✅ Explicit type

// Avoid:
let count = 0; // ❌ Looks uninitialized
const data: any = {}; // ❌ Disables type checking

// Path alias: @/* maps to apps/frontend/src/*
import { useTransaction } from "@/hooks/useTransaction";
```

**Type Safety Rules:**

- Always use `catch (err: unknown)` instead of `catch (err: any)`
- Avoid `as any` casts — use type guards instead
- Explicitly type variables on declaration when not initialized
- Use `type` for simple aliases, `interface` for object contracts

See [[docs/reference/code-patterns#typescript-type-annotation-best-practices-phase-5|Type Annotation Best Practices]] and [[docs/components/index|Component Documentation]] for more.

### TypeScript/Node.js (Backend)

The backend is strict TypeScript ([[docs/adr/186-backend-strict-typescript|ADR-186]]). Entity ids and
currency codes use the branded types from `@vision/types/brands`
([[docs/adr/220-branded-ids-currency-codes-and-money|ADR-220]]). Repositories build queries with
Kysely through `db` from `apps/node-backend/src/database/db.ts`; analytical SQL uses Kysely's `sql`
tag with bound parameters ([[docs/adr/226-kysely-query-builder|ADR-226]]).

```typescript
// ES2022+ ESM with async/await
import type { TransactionId } from "@vision/types/brands";
import { db } from "../database/db.ts";

// Never use null - use undefined for optional values
async function findTransactionComment(
  id: TransactionId,
): Promise<string | undefined> {
  const row = await db
    .selectFrom("transactions")
    .select("comment")
    .where("id", "=", id)
    .executeTakeFirst();
  return row?.comment ?? undefined;
}
```

### React Components

```tsx
// Functional components with hooks
export function TransactionList({ filters }) {
  const { data, isLoading } = useTransactions(filters);

  if (isLoading) return <Spinner />;

  return (
    <ul>
      {data.map((tx) => (
        <TransactionItem key={tx.id} transaction={tx} />
      ))}
    </ul>
  );
}
```

### Styling

```tsx
// Use Tailwind with cx (@/lib/classNames) and tailwind-merge
import { cx } from "@/lib/classNames";
import { twMerge } from "tailwind-merge";

function cn(...inputs) {
  return twMerge(cx(inputs));
}

// Use cva for component variants
import { cva } from "@/lib/classNames";

const buttonVariants = cva("base-styles", {
  variants: {
    variant: {
      default: "bg-primary",
      destructive: "bg-red-500",
    },
  },
});
```

## Testing

### Backend Tests

```bash
# Run backend tests without a database (DB-backed cases self-skip)
bun run test

# Watch all backend tests with disposable PostgreSQL 18 during development
bun run test:watch

# Run specific test file
bun vitest run tests/services/transactionService.test.ts
```

#### Test Structure

```javascript
import { describe, it, expect, beforeEach } from "vitest";
import { calculateBalance } from "./calculations";

describe("calculateBalance", () => {
  let transactions;

  beforeEach(() => {
    transactions = [
      { amount: -50 }, // expense
      { amount: 100 }, // income
    ];
  });

  it("should calculate net balance", () => {
    const balance = calculateBalance(transactions);
    expect(balance).toBe(50);
  });
});
```

### Frontend Tests

Use React Testing Library:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionForm } from "./TransactionForm";

it("should submit form with correct data", () => {
  const onSubmit = vi.fn();
  render(<TransactionForm onSubmit={onSubmit} />);

  fireEvent.change(screen.getByLabelText("Amount"), {
    target: { value: "100" },
  });

  fireEvent.click(screen.getByText("Submit"));

  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ amount: 100 }),
  );
});
```

## Database Migrations

### Creating a Migration

```bash
# Create db/migrations/NNNN_add_new_column_to_transactions.sql
bun run db:new -- add_new_column_to_transactions
```

### Migration Guidelines

- Always test migrations locally first
- Provide rollback plan in PR description
- Pending migrations run automatically at the next backend start, so ship destructive DDL only
  after the code that stops reading the object; `bun run db:lint` (squawk) flags it
- Add a `.down.sql` rollback and regenerate types with `bun run db:codegen`
- Use meaningful snake_case migration names; never edit an applied migration file
- See [[docs/guides/migrations|Database Migration Guide]]

## Documentation

### When to Update Docs

- Adding new features
- Creating new API endpoints
- Changing existing behavior
- Adding new configuration options

### Documentation Types

| Type     | Location         | Description            |
| -------- | ---------------- | ---------------------- |
| API Docs | `docs/api/`      | Endpoint documentation |
| Features | `docs/features/` | Feature overviews      |
| ADRs     | `docs/adr/`      | Architecture decisions |
| Guides   | `docs/guides/`   | How-to guides          |

### Using Wiki Links

Link to code files using Obsidian-style links:

```markdown
See [[apps/node-backend/src/services/importPipeline/index.ts]] for implementation.
```

## AI Agent Guidelines

When working with AI agents on this project:

1. **Read AGENTS.md** - Contains project-specific guidelines
2. **Check knowledge base** - Use [[docs/index]]
3. **Run tests** - Verify changes work
4. **Evaluate docs impact** - Update docs only when a documented surface changed

See [[AGENTS.md]] for more details on working with AI agents.

## Code Review Checklist

Before submitting a PR, verify:

- [ ] Code follows style guidelines
- [ ] Tests pass locally
- [ ] No linting errors
- [ ] Documentation impact evaluated; affected docs updated or a no-update reason recorded
- [ ] No console.log/debug code left
- [ ] Error handling implemented
- [ ] Related docs linked in PR

## Issue Reporting

### Bug Reports

Include:

- Steps to reproduce
- Expected vs actual behavior
- Environment details
- Relevant logs

### Feature Requests

Include:

- Use case description
- Proposed solution
- Alternative considerations
- Related features

## Related

- [[docs/guides/ai-agent-kb-usage|AI Agent KB Usage Guide]]
- [[docs/guides/kb-maintenance|KB Maintenance Guide]]
- [[docs/guides/setup|Setup Guide]]
- [[docs/guides/deployment|Deployment Guide]]
- [[docs/adr/index|Architecture Decisions]]
- [[docs/api/index|API Documentation]]
- [[docs/testing/index|Testing Documentation]]
