/**
 * Input validation and sanitization middleware.
 * Prevents SQL injection, XSS, and malformed input.
 */

import { ValidationError } from './errorHandler.js';

/**
 * Deliberately a flat optional-property shape, not a `{valid:true,...} |
 * {valid:false,...}` discriminated union: in this program (many files, this
 * TS version — see project notes), `if (!result.valid) ... result.error`
 * fails to narrow the union and reports `error`/`value` as missing on the
 * still-unnarrowed type, even though the identical pattern narrows correctly
 * in an isolated single-file check. Every call site here already accesses
 * `.error`/`.value` only after checking `.valid`, so the flat shape costs no
 * real safety and sidesteps the narrowing issue entirely.
 * @typedef {object} FieldValidationResult
 * @property {boolean} valid
 * @property {any} [value]
 * @property {string} [error]
 */

// Whitelist of allowed DB columns per resource type
/** @type {Record<string, Set<string>>} */
const ALLOWED_COLUMNS = {
  transactions: new Set([
    // `balance` is deliberately NOT editable here. The running balance is the
    // bank's stamped figure and is only written by the CSV import pipeline
    // (services/importPipeline/commit.js). The account's displayed balance
    // anchors on the most-recent stamped row (ADR-094, accountBalanceSql.js),
    // so letting a manual create/PATCH stamp `balance` lets one hand-typed
    // value poison the whole account total. Reserve it for imports.
    'date', 'transaction_date', 'bank_account', 'recipient_id', 'amount',
    'memo', 'currency', 'category_id', 'comment', 'is_active',
  ]),
  categories: new Set([
    'general', 'detail', 'description', 'is_active',
  ]),
  recipients: new Set([
    'name', 'default_category_id', 'notes', 'is_active',
  ]),
  planned_transactions: new Set([
    'planned_date', 'bank_account', 'recipient_id', 'amount', 'memo',
    'currency', 'category_id', 'comment', 'url', 'is_recurring',
    'recurrence_pattern', 'recurrence_end_date', 'max_occurrences',
    // reminder_days_before is creatable + returned; without it here a PATCH
    // update to the reminder lead time was silently dropped by the whitelist.
    'reminder_days_before',
    'is_executed', 'is_active', 'last_executed_date',
    'is_loan', 'loan_type', 'loan_principal', 'loan_annual_interest_rate',
    'loan_term_months', 'loan_start_date', 'loan_payment_day',
    'loan_regular_payment_amount', 'loan_first_payment_date',
  ]),
  investments: new Set([
    'name', 'symbol', 'asset_class', 'currency', 'current_price',
    'interest_rate', 'maturity_date', 'location', 'municipality',
    'cadastral_income', 'municipality_tax_rate', 'notes', 'is_active',
  ]),
  portfolio_transactions: new Set([
    'type', 'date', 'amount', 'units', 'price_per_unit', 'fees', 'taxes',
    'currency', 'note', 'is_recurring', 'recurrence_interval', 'recurrence_end_date',
  ]),
};

/**
 * Validate and filter update fields to only allowed column names.
 * Prevents SQL injection through dynamic column names.
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
    if (allowed.has(normalizedKey)) {
      sanitized[normalizedKey] = value;
    }
    // Silently drop unknown fields
  }
  return sanitized;
}

/**
 * Upper bound for ids backed by an `int4` (`SERIAL`) primary key — which is
 * every id `validateId` guards by default.
 */
export const MAX_INT32_ID = 2147483647;

/**
 * Upper bound for ids backed by an `int8` (`BIGSERIAL`) primary key — the
 * import batch/row tables. Capped at `Number.MAX_SAFE_INTEGER` rather than
 * `2^63-1` because the id crosses the wire as a JSON number: above 2^53 the
 * digit string and the parsed number stop being the same value, so
 * `"9007199254740993"` would silently address record …992.
 */
export const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;

