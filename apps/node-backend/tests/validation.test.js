/**
 * Validation middleware tests.
 * Mirrors validation-related tests from Python test suite.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  validateId, sanitizeString, validateNumber,
  validateDateString,
  sanitizeUpdateFields, validateIntArray, validateIdParam, validateIntParam,
  assertOptionalId, MAX_INT32_ID, MAX_SAFE_ID,
} from '../src/middleware/validation.js';
import { coercedIdSchema } from '../src/lib/importBatchIds.js';
import { ValidationError } from '../src/middleware/errorHandler.js';

// validateIdParam is unit-tested as a plain middleware function
// (req, res, next) — a minimal res stub is enough; there is no router/HTTP
// path to exercise.
function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('Validation Middleware', () => {
  describe('validateId', () => {
    it('should accept valid positive integers', () => {
      expect(validateId('1')).toEqual({ valid: true, value: 1 });
      expect(validateId('100')).toEqual({ valid: true, value: 100 });
      expect(validateId('2147483647')).toEqual({ valid: true, value: 2147483647 });
    });

    it('should reject invalid IDs', () => {
      expect(validateId('0').valid).toBe(false);
      expect(validateId('-1').valid).toBe(false);
      expect(validateId('abc').valid).toBe(false);
      expect(validateId('').valid).toBe(false);
      expect(validateId('999999999999').valid).toBe(false);
    });

    // The accept set is the contract, so it is pinned exhaustively rather than
    // left implied by the routes. validateId was `parseInt`-based, which took
    // the leading digits of anything — "12abc"/"12.5" resolved to id 12 and
    // "1e3" to id 1, silently addressing a record the client never named.
    // A bare Number() is not the fix either: it takes "0x10" as 16, "1e3" as
    // 1000 and leaves "12.5" a non-integer that reaches Postgres. Hence a
    // strict digit-string parse. If one of these flips, the API's accept set
    // changed — that is a breaking contract change, not a test to relax.
    it('accepts only a plain base-10 positive integer within int32', () => {
      for (const ok of ['1', '42', '00005', '2147483647']) {
        expect(validateId(ok).valid, `expected ${JSON.stringify(ok)} to be accepted`).toBe(true);
      }
      expect(validateId('00005').value).toBe(5);

      const rejected = [
        '12abc',      // trailing garbage — the headline case
        '5px',
        '12.5',       // decimals: parseInt truncated, Number() kept 12.5
        '5.0',
        '1e3',        // exponent: parseInt gave 1, Number() gives 1000
        '0x10',       // hex / octal / binary literals
        '0o17',
        '0b11',
        '+5',         // signs and separators
        '-5',
        '12,5',
        '1_0',
        '',           // empty / whitespace-only (Number() maps both to 0)
        '   ',
        ' 5 ',        // whitespace-padded
        '\n7\n',
        'Infinity',
        'NaN',
        '0',          // out of range
        '2147483648',
        '999999999999',
        '١٢', // non-ASCII digits
      ];
      for (const bad of rejected) {
        expect(validateId(bad).valid, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
      }
    });

    it('accepts an integer number but not a float, boolean, array or object', () => {
      // Numbers matter because validateIdParam re-stamps req.params with the
      // parsed integer, and because JSON bodies (splits.js) send real numbers.
      expect(validateId(42)).toEqual({ valid: true, value: 42 });
      for (const bad of [5.7, NaN, Infinity, -Infinity, 0, -3, true, false, [], ['5'], {}, null, undefined]) {
        expect(validateId(bad).valid, `expected ${String(bad)} to be rejected`).toBe(false);
      }
    });

    it('names the offending field in the error', () => {
      expect(validateId('12abc', 'patternId').error).toBe('patternId must be a positive integer');
    });
  });

  describe('assertOptionalId', () => {
    it('returns null for absent/empty values', () => {
      expect(assertOptionalId(undefined, 'account_id')).toBeNull();
      expect(assertOptionalId(null, 'account_id')).toBeNull();
      expect(assertOptionalId('', 'account_id')).toBeNull();
    });

    it('returns the parsed integer for a valid id', () => {
      expect(assertOptionalId('42', 'account_id')).toBe(42);
    });

    it('throws ValidationError for malformed input (would otherwise reach pg as NaN → 500)', () => {
      expect(() => assertOptionalId('abc', 'account_id')).toThrow(ValidationError);
      expect(() => assertOptionalId('0', 'account_id')).toThrow(ValidationError);
      expect(() => assertOptionalId('-3', 'account_id')).toThrow(ValidationError);
    });
  });

  describe('sanitizeString', () => {
    it('should trim and limit length', () => {
      expect(sanitizeString('  hello  ')).toBe('hello');
      expect(sanitizeString('a'.repeat(1000), 10)).toBe('a'.repeat(10));
    });

    it('should handle null/undefined', () => {
      expect(sanitizeString(null)).toBeNull();
      expect(sanitizeString(undefined)).toBeNull();
    });

    it('should convert non-strings', () => {
      expect(sanitizeString(123)).toBe('123');
    });
  });

  describe('validateNumber', () => {
    it('should accept valid numbers', () => {
      expect(validateNumber('42')).toEqual({ valid: true, value: 42 });
      expect(validateNumber('-10.5')).toEqual({ valid: true, value: -10.5 });
    });

    it('should reject non-numbers', () => {
      expect(validateNumber('abc').valid).toBe(false);
    });

    it('should enforce min/max', () => {
      expect(validateNumber('5', { min: 1, max: 10 })).toEqual({ valid: true, value: 5 });
      expect(validateNumber('15', { min: 1, max: 10 }).valid).toBe(false);
    });
  });

  describe('validateDateString', () => {
    it('should accept valid YYYY-MM-DD dates', () => {
      expect(validateDateString('2026-01-15')).toEqual({ valid: true, value: '2026-01-15' });
    });

    it('should reject invalid dates', () => {
      expect(validateDateString('invalid-date').valid).toBe(false);
      expect(validateDateString('15/01/2026').valid).toBe(false);
      expect(validateDateString('2026-13-01').valid).toBe(false);
    });

    it('should accept null/empty', () => {
      expect(validateDateString(null)).toEqual({ valid: true, value: null });
      expect(validateDateString('')).toEqual({ valid: true, value: null });
    });
  });

  describe('sanitizeUpdateFields', () => {
    it('should only allow whitelisted columns for transactions', () => {
      const result = sanitizeUpdateFields('transactions', {
        amount: -50, memo: 'test', injection_field: 'DROP TABLE',
      });
      expect(result).toHaveProperty('amount');
      expect(result).toHaveProperty('memo');
      expect(result).not.toHaveProperty('injection_field');
    });

    it('should only allow whitelisted columns for categories', () => {
      const result = sanitizeUpdateFields('categories', {
        general: 'FOOD', detail: 'GROCERIES', evil: 'injection',
      });
      expect(result).toHaveProperty('general');
      expect(result).not.toHaveProperty('evil');
    });

    it('should throw for unknown resource type', () => {
      expect(() => sanitizeUpdateFields('unknown_table', { field: 'value' }))
        .toThrow('Unknown resource type');
    });

    it('keeps reminder_days_before for planned_transactions (was silently dropped)', () => {
      const result = sanitizeUpdateFields('planned_transactions', {
        reminder_days_before: 3, injection_field: 'DROP TABLE',
      });
      expect(result).toHaveProperty('reminder_days_before', 3);
      expect(result).not.toHaveProperty('injection_field');
    });
  });

  describe('validateIntArray', () => {
    it('should accept valid integer arrays', () => {
      expect(validateIntArray([1, 2, 3])).toEqual({ valid: true, value: [1, 2, 3] });
    });

    it('should convert single values to array', () => {
      expect(validateIntArray(5)).toEqual({ valid: true, value: [5] });
    });

    it('should reject invalid values', () => {
      expect(validateIntArray([1, 'abc', 3]).valid).toBe(false);
      expect(validateIntArray([0]).valid).toBe(false);
    });

    // Each element goes through validateId, so this is the same accept set the
    // routes enforce — pinned here rather than left implied, because these
    // arrays are exclusion/filter sets, not record lookups. The element parse
    // was `parseInt`, so `["12abc"]` became `[12]`: no 404, no error, just a
    // different set of rows in the aggregation than the client asked for.
    // If one of these flips, the API's accept set changed.
    it('accepts only plain base-10 positive integers per element', () => {
      expect(validateIntArray(['1', '00005', 2147483647]).value).toEqual([1, 5, 2147483647]);

      const rejected = [
        '12abc',      // trailing garbage — the headline case
        '5px',
        '12.5',       // decimals: parseInt truncated to 12
        '5.0',
        '1e3',        // exponent: parseInt gave 1, Number() gives 1000
        '0x10', '0o17', '0b11',
        '+5', '-5', '12,5', '1_0',
        '', '   ', ' 5 ', '\n7\n',
        'Infinity', 'NaN',
        '0', '2147483648', '999999999999',
        '١٢',
        5.7, true, false, [], {}, null, undefined, NaN,
      ];
      for (const bad of rejected) {
        expect(validateIntArray([1, bad]).valid, `expected ${JSON.stringify(bad)} to be rejected`)
          .toBe(false);
      }
    });

    // A single bad element rejects the whole array — no partial/filtered set
    // reaches the query, which is what made the old truncation invisible.
    it('rejects the whole array on one bad element and names the value', () => {
      const result = validateIntArray([1, '12abc', 3], 'excludedCategoryIds');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('excludedCategoryIds contains invalid value: 12abc');
      expect(result.value).toBeUndefined();
    });

    it('accepts an empty array and a scalar digit string', () => {
      expect(validateIntArray([])).toEqual({ valid: true, value: [] });
      expect(validateIntArray('7')).toEqual({ valid: true, value: [7] });
    });
  });

  // Finding: the repo carried two canonical id validators with disagreeing
  // accept sets. coercedIdSchema (import batch/row ids) now delegates to
  // validateId, so the shape rule has one definition; the only intended
  // difference is the bound, because import_batches.id is BIGSERIAL while
  // every id validateId guards by default is int4.
  describe('coercedIdSchema agrees with validateId', () => {
    const parse = (v) => coercedIdSchema.safeParse(v);

    it('agrees with validateId on every shape', () => {
      const shapes = [
        '1', '42', '00005', '2147483647',
        '12abc', '5px', '12.5', '5.0', '12.0', '1e3', '1e300',
        '0x10', '0o17', '0b11', '+5', '-5', '12,5', '1_0',
        '', '   ', ' 5 ', '\n7\n', 'Infinity', 'NaN', '0', '١٢',
        42, 5.7, 0, -3, true, false, [], ['5'], {}, null, undefined, NaN,
      ];
      for (const v of shapes) {
        const strict = validateId(v, 'id', MAX_SAFE_ID);
        const coerced = parse(v);
        expect(coerced.success, `disagreed on ${JSON.stringify(v)}`).toBe(strict.valid);
        if (strict.valid) expect(coerced.data).toBe(strict.value);
      }
    });

    it('is bounded to MAX_SAFE_ID, not int32, because batch ids are BIGSERIAL', () => {
      // Above int4 is a legal BIGSERIAL row, so it must parse rather than 400.
      expect(parse(String(MAX_INT32_ID + 1)).data).toBe(2147483648);
      expect(validateId(String(MAX_INT32_ID + 1)).valid).toBe(false);

      expect(parse(String(MAX_SAFE_ID)).data).toBe(MAX_SAFE_ID);
      // Past 2^53 the digit string and the parsed number stop being the same
      // value — '9007199254740993' would address record …992.
      expect(parse('9007199254740993').success).toBe(false);
      expect(parse('99999999999999999999').success).toBe(false);
    });
  });

  describe('validateIdParam', () => {
    it('calls next when req.params.id is missing', () => {
      const req = { params: {} };
      const res = mockResponse();
      const next = vi.fn();

      validateIdParam(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next with ValidationError for invalid id and does not touch res', () => {
      const req = { params: { id: 'abc' } };
      const res = mockResponse();
      const next = vi.fn();

      validateIdParam(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toBeInstanceOf(ValidationError);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('coerces valid id to number and calls next', () => {
      const req = { params: { id: '123' } };
      const res = mockResponse();
      const next = vi.fn();

      validateIdParam(req, res, next);

      expect(req.params.id).toBe(123);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    // The whole point of the finding: a coercible-looking id must 400, not
    // resolve to the record its leading digits happen to name.
    it('rejects loosely-coercible ids rather than truncating them to a record', () => {
      for (const id of ['12abc', '12.5', '1e3', '0x10', ' 5 ', '+5']) {
        const req = { params: { id } };
        const next = vi.fn();
        validateIdParam(req, mockResponse(), next);
        expect(next.mock.calls[0][0], `expected ${JSON.stringify(id)} to be rejected`)
          .toBeInstanceOf(ValidationError);
        expect(req.params.id).toBe(id);
      }
    });

    // validateIdParam re-stamps req.params.id as a number, so a second pass
    // over an already-validated request (nested/stacked guards) must not 400.
    it('is idempotent over an already-parsed numeric param', () => {
      const req = { params: { id: 123 } };
      const next = vi.fn();
      validateIdParam(req, mockResponse(), next);
      expect(next).toHaveBeenCalledWith();
      expect(req.params.id).toBe(123);
    });
  });

  describe('validateIntParam', () => {
    it('validates the named sub-resource param with the same accept set', () => {
      const guard = validateIntParam('patternId');

      const good = { params: { id: 1, patternId: '7' } };
      const next = vi.fn();
      guard(good, mockResponse(), next);
      expect(good.params.patternId).toBe(7);
      expect(next).toHaveBeenCalledWith();

      for (const patternId of ['12abc', '12.5', '1e3', '0', '-1', '', '2147483648']) {
        const bad = { params: { id: 1, patternId } };
        const badNext = vi.fn();
        guard(bad, mockResponse(), badNext);
        expect(badNext.mock.calls[0][0], `expected ${JSON.stringify(patternId)} to be rejected`)
          .toBeInstanceOf(ValidationError);
        expect(badNext.mock.calls[0][0].message).toBe('patternId must be a positive integer');
      }
    });

    it('rejects a missing param instead of passing undefined through', () => {
      const next = vi.fn();
      validateIntParam('accountId')({ params: {} }, mockResponse(), next);
      expect(next.mock.calls[0][0]).toBeInstanceOf(ValidationError);
    });
  });

  describe('assertOptionalId — strict accept set', () => {
    it('throws for loosely-coercible query ids', () => {
      for (const v of ['12abc', '12.5', '1e3', ' 5 ']) {
        expect(() => assertOptionalId(v, 'account_id'), `expected ${JSON.stringify(v)} to throw`)
          .toThrow(ValidationError);
      }
    });
  });
});
