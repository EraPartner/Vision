/**
 * Pure input validation and sanitization helpers.
 *
 * HTTP middleware wrappers live in middleware/validation.ts. Keeping the
 * value-level rules here lets repositories and services depend on a library
 * module instead of the Express middleware layer.
 */

import { ValidationError } from "../middleware/errorHandler.ts";

/**
 * Outcome of a value-level check. Both members declare both keys so callers
 * may read `value`/`error` before narrowing on `valid`.
 */
export type FieldValidationResult<T = unknown> =
  | { valid: true; value: T; error?: undefined }
  | { valid: false; error: string; value?: undefined };

const ALLOWED_COLUMNS: Record<string, Set<string>> = {
  transactions: new Set([
    "date",
    "transaction_date",
    "account_id",
    "recipient_id",
    "amount",
    "memo",
    "currency",
    "category_id",
    "comment",
    "is_active",
  ]),
  categories: new Set(["general", "detail", "description", "is_active"]),
  recipients: new Set(["name", "default_category_id", "notes", "is_active"]),
  planned_transactions: new Set([
    "planned_date",
    "account_id",
    "recipient_id",
    "amount",
    "memo",
    "currency",
    "category_id",
    "comment",
    "url",
    "is_recurring",
    "recurrence_pattern",
    "recurrence_end_date",
    "max_occurrences",
    "reminder_days_before",
    "is_executed",
    "is_active",
    "last_executed_date",
    "is_loan",
    "loan_type",
    "loan_principal",
    "loan_annual_interest_rate",
    "loan_term_months",
    "loan_start_date",
    "loan_payment_day",
    "loan_regular_payment_amount",
    "loan_first_payment_date",
  ]),
  investments: new Set([
    "name",
    "symbol",
    "asset_class",
    "currency",
    "current_price",
    "interest_rate",
    "maturity_date",
    "location",
    "municipality",
    "cadastral_income",
    "municipality_tax_rate",
    "notes",
    "is_active",
  ]),
  portfolio_transactions: new Set([
    "type",
    "date",
    "amount",
    "units",
    "price_per_unit",
    "fees",
    "taxes",
    "currency",
    "note",
    "is_recurring",
    "recurrence_interval",
    "recurrence_end_date",
  ]),
};

export function sanitizeUpdateFields(
  resourceType: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = ALLOWED_COLUMNS[resourceType];
  if (!allowed) throw new Error(`Unknown resource type: ${resourceType}`);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = key.toLowerCase().trim();
    if (allowed.has(normalizedKey)) sanitized[normalizedKey] = value;
  }
  return sanitized;
}

export const MAX_INT32_ID = 2147483647;
export const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;

export function validateId(
  value: unknown,
  fieldName = "id",
  max = MAX_INT32_ID,
): FieldValidationResult<number> {
  let num = NaN;
  if (typeof value === "number") num = value;
  else if (typeof value === "string" && /^\d+$/.test(value))
    num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > max) {
    return { valid: false, error: `${fieldName} must be a positive integer` };
  }
  return { valid: true, value: num };
}

export function assertOptionalId(
  value: unknown,
  fieldName = "id",
): number | undefined {
  if (value == null || value === "") return undefined;
  const result = validateId(value, fieldName);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

export const MAX_MONEY_VALUE = 1e12;

export function validateNumber(
  value: unknown,
  {
    min = -Infinity,
    max = MAX_MONEY_VALUE,
    fieldName = "value",
  }: { min?: number; max?: number; fieldName?: string } = {},
): FieldValidationResult<number> {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return { valid: false, error: `${fieldName} must be a finite number` };
  }
  if (num < min || num > max) {
    return {
      valid: false,
      error: `${fieldName} must be between ${min} and ${max}`,
    };
  }
  return { valid: true, value: num };
}

export function assertMaxLength<T>(
  value: T,
  maxLength: number,
  fieldName = "value",
): T {
  if (value == null) return value;
  const str = String(value);
  if (str.length > maxLength) {
    throw new ValidationError(
      `${fieldName} must be at most ${maxLength} characters`,
    );
  }
  return value;
}

export function assertCurrency(
  value: unknown,
  fieldName = "currency",
): string | undefined {
  if (value == null || value === "") return undefined;
  const currency = String(value).toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError(`${fieldName} must be a 3-letter ISO code`);
  }
  return currency;
}

export function validateDateString(
  value: unknown,
  fieldName = "date",
): FieldValidationResult<string | null> {
  if (!value) return { valid: true, value: null };
  // Raw request input; the regex below is the only shape check (historical).
  const str = value as string;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return { valid: false, error: `${fieldName} must be in YYYY-MM-DD format` };
  }
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) {
    return { valid: false, error: `${fieldName} is not a valid date` };
  }
  return { valid: true, value: str };
}

export function assertYmd(
  value: unknown,
  fieldName = "date",
): string | undefined {
  const result = validateDateString(value, fieldName);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value ?? undefined;
}

export function validateIntArray(
  values: unknown,
  fieldName = "ids",
): FieldValidationResult<number[]> {
  const list: unknown[] = Array.isArray(values) ? values : [values];
  const result: number[] = [];
  for (const value of list) {
    const element = validateId(value, fieldName);
    if (!element.valid) {
      return {
        valid: false,
        error: `${fieldName} contains invalid value: ${value}`,
      };
    }
    result.push(element.value);
  }
  return { valid: true, value: result };
}

export function filterValidatedIdNumbers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return values.filter(
    (value) => typeof value === "number" && validateId(value).valid,
  );
}
