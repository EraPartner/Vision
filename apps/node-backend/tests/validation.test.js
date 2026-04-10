/**
 * Validation middleware tests.
 * Mirrors validation-related tests from Python test suite.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  validateId, sanitizeString, validateNumber,
  validateDateString, validatePagination,
  sanitizeUpdateFields, validateIntArray, validateIdParam,
} from '../src/middleware/validation.js';

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

  describe('validatePagination', () => {
    it('should return defaults for invalid input', () => {
      expect(validatePagination('abc', 'def')).toEqual({ limit: 50, offset: 0 });
    });

    it('should clamp limit to max 5000', () => {
      expect(validatePagination('10000', '0')).toEqual({ limit: 5000, offset: 0 });
    });

    it('should accept valid pagination', () => {
      expect(validatePagination('20', '10')).toEqual({ limit: 20, offset: 10 });
    });

    it('should handle negative offset', () => {
      expect(validatePagination('50', '-5')).toEqual({ limit: 50, offset: 0 });
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

    it('returns 400 with detail for invalid id and does not call next', () => {
      const req = { params: { id: 'abc' } };
      const res = mockResponse();
      const next = vi.fn();

      validateIdParam(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'id must be a positive integer' });
      expect(next).not.toHaveBeenCalled();
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
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
