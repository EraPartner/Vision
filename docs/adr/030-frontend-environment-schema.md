---
title: ADR-030 - Frontend Environment Schema Validation
type: adr
status: Accepted
date: 2026-04-21
tags: [adr, frontend, configuration, environment, phase-1, validation, typescript]
description: Introduce Zod schema validation for Vite environment variables on frontend boot, mirroring backend ADR-029 env handling
aliases: [adr-030, frontend-env-schema, vite-env-validation]
related_code: ["apps/frontend/src/lib/env.ts", "apps/frontend/src/main.tsx", "apps/frontend/src/lib/api/client.ts", "apps/node-backend/src/config/env.js"]
---

# ADR-030: Frontend Environment Schema Validation

## Status
Accepted

## Date
2026-04-21

## Context

The frontend Vite environment variables (`VITE_API_URL`, `VITE_LOG_LEVEL`, `VITE_ENABLE_LOGGING`) were previously read directly via `import.meta.env` at the point of use, scattered across `lib/api.ts` and `lib/logger.ts`. Misconfiguration (malformed URL, invalid log level, etc.) would surface only at runtime in the affected component, making debugging harder.

The backend uses centralized environment schema validation via Zod at module import time in `apps/node-backend/src/config/env.js`, failing fast with an aggregated error message. Phase 1 now requires the same pattern on the frontend to:
1. Validate `VITE_*` configuration on boot, not on first use
2. Centralize all Vite env reads in one module
3. Provide typed, immutable access to frontend configuration
4. Mirror backend schema structure for consistency

## Decision

### Schema Module

Create `apps/frontend/src/lib/env.ts` with Zod validation of three Vite variables:

```typescript
// apps/frontend/src/lib/env.ts
import { z } from 'zod';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;

const booleanEnv = (defaultValue: boolean) =>
    z.string().optional().transform((value) => {
        if (value === undefined || value === '') return defaultValue;
        return value.trim().toLowerCase() === 'true';
    });

const optionalUrl = z
    .string()
    .optional()
    .transform((value, ctx) => {
        if (value === undefined) return undefined;
        const trimmed = value.trim();
        if (trimmed === '') return undefined;
        try {
            new URL(trimmed);
        } catch {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Expected URL, got: ${trimmed}`,
            });
            return z.NEVER;
        }
        return trimmed;
    });

