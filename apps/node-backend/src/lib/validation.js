/**
 * Pure input validation and sanitization helpers.
 *
 * HTTP middleware wrappers live in middleware/validation.js. Keeping the
 * value-level rules here lets repositories and services depend on a library
 * module instead of the Express middleware layer.
 */

import { ValidationError } from "../middleware/errorHandler.js";

/**
 * @typedef {object} FieldValidationResult
 * @property {boolean} valid
 * @property {any} [value]
 * @property {string} [error]
 */

/** @type {Record<string, Set<string>>} */
const ALLOWED_COLUMNS = {
  transactions: new Set([
    "date",
    "transaction_date",
    "bank_account",
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
    "bank_account",
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

/**
 * @param {string} resourceType
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
export function sanitizeUpdateFields(resourceType, fields) {
  const allowed = ALLOWED_COLUMNS[resourceType];
  if (!allowed) throw new Error(`Unknown resource type: ${resourceType}`);

  /** @type {Record<string, unknown>} */
  const sanitized = {};
  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = key.toLowerCase().trim();
    if (allowed.has(normalizedKey)) sanitized[normalizedKey] = value;
  }
  return sanitized;
}

export const MAX_INT32_ID = 2147483647;
export const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;

/**
 * @param {unknown} value
 * @param {string} [fieldName]
 * @param {number} [max]
 * @returns {FieldValidationResult}
 */
export function validateId(value, fieldName = "id", max = MAX_INT32_ID) {
  /** @type {number} */
  let num = NaN;
  if (typeof value === "number") num = value;
  else if (typeof value === "string" && /^\d+$/.test(value))
    num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > max) {
    return { valid: false, error: `${fieldName} must be a positive integer` };
  }
  return { valid: true, value: num };
}

/**
 * @param {unknown} value
 * @param {string} [fieldName]
 * @returns {number|undefined}
 */
export function assertOptionalId(value, fieldName = "id") {
  if (value == null || value === "") return undefined;
  const result = validateId(value, fieldName);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

export const MAX_MONEY_VALUE = 1e12;

/**
 * @param {unknown} value
 * @param {{ min?: number, max?: number, fieldName?: string }} [opts]
 * @returns {FieldValidationResult}
 */
export function validateNumber(
  value,
  { min = -Infinity, max = MAX_MONEY_VALUE, fieldName = "value" } = {},
) {
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

/**
 * @param {unknown} value
 * @param {number} maxLength
 * @param {string} [fieldName]
 * @returns {unknown}
 */
export function assertMaxLength(value, maxLength, fieldName = "value") {
  if (value == null) return value;
  const str = String(value);
  if (str.length > maxLength) {
    throw new ValidationError(
      `${fieldName} must be at most ${maxLength} characters`,
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} [fieldName]
 * @returns {string|undefined}
 */
export function assertCurrency(value, fieldName = "currency") {
  if (value == null || value === "") return undefined;
  const currency = String(value).toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError(`${fieldName} must be a 3-letter ISO code`);
  }
  return currency;
}

/**
 * @param {unknown} value
 * @param {string} [fieldName]
 * @returns {{ valid: boolean, value?: string|null, error?: string }}
 */
export function validateDateString(value, fieldName = "date") {
  if (!value) return { valid: true, value: null };
  const str = /** @type {string} */ (value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return { valid: false, error: `${fieldName} must be in YYYY-MM-DD format` };
  }
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) {
    return { valid: false, error: `${fieldName} is not a valid date` };
  }
  return { valid: true, value: str };
}

/**
 * @param {unknown} value
 * @param {string} [fieldName]
 * @returns {string|undefined}
 */
export function assertYmd(value, fieldName = "date") {
  const result = validateDateString(value, fieldName);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value ?? undefined;
}

/**
 * @param {unknown} values
 * @param {string} [fieldName]
 * @returns {FieldValidationResult}
 */
export function validateIntArray(values, fieldName = "ids") {
  /** @type {unknown[]} */
  const list = Array.isArray(values) ? values : [values];
  /** @type {number[]} */
  const result = [];
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

/**
 * @param {unknown} values
 * @returns {number[]}
 */
export function filterValidatedIdNumbers(values) {
  if (!Array.isArray(values)) return [];
  return values.filter(
    (value) => typeof value === "number" && validateId(value).valid,
  );
}
