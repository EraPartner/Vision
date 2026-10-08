/**
 * Minimal arg validators for AI-chat tools.
 *
 * The LLM emits JSON arguments; we must treat them as untrusted input
 * (malformed dates, NaN, SQL-unsafe strings, array overflows).
 *
 * These helpers coerce + throw with a stable error shape so the tool
 * dispatcher can feed the error back to the model for retry.
 */

import { validateId } from "../../../lib/validation.ts";
import type { ToolCache } from "../toolCache.ts";

/**
 * Per-turn context threaded through every tool's `run(args, context)` by
 * `dispatchTool` (see ./index.js). `cache` is the per-turn memoization Map
 * (../toolCache.js); `maxRows` bounds a tool's own row scans.
 */
export interface ToolContext {
  maxRows?: number;
  cache?: ToolCache;
  allowExternalResearch?: boolean;
  allowWebResearch?: boolean;
  allowSavedAnalysis?: boolean;
  researchBudget?: { searches: number; pages: number };
  signal?: AbortSignal;
  scope?: {
    accountIds?: number[];
    investmentIds?: number[];
    dateFrom?: string | null;
    dateTo?: string | null;
    currency?: string;
  };
}

export class ToolValidationError extends Error {
  field: string | null;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "ToolValidationError";
    this.field = field || null;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    throw new ToolValidationError(
      `${field} must be an ISO date (YYYY-MM-DD)`,
      field,
    );
  }
  const d = new Date(`${value}T00:00:00Z`);
  // `new Date('2025-02-30T00:00:00Z')` silently rolls to Mar 2 instead of
  // throwing. Reject any string that doesn't round-trip — otherwise the bad
  // date reaches SQL as an opaque error instead of a clean validation error.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ToolValidationError(`${field} is not a valid date`, field);
  }
  return value;
}

export function requireDate(value: unknown, field: string): string {
  const parsed = parseDate(value, field);
  if (!parsed) throw new ToolValidationError(`${field} is required`, field);
  return parsed;
}

/**
 * Bounded positive integer — the tools' `limit`/`topN`/`year` knobs *and* their
 * `categoryId`/`recipientId`/`plannedId` arguments.
 *
 * Shape is `validateId`'s, so an id the model emits here is parsed by exactly
 * the same rule as one arriving on a route: a plain base-10 digit string or an
 * integer number, nothing else. It used to be `parseInt`, which took the
 * leading digits of anything — `"12abc"` and `"12.9"` both became 12, so a
 * malformed id operated on the wrong record instead of erroring. That failure
 * mode is worse here than anywhere else in the codebase: the caller is a model,
 * so an error it can read is something it can correct, while a silently wrong
 * record is something nothing in the loop notices.
 *
 * `min`/`max` are the caller's own bounds and stay separate from the shape
 * check — `year` starts at 2000, `minOccurrences` at 2.
 */
export function parsePositiveInt(
  value: unknown,
  field: string,
  opts: PositiveIntOptions & { defaultValue: number },
): number;
export function parsePositiveInt(
  value: unknown,
  field: string,
  opts?: PositiveIntOptions,
): number | null;
export function parsePositiveInt(
  value: unknown,
  field: string,
  { min = 1, max = 1000, defaultValue = null }: PositiveIntOptions = {},
): number | null {
  if (value == null) return defaultValue;
  const result = validateId(value, field, max);
  if (!result.valid || result.value < min) {
    // The received value is echoed because the message is fed straight back to
    // the model (dispatchTool's formatError): "must be an integer between 1 and
    // 500" alone does not tell it what was wrong with "12.9".
    let received: string;
    try {
      received = JSON.stringify(value);
    } catch {
      received = String(value);
    }
    throw new ToolValidationError(
      `${field} must be an integer between ${min} and ${max} — received ${received.slice(0, 60)}`,
      field,
    );
  }
  return result.value;
}

/**
 * `parsePositiveInt` for an argument the tool's schema marks required: a
 * missing value is a validation error the model can read and fix, not a null
 * that reaches SQL as `"null-01-01"` or a "not found" lookup.
 */
export function requirePositiveInt(
  value: unknown,
  field: string,
  opts: Omit<PositiveIntOptions, "defaultValue"> = {},
): number {
  const parsed = parsePositiveInt(value, field, opts);
  if (parsed == null) {
    throw new ToolValidationError(`${field} is required`, field);
  }
  return parsed;
}

interface PositiveIntOptions {
  min?: number;
  max?: number;
  defaultValue?: number | null;
}

interface EnumOptions<T extends string> {
  defaultValue?: T | null;
  required?: boolean;
}

export function parseEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  opts: EnumOptions<T> & ({ defaultValue: T } | { required: true }),
): T;
export function parseEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  opts?: EnumOptions<T>,
): T | null;
export function parseEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  { defaultValue = null, required = false }: EnumOptions<T> = {},
): T | null {
  if (value == null) {
    if (required) throw new ToolValidationError(`${field} is required`, field);
    return defaultValue;
  }
  if (typeof value !== "string" || !isAllowedValue(value, allowed)) {
    throw new ToolValidationError(
      `${field} must be one of: ${allowed.join(", ")}`,
      field,
    );
  }
  return value;
}

function isAllowedValue<T extends string>(
  value: string,
  allowed: readonly T[],
): value is T {
  const allowedValues: readonly string[] = allowed;
  return allowedValues.includes(value);
}

export function assertDateOrder(
  from: string | null | undefined,
  to: string | null | undefined,
): void {
  if (from && to && from > to) {
    throw new ToolValidationError("`from` must be on or before `to`", "from");
  }
}
