---
title: Input Validation
type: security
status: active
date: 2026-04-25
tags: [security, validation, sanitization, csv, formula-injection, cwe-1236]
description: Input validation and sanitization mechanisms to prevent SQL injection, XSS, formula injection in CSV exports, and malformed data
aliases: [input validation, sanitization, sql injection, xss, validation middleware, csv formula injection, cwe-1236]
related_code: ["apps/node-backend/src/middleware/validation.js", "apps/node-backend/src/lib/csv.js"]
---

# Input Validation

Vision implements comprehensive input validation to prevent SQL injection, XSS attacks, and malformed data. All user inputs are validated before being processed or stored.

## Overview

The validation middleware (`validation.js`) provides centralized input validation for all API endpoints. It uses a whitelist approach to ensure only valid data enters the system.

## Validation Functions

### ID Validation

Validates that an ID parameter is a positive 32-bit integer.

```javascript
validateId(value, fieldName = 'id')
```

**Rules:**
- Must be a positive integer (1 to 2,147,483,647)
- Cannot be NaN

**Returns:**
```javascript
{ valid: true, value: 123 }  // Success
{ valid: false, error: "id must be a positive integer" }  // Failure
```

---

### String Sanitization

Sanitizes string inputs by trimming whitespace and enforcing maximum length.

```javascript
sanitizeString(value, maxLength = 500)
```

**Rules:**
- Converts non-strings to strings
- Trims whitespace
- Enforces maximum length
- Returns `null` for null/undefined inputs

---

### Numeric Validation

Validates numeric values against min/max bounds.

```javascript
validateNumber(value, { min = -Infinity, max = Infinity, fieldName = 'value' })
```

**Rules:**
- Must be a valid number
- Must be within specified range (inclusive)

---

### Date Validation

Validates date strings in ISO format (YYYY-MM-DD).

```javascript
validateDateString(value, fieldName = 'date')
```

**Rules:**
- Must match `^\d{4}-\d{2}-\d{2}$` pattern
- Must be a valid date

---

### Array Validation

Validates arrays of integer IDs.

```javascript
validateIntArray(values, fieldName = 'ids')
```

**Rules:**
- Each element must be a positive integer
- Works with single values or arrays

---

### Pagination Validation

Validates and normalizes pagination parameters.

```javascript
validatePagination(limit, offset)
```

**Rules:**
- Limit: defaults to 50, max 5000
- Offset: defaults to 0, min 0

---

## Column Whitelisting

To prevent SQL injection through dynamic column names, Vision uses a whitelist approach:

```javascript
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
  // ... other resources
};
```

### sanitizeUpdateFields()

This function filters update requests to only include allowed columns:

```javascript
sanitizeUpdateFields('transactions', { amount: 100, unknown_field: 'bad' })
// Returns: { amount: 100 }
// unknown_field is silently dropped
```

---

## Express Middleware

### validateIdParam

Express middleware for validating `:id` route parameters:

```javascript
router.get('/:id', validateIdParam, async (req, res) => {
  // req.params.id is now a validated integer
});
```

---

## Best Practices

1. **Always validate user input** - Never trust client data
2. **Use type-specific validators** - Different data types need different validation
3. **Set appropriate limits** - Prevent buffer overflow and DoS
4. **Return clear error messages** - Help clients fix their requests
5. **Log validation failures** - Monitor for potential attacks

---

## CSV Formula Injection Prevention (CWE-1236)

CSV exports are vulnerable to formula injection when user-controllable data (recipient name, memo, comments) is written without sanitization. Attackers can craft malicious data that auto-executes in Excel or Google Sheets:

```
Malicious cell value: =cmd|'/c powershell ...'
Result when opened: Arbitrary code execution
```

### Prevention

All CSV exports use a centralized utility that prefixes dangerous leading characters (`=`, `+`, `-`, `@`, `\t` (tab), `\r` (carriage return)) with a single quote, rendering them as literal text. The check strips surrounding whitespace first to catch cases like `  = formula`:

```
Example: "  =formula" → trimmed to "=formula" → prefixed to "'=formula" (rendered as literal text)
```

**Implementation:** [[apps/node-backend/src/lib/csv.js|lib/csv.js]]

```js
export function escapeCsvValue(value) {
  if (value == null) return '';
  const stringValue = neutralizeCsvFormula(String(value));
  // Escape quotes and wrap if needed
  return stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}
```

### Usage Rule

Every CSV export route **must** pass all user-controllable fields through `escapeCsvValue()`:

```js
import { escapeCsvValue } from '../lib/csv.js';

// Transaction export
const cols = [row.date, row.recipient_name, row.memo, row.comment];
const csv = cols.map(escapeCsvValue).join(',');

// Splits/owed transactions export
const cols = [row.recipient_name, row.memo, row.amount];
const csv = cols.map(escapeCsvValue).join(',');
```

### Compliance

- [[apps/node-backend/src/routes/transactions.js]] — `GET /api/transactions/export/csv` ✓
- [[apps/node-backend/src/routes/splits.js]] — `GET /api/splits/owed/:id/export/csv` ✓

---

## Related Security Topics

- [[docs/security/rate-limiting]] - Rate limiting to prevent abuse
- [[docs/adr/002-database-schema]] - Database schema design
- [[docs/reference/code-patterns#safe-csv-export-pattern-phase-5]] - Safe CSV Export Pattern

## See Also

- [[docs/api/index]] - API Index
- [[docs/security/index]] - Security Documentation Index
