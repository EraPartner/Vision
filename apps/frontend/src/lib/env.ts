/**
 * Frontend Vite environment schema (ADR-030 / Phase 1 mirror).
 *
 * Mirrors `apps/node-backend/src/config/env.js`: all Vite env reads should flow
 * through `env` exported here so misconfiguration fails fast at module import
 * with an aggregated message. `lib/logger.ts` intentionally stays on raw
 * `import.meta.env` since it must be usable before this module parses.
 */

import { z } from 'zod';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;

const booleanEnv = (defaultValue: boolean) =>
    z
        .string()
        .optional()
        .transform((value) => {
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
            // Validate but keep the original (trimmed) form — callers build paths off it.
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

const envSchema = z
    .object({
        VITE_API_URL: optionalUrl,
        VITE_LOG_LEVEL: logLevelEnv,
        VITE_ENABLE_LOGGING: booleanEnv(true),
        // Per-account portfolio HOLDINGS UI (ADR-091/100). Default OFF (ADR-103).
        VITE_ENABLE_PER_ACCOUNT_HOLDINGS: booleanEnv(false),
    })
    .passthrough();

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

/**
 * Per-account portfolio HOLDINGS feature (ADR-091/100). Default OFF (ADR-103):
 * the holdings-per-account UI is hidden while budgeting/cash accounts stay on.
 * Flip the default to `true` (or set VITE_ENABLE_PER_ACCOUNT_HOLDINGS=true) to restore.
 */
export const isPerAccountHoldingsEnabled = env.VITE_ENABLE_PER_ACCOUNT_HOLDINGS as boolean;

export default env;