const logLevelEnv = z
    .string()
    .optional()
    .transform((value, ctx) => {
        if (value === undefined || value.trim() === '') return undefined;
        const normalized = value.trim().toLowerCase();
        if (!(LOG_LEVELS as readonly string[]).includes(normalized)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Expected one of ${LOG_LEVELS.join('|')}, got: ${value}`,
            });
            return z.NEVER;
        }
        return normalized as (typeof LOG_LEVELS)[number];
    });

const envSchema = z.object({
    VITE_API_URL: optionalUrl,
    VITE_LOG_LEVEL: logLevelEnv,
    VITE_ENABLE_LOGGING: booleanEnv(true),
}).passthrough();

export type FrontendEnv = z.infer<typeof envSchema>;

function parseEnv(): FrontendEnv {
    const result = envSchema.safeParse(import.meta.env);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('\n');
        throw new Error(`[env] Invalid Vite environment configuration:\n${issues}`);
    }
    return result.data;
}

export const env: Readonly<FrontendEnv> = Object.freeze(parseEnv());
export default env;
```

### Integration Points

**`apps/frontend/src/main.tsx`:**
```typescript
import env from './lib/env';

// Importing env at module top level ensures validation runs before React boot.
// If configuration is invalid, the error is thrown before render, surfacing misconfiguration immediately.
```

**`apps/frontend/src/lib/api/client.ts`:**
```typescript
import { env } from '@/lib/env';

export const API_BASE_URL = env.VITE_API_URL || 'http://localhost:3002';
```

### Exception: `lib/logger.ts`

`lib/logger.ts` intentionally reads `import.meta.env` directly (not via the `env` module) because:
- Logger must be usable before env parsing completes (it may be called during env parse failures)
- Logger init is minimal and safe (no complex validation needed)
- Circular dependency risk if logger were imported into env.ts

**Comment in lib/env.ts:**
```typescript
/**
 * Frontend Vite environment schema (ADR-030 / Phase 1 mirror).
 * 
 * Mirrors `apps/node-backend/src/config/env.js`: all Vite env reads should flow
 * through `env` exported here so misconfiguration fails fast at module import
 * with an aggregated message. `lib/logger.ts` intentionally stays on raw
 * `import.meta.env` since it must be usable before this module parses.
 */
```

### Variables

| Variable | Default | Type | Validation | Code |
|----------|---------|------|-----------|------|
| `VITE_API_URL` | `http://localhost:3002` | URL string (optional) | Valid URL or undefined | [[apps/frontend/src/lib/env.ts\|env.ts]] |
| `VITE_LOG_LEVEL` | `debug` (dev), `warn` (prod) | `'debug' \| 'info' \| 'warn' \| 'error' \| 'silent'` (optional) | One of allowed levels or undefined | [[apps/frontend/src/lib/env.ts\|env.ts]] |
| `VITE_ENABLE_LOGGING` | `true` | boolean | String coerced to boolean; empty string → default | [[apps/frontend/src/lib/env.ts\|env.ts]] |

### Typed Access

All env vars are **frozen** and **immutable**:

```typescript
import { env } from '@/lib/env';

const apiUrl = env.VITE_API_URL; // type: string | undefined
const logLevel = env.VITE_LOG_LEVEL; // type: 'debug' | 'info' | 'warn' | 'error' | 'silent' | undefined
const loggingEnabled = env.VITE_ENABLE_LOGGING; // type: boolean
```

## Consequences

### Positive

- **Fail-fast on misconfiguration** — Invalid env discovered on boot, not at first use
- **Consistency with backend** — Frontend mirrors `apps/node-backend/src/config/env.js` structure
- **Type safety** — `FrontendEnv` type provides IDE autocomplete and compile-time checks
- **Immutability** — Frozen object prevents accidental env mutation during runtime
- **Aggregated validation** — Zod collects all issues at once; no "fix one, discover another" cycle
- **Single source of truth** — All Vite reads flow through one module; no scattered `import.meta.env` calls

### Negative

- **One more module to import** — Every consumer of env must import from `lib/env`, not read `import.meta.env` directly
- **Logger exception breaks uniformity** — `lib/logger.ts` is an outlier that reads `import.meta.env` directly

### Rollback

1. Remove `apps/frontend/src/lib/env.ts`
2. Revert `apps/frontend/src/lib/api/client.ts` to read `import.meta.env.VITE_API_URL` directly
3. Revert `apps/frontend/src/main.tsx` import statement
4. No data/schema changes — fully reversible in code

## Implementation Notes

**Phase 1 (2026-04-21):**

- `lib/env.ts` introduced; validation runs on import
- `lib/api/client.ts` migrated to read `VITE_API_URL` via `env` module
- `LanguageContext.tsx` migrated from `console.error` to `logger.error` (Phase 1 structured-logging sweep)
- All three Vite variables documented in [[docs/reference/environment-variables|Environment Variables Reference]]
- Backend env.js and frontend env.ts kept in sync manually during Phase 1; Phase 2 may introduce code generation

## Related

- [[docs/adr/026-unified-api-response-envelope|ADR-026: Unified API Response Envelope]] — frontend uses env.VITE_API_URL to communicate with envelope endpoints
- [[apps/node-backend/src/config/env.js|Backend env.js]] — backend's centralized environment schema (not yet ADRized)
- [[docs/reference/environment-variables|Environment Variables Reference]] — all env var documentation
- [[docs/reference/frontend-api-client|Frontend API Client Architecture]] — how env.VITE_API_URL is used
