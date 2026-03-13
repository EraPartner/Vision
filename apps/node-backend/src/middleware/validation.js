/**
 * Input validation and sanitization middleware.
 * Prevents SQL injection, XSS, and malformed input.
 */

// Whitelist of allowed DB columns per resource type
const ALLOWED_COLUMNS = {
  transactions: new Set([
    'date', 'transaction_date', 'bank_account', 'recipient_id', 'amount',
    'memo', 'currency', 'balance', 'category_id', 'comment', 'is_active',
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
    'recurrence_pattern', 'is_executed', 'is_active', 'last_executed_date',
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
 */
export function sanitizeUpdateFields(resourceType, fields) {
  const allowed = ALLOWED_COLUMNS[resourceType];
  if (!allowed) throw new Error(`Unknown resource type: ${resourceType}`);

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
 * Validate that an ID parameter is a positive integer.
 */
export function validateId(value, fieldName = 'id') {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 1 || num > 2147483647) {
    return { valid: false, error: `${fieldName} must be a positive integer` };
  }
  return { valid: true, value: num };
}

/**
 * Validate and sanitize a string input.
 */
export function sanitizeString(value, maxLength = 500) {
  if (value == null) return null;
  if (typeof value !== 'string') return String(value).slice(0, maxLength);
  return value.trim().slice(0, maxLength);
}

/**
 * Validate numeric values.
 */
export function validateNumber(value, { min = -Infinity, max = Infinity, fieldName = 'value' } = {}) {
  const num = Number(value);
  if (isNaN(num)) {
    return { valid: false, error: `${fieldName} must be a number` };
  }
  if (num < min || num > max) {
    return { valid: false, error: `${fieldName} must be between ${min} and ${max}` };
  }
  return { valid: true, value: num };
}

/**
 * Validate date string format (YYYY-MM-DD).
 */
export function validateDateString(value, fieldName = 'date') {
  if (!value) return { valid: true, value: null };
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(value)) {
    return { valid: false, error: `${fieldName} must be in YYYY-MM-DD format` };
  }
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    return { valid: false, error: `${fieldName} is not a valid date` };
  }
  return { valid: true, value };
}

/**
 * Validate pagination parameters.
 */
export function validatePagination(limit, offset) {
  const l = parseInt(limit, 10);
  const o = parseInt(offset, 10);
  return {
    limit: isNaN(l) || l < 1 ? 50 : Math.min(l, 5000),
    offset: isNaN(o) || o < 0 ? 0 : o,
  };
}

/**
 * Express middleware to validate :id route params.
 */
export function validateIdParam(req, res, next) {
  if (req.params.id) {
    const result = validateId(req.params.id);
    if (!result.valid) {
      return res.status(400).json({ detail: result.error });
    }
    req.params.id = result.value;
  }
  next();
}

/**
 * Validate an array of integer IDs (e.g., excluded_category_ids).
 */
export function validateIntArray(values, fieldName = 'ids') {
  if (!Array.isArray(values)) values = [values];
  const result = [];
  for (const v of values) {
    const num = parseInt(v, 10);
    if (isNaN(num) || num < 1 || num > 2147483647) {
      return { valid: false, error: `${fieldName} contains invalid value: ${v}` };
    }
    result.push(num);
  }
  return { valid: true, value: result };
}