/**
 * Validate that an ID parameter is a positive integer.
 *
 * Strict by design: the only accepted forms are a plain base-10 digit string
 * (`"42"`, leading zeros allowed) and an actual integer `number` — the latter
 * because validateIdParam/validateIntParam re-stamp req.params with the parsed
 * number, so a re-validated param arrives here as a number.
 *
 * This used to be `parseInt`, which takes the leading digits of anything: it
 * resolved `"12abc"` and `"12.5"` to id 12 and `"1e3"` to id 1 — a silent hit
 * on the wrong record instead of a 400. A bare `Number()` is not the fix
 * either; it accepts `"0x10"` (16), `"1e3"` (1000, a *different* wrong record)
 * and `"12.5"`, which stays 12.5 and reaches Postgres as a non-integer id.
 * Everything else — signs, whitespace padding, exponent/hex/octal/binary
 * literals, separators, empty string, arrays, booleans — is rejected.
 *
 * `max` exists only so the `int8`-backed import batch/row ids can share this
 * one definition of *shape* without inheriting an `int4` ceiling their column
 * does not have; it is not a general knob. See MAX_SAFE_ID.
 * @param {unknown} value
 * @param {string} [fieldName]
 * @param {number} [max]
 * @returns {FieldValidationResult}
 */
export function validateId(value, fieldName = 'id', max = MAX_INT32_ID) {
  /** @type {number} */
  let num = NaN;
  if (typeof value === 'number') num = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > max) {
    return { valid: false, error: `${fieldName} must be a positive integer` };
  }
  return { valid: true, value: num };
}

/**
 * Throwing variant of validateId for optional query params: returns null when
 * the value is absent/empty, the parsed integer when valid, and raises
 * ValidationError on malformed input — so `?account_id=abc` becomes a 400
 * instead of a `NaN` param that Postgres rejects (22P02) as a 500.
 * @param {unknown} value
 * @param {string} [fieldName]
 * @returns {number|null}
 */
export function assertOptionalId(value, fieldName = 'id') {
  if (value == null || value === '') return null;
  const result = validateId(value, fieldName);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

/**
 * Validate and sanitize a string input.
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string|null}
 */
export function sanitizeString(value, maxLength = 500) {
  if (value == null) return null;
  if (typeof value !== 'string') return String(value).slice(0, maxLength);
  return value.trim().slice(0, maxLength);
}

// Sane default upper bound for numeric inputs. Matches the 12-integer-digit
// ceiling of the money columns (NUMERIC(18,6)) and the existing per-field
// investment bounds. Callers that pass an explicit `max` are unaffected; this
// only backstops call-sites that previously left `max = Infinity`, through
// which a JSON `"Infinity"`/`1e15` slipped past every guard and 500'd at the DB.
export const MAX_MONEY_VALUE = 1e12;

/**
 * Validate numeric values. Rejects non-finite input (NaN and, critically,
 * Infinity — `Infinity > Infinity` is false, so the old `isNaN`-only check let
 * a JSON `"Infinity"` through every no-max caller straight to a DB 500).
 * @param {unknown} value
 * @param {{ min?: number, max?: number, fieldName?: string }} [opts]
 * @returns {FieldValidationResult}
 */
export function validateNumber(value, { min = -Infinity, max = MAX_MONEY_VALUE, fieldName = 'value' } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return { valid: false, error: `${fieldName} must be a finite number` };
  }
  if (num < min || num > max) {
    return { valid: false, error: `${fieldName} must be between ${min} and ${max}` };
  }
  return { valid: true, value: num };
}

/**
 * Throwing length guard for free-text route input. Prevents an over-length
 * value from reaching a VARCHAR(n) column and surfacing as a raw 22001 500 —
 * most importantly mid-operation, after an earlier NOT-NULL insert already
 * succeeded (e.g. manual_raw_transactions.bank_account VARCHAR(100)).
 * @param {unknown} value
 * @param {number} maxLength
 * @param {string} [fieldName]
 * @returns {unknown}
 */
export function assertMaxLength(value, maxLength, fieldName = 'value') {
  if (value == null) return value;
  const str = String(value);
  if (str.length > maxLength) {
    throw new ValidationError(`${fieldName} must be at most ${maxLength} characters`);
  }
  return value;
}

/**
 * Throwing ISO-4217 currency guard. Returns undefined for absent/empty input
 * (so the column/repository default applies) and the normalised uppercase code
 * otherwise. Without it, free-typed "euro"/"€"/4-10 char values reached the
 * 0046 currency CHECK / VARCHAR(3) column as a raw 400/500.
 * @param {unknown} value
 * @param {string} [fieldName]
 * @returns {string|undefined}
 */
