---
title: ADR-031 - OpenAPI Type Generation for Frontend
type: adr
status: Accepted
date: 2026-04-22
tags: [adr, frontend, api-design, phase-2, openapi, codegen, typescript, types]
description: Hand-written OpenAPI 3.0.3 spec (openapi.yaml) as single source of truth for API types; openapi-typescript codegen produces auto-updated generated.ts with zero manual edits
aliases: [adr-031, openapi-types, api-codegen, openapi-generation]
related_code: ["openapi.yaml", "apps/frontend/src/types/generated.ts", "apps/frontend/src/lib/api/"]
---

# ADR-031: OpenAPI Type Generation for Frontend

## Status
Accepted

## Date
2026-04-22

## Context

Phase 1 unified all API responses under [[docs/adr/026-unified-api-response-envelope|ADR-026 Envelope]] (`{ ok: true, data: T, meta? }` or `{ ok: false, error }`). Phase 2 split the monolithic `apps/frontend/src/lib/api.ts` (1553 lines) into 13 domain modules, improving maintainability but introducing a new problem: **request/response types are hand-written, scattered across domain modules, and drift from the actual API spec over time.**

**Observed issues:**
- New backend endpoint added → developer must update frontend types in 2-3 places
- API contract changes → TypeScript types become stale unless manually audited
- No single source of truth; spec lives in code comments and Postman
- Frontend codegen (e.g., OpenAPI to TypeScript) requires a spec that doesn't exist
- IDE autocomplete is incomplete for newer endpoints

The unified envelope (ADR-026) makes this tractable: every response follows the same shape, so OpenAPI generation becomes straightforward.

## Decision

### 1. OpenAPI Spec as Single Source of Truth

Create `openapi.yaml` at the project root (hand-written, version-controlled):

```yaml
openapi: 3.0.3
info:
  title: Vision API
  version: 1.0.0
servers:
  - url: http://localhost:3002
paths:
  /api/transactions:
    get:
      operationId: listTransactions
      parameters:
        - name: limit
          in: query
          schema: { type: integer, default: 50 }
        - name: offset
          in: query
          schema: { type: integer, default: 0 }
      responses:
        '200':
          description: Success
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TransactionsEnvelope'
    post:
      operationId: createTransaction
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateTransactionRequest' }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/TransactionEnvelope' }
  # ... 100+ more endpoints

components:
  schemas:
    Envelope:
      oneOf:
        - type: object
          properties:
            ok: { const: true }
            data: {}
            meta:
              type: object
              properties:
                requestId: { type: string }
                pagination: { $ref: '#/components/schemas/Pagination' }
        - type: object
          properties:
            ok: { const: false }
            error: { $ref: '#/components/schemas/ApiError' }
    
    Transaction:
      type: object
      properties:
        id: { type: integer }
        date: { type: string, format: date }
        description: { type: string }
        amount: { type: number }
        # ... more fields

    TransactionEnvelope:
      allOf:
        - $ref: '#/components/schemas/Envelope'
        - type: object
          properties:
            data: { $ref: '#/components/schemas/Transaction' }

    TransactionsEnvelope:
      allOf:
        - $ref: '#/components/schemas/Envelope'
        - type: object
          properties:
            data:
              type: array
              items: { $ref: '#/components/schemas/Transaction' }

    CreateTransactionRequest:
      type: object
      required: [date, description, amount]
      properties:
        date: { type: string, format: date }
        description: { type: string }
        amount: { type: number }

    ApiError:
      type: object
      required: [code, message]
      properties:
        code:
          type: string
          enum: [VALIDATION_ERROR, NOT_FOUND, CONFLICT, RATE_LIMITED, INTERNAL_SERVER_ERROR]
        message: { type: string }
        details: {}

    Pagination:
      type: object
      properties:
        total: { type: integer }
        page: { type: integer }
        limit: { type: integer }
```

### 2. OpenAPI-TypeScript Codegen

Add `openapi-typescript` package to project:

```json
{
  "devDependencies": {
    "openapi-typescript": "^7.13.0"
  }
}
```

Add npm script to root `package.json`:

```json
{
  "scripts": {
    "generate:types": "openapi-typescript openapi.yaml -o apps/frontend/src/types/generated.ts"
  }
}
```

Run during CI/CD and locally before commits:

```bash
bun run generate:types
```

Generates `apps/frontend/src/types/generated.ts` (~1000 lines, do not edit):

```typescript
// AUTO-GENERATED — do not edit manually
export interface TransactionsEnvelope {
  ok: boolean;
  data?: Transaction[];
  meta?: ResponseMeta;
  error?: ApiError;
}

export interface Transaction {
  id: number;
  date: string;
  description: string;
  amount: number;
  // ... all fields
}

export interface CreateTransactionRequest {
  date: string;
  description: string;
  amount: number;
}

// ... 50+ more generated types
```

### 3. Frontend Import Workflow

Domain modules in `apps/frontend/src/lib/api/*.ts` import from `generated.ts`:

