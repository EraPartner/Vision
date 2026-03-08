/**
 * IBAN validation tests.
 * Mirrors: apps/backend/tests/test_iban.py
 */
import { describe, it, expect } from 'vitest';
import { isValidIban, normalizeIban } from '../src/services/iban.js';

const VALID_IBANS = [
  'BE68539007547034',
  'BE68 5390 0754 7034',
  'GB82 WEST 1234 5698 7654 32',
  'DE89 3704 0044 0532 0130 00',
  'FR14 2004 1010 0505 0001 3M02 606',
  'NL91 ABNA 0417 1643 00',
];

const INVALID_IBANS = [
  'BE00 0000 0000 0000',
  'GB00 WEST 1234 5698 7654 32',
  'INVALIDIBAN12345',
  '',
  'DE8937040044053201300X',
];

describe('IBAN Validation', () => {
  describe('isValidIban', () => {
    it('should accept valid IBANs', () => {
      for (const iban of VALID_IBANS) {
        expect(isValidIban(iban), `Expected valid: ${iban}`).toBe(true);
      }
    });

    it('should reject invalid IBANs', () => {
      for (const iban of INVALID_IBANS) {
        expect(isValidIban(iban), `Expected invalid: ${iban}`).toBe(false);
      }
    });

    it('should handle null/undefined', () => {
      expect(isValidIban(null)).toBe(false);
      expect(isValidIban(undefined)).toBe(false);
    });
  });

  describe('normalizeIban', () => {
    it('should normalize to uppercase without spaces', () => {
      expect(normalizeIban('be68 5390 0754 7034')).toBe('BE68539007547034');
    });

    it('should handle empty/null input', () => {
      expect(normalizeIban('')).toBe('');
      expect(normalizeIban(null)).toBe('');
    });
  });
});