export function assertCurrency(value, fieldName = 'currency') {
  if (value == null || value === '') return undefined;
  const c = String(value).toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(c)) {
    throw new ValidationError(`${fieldName} must be a 3-letter ISO code`);
  }
  return c;
}

/**
 * Validate date string format (YYYY-MM-DD).
 * @param {unknown} value
 * @param {string} [fieldName]
 * @returns {{ valid: boolean, value?: string|null, error?: string }} Flat
 *   shape, not a discriminated union — see FieldValidationResult's comment
 *   above for why.
 */
export function validateDateString(value, fieldName = 'date') {
  if (!value) return { valid: true, value: null };
  const str = /** @type {string} */ (value);
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(str)) {
    return { valid: false, error: `${fieldName} must be in YYYY-MM-DD format` };
  }
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) {
    return { valid: false, error: `${fieldName} is not a valid date` };
  }
  return { valid: true, value: str };
}

/**
 * Throwing variant of validateDateString for route input: returns the value
 * (or null when empty) and raises ValidationError on malformed input, so a
 * `?start_date=banana` becomes a 400 instead of a Postgres cast error → 500.
 * @param {unknown} value
 * @param {string} [fieldName]
 * @returns {string|null}
 */
export function assertYmd(value, fieldName = 'date') {
  const result = validateDateString(value, fieldName);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

/**
 * Express middleware to validate :id route params.
 * @param {import('../types/express.js').ExpressRequest} req
 * @param {import('../types/express.js').ExpressResponse} res
 * @param {import('../types/express.js').ExpressNextFunction} next
 */
export function validateIdParam(req, res, next) {
  if (req.params.id) {
    const result = validateId(req.params.id);
    if (!result.valid) {
      return next(new ValidationError(result.error));
    }
    // Deliberately re-stamps req.params.id with the PARSED number, not its
    // string form — Express's own typing convention (and this file's
    // ExpressRequest.params: Record<string, string>) says route params are
    // always strings; downstream handlers happen to tolerate a number here
    // (Number(...)/parseInt(...) on it are no-ops), but this is a real,
    // pre-existing type-contract deviation, not something this annotation
    // pass fixes. See orchestrator report.
    req.params.id = /** @type {string} */ (/** @type {unknown} */ (result.value));
  }
  next();
}

/**
 * Per-param variant of validateIdParam for sub-resource ids (`:patternId`,
 * `:accountId`) that the fixed `:id` middleware cannot cover. Same accept set
 * and same parsed-value re-stamp as validateIdParam — see its note on the
 * re-stamp's type-contract deviation.
 * @param {string} name
 * @returns {(req: import('../types/express.js').ExpressRequest, res: import('../types/express.js').ExpressResponse, next: import('../types/express.js').ExpressNextFunction) => void}
 */
export function validateIntParam(name) {
  return (req, res, next) => {
    const result = validateId(req.params[name], name);
    if (!result.valid) {
      return next(new ValidationError(result.error));
    }
    req.params[name] = /** @type {string} */ (/** @type {unknown} */ (result.value));
    next();
  };
}

/**
 * Validate an array of integer IDs (e.g., excluded_category_ids). A scalar is
 * wrapped into a one-element array; every element must satisfy validateId, so
 * the accepted id shapes are identical to the route layer's.
 *
 * Per-element delegation matters more here than on a path param. These arrays
 * feed exclusion and filter sets, not a single-record lookup, so the old
 * `parseInt` element parse did not 404 on a bad value — `["12abc"]` became
 * `[12]` and quietly changed which rows an aggregation covered, with no error
 * surfaced to anyone.
 * @param {unknown} values
 * @param {string} [fieldName]
 * @returns {FieldValidationResult}
 */
export function validateIntArray(values, fieldName = 'ids') {
  /** @type {unknown[]} */
  const list = Array.isArray(values) ? values : [values];
  /** @type {number[]} */
  const result = [];
  for (const v of list) {
    const element = validateId(v, fieldName);
    if (!element.valid) {
      return { valid: false, error: `${fieldName} contains invalid value: ${v}` };
    }
    result.push(element.value);
  }
  return { valid: true, value: result };
}