```typescript
// apps/frontend/src/lib/api/transactions.ts
import { request } from './client';
import type {
  TransactionsEnvelope,
  TransactionEnvelope,
  Transaction,
  CreateTransactionRequest,
} from '@/types/generated';

export async function getTransactions(
  params?: Record<string, unknown>
): Promise<Transaction[]> {
  return request<TransactionsEnvelope>('/api/transactions', {
    params,
  }).then(env => env.data || []);
}

export async function createTransaction(
  data: CreateTransactionRequest
): Promise<Transaction> {
  return request<TransactionEnvelope>('/api/transactions', {
    method: 'POST',
    body: JSON.stringify(data),
  }).then(env => env.data);
}
```

### 4. Sync Workflow

When API changes:

1. **Backend endpoint added or changed** → Update `openapi.yaml` (one location)
2. **Run codegen** → `bun run generate:types` produces `generated.ts`
3. **Frontend types updated automatically** → Components use new types from `generated.ts`
4. **TypeScript errors if contract drifts** → IDE shows missing fields, breaking changes

### 5. Validation at Build Time

Pre-commit hook validates OpenAPI syntax:

```bash
openapi-ts validate openapi.yaml
```

Or in CI:

```bash
bun run validate:openapi
```

### 6. Migration Path

**Phase 2.4 (current):**
- Hand-written `openapi.yaml` + codegen
- Covers core endpoints (transactions, categories, recipients, investments, info, imports)
- Generated types replace hand-written types in domain modules

**Phase 3 (future):**
- Optionally auto-generate OpenAPI spec from backend JSDoc or decorators
- Keep hand-written YAML if it's less verbose than decorators

**Phase 4+ (future):**
- Full OpenAPI SDK generation (not just types)
- API client library generation if needed
- OpenAPI documentation portal

## Consequences

### Positive

- **Single source of truth** — `openapi.yaml` is the canonical spec; types are derived
- **Always in sync** — Generated types match spec byte-for-byte; no drift
- **Type safety** — IDE autocomplete, breaking change detection
- **IDE support** — Plugins like "OpenAPI Preview" show live documentation
- **API documentation** — OpenAPI spec doubles as API reference
- **Frontend-backend alignment** — Contract mismatch caught at compile time
- **Onboarding** — New developers see spec and examples in one place

### Neutral

- **Additional build step** — `generate:types` must run before testing
- **Tool dependency** — Adds `openapi-typescript` (~5MB) to devDependencies
- **Spec maintenance** — Hand-written YAML requires discipline; typos propagate to generated types

### Negative

- **Not full OpenAPI compliance** — Some complex patterns (discriminated unions, circular refs) require manual schema tuning
- **Hand-written spec for now** — Future phases should automate generation from backend code
- **Endpoint count growth** — Maintaining 100+ endpoint specs is tedious; Phase 3 automation critical

## Implementation

### Code Changes

1. **Create `openapi.yaml`** at project root with all core endpoints (transactions, categories, recipients, investments, planned, imports, settings, charts, aggregations, info)

2. **Add dependency:**
   ```bash
   npm install --save-dev openapi-typescript@^7.13.0
   ```

3. **Add scripts to root `package.json`:**
   ```json
   {
     "scripts": {
       "generate:types": "openapi-typescript openapi.yaml -o apps/frontend/src/types/generated.ts",
       "validate:openapi": "openapi-ts validate openapi.yaml"
     }
   }
   ```

4. **Generate initial types:**
   ```bash
   bun run generate:types
   ```

5. **Update domain modules** to import from `@/types/generated`:
   - `apps/frontend/src/lib/api/transactions.ts`
   - `apps/frontend/src/lib/api/categories.ts`
   - ... (all 13 domain modules)

6. **Update frontend components** to use generated types instead of local type definitions

7. **Add pre-commit hook** (in `.git/hooks/pre-commit` or via husky):
   ```bash
   #!/bin/bash
   bun run validate:openapi || exit 1
   bun run generate:types || exit 1
   git add apps/frontend/src/types/generated.ts
   ```

### Testing

```bash
# Validate OpenAPI syntax
bun run validate:openapi

# Generate types
bun run generate:types

# TypeScript check (types must compile)
bun run type-check

# Full test suite
bun test
```

### Database

- No schema changes
- Types are frontend-only

## Rollout

**Immediate (Phase 2.4 — this change):**
- Create `openapi.yaml` with core endpoints (108 total)
- Add codegen dependency and scripts
- Generate `apps/frontend/src/types/generated.ts`
- Update domain modules to use generated types

**Phase 3:**
- Auto-generate OpenAPI spec from backend (reduce hand-written YAML)
- Generate API client SDKs if business case emerges

**Phase 4+:**
- OpenAPI documentation portal
- Client library generation for third parties

## Compatibility Impact

- **Backend:** No changes; openapi.yaml describes existing API
- **Frontend:** Types now generated; manually-written types can be deleted
- **API contracts:** None; types are derived from actual endpoints
- **Build time:** Adds ~200ms for codegen (one-time, cached)

## Related

- [[docs/adr/026-unified-api-response-envelope|ADR-026: Unified API Response Envelope]] — Response shape that makes OpenAPI generation tractable
- [[docs/adr/030-frontend-environment-schema|ADR-030: Frontend Environment Schema Validation]] — Zod env validation on boot
- [[docs/reference/frontend-api-client|Frontend API Client Architecture]] — Domain-split API client that consumes generated types
- [[docs/reference/code-patterns#frontend-hook-pattern|Frontend Hook Pattern]] — Hooks that use generated types
- [[docs/api/index|API Documentation]] — Links to `openapi.yaml`
