/**
 * Text Normalization Service Tests
 * Mirrors: apps/backend/tests/test_text_normalization_service.py
 */

import { describe, it, expect } from 'vitest';
import {
  cleanRecipientName,
  cleanKbcRecipientName,
  normalizeToUppercase,
  normalizeForMatching,
  formatAmountString,
  extractCurrencyCode,
} from '../src/lib/textNormalization.js';

describe('TextNormalizationService', () => {
  describe('cleanRecipientName', () => {
    it('removes "Payment from" prefix', () => {
      expect(cleanRecipientName('Payment from John Smith')).toBe('John Smith');
    });

    it('removes "Payment to" prefix', () => {
      expect(cleanRecipientName('Payment to Jane Doe')).toBe('Jane Doe');
    });

    it('is case-insensitive', () => {
      expect(cleanRecipientName('PAYMENT FROM ACME CORP')).toBe('ACME CORP');
    });

    it('strips whitespace', () => {
      expect(cleanRecipientName('  John Smith  ')).toBe('John Smith');
    });

    it('leaves names without prefixes unchanged', () => {
      expect(cleanRecipientName('John Smith')).toBe('John Smith');
    });

    it('handles empty string', () => {
      expect(cleanRecipientName('')).toBe('');
    });

    it('handles null', () => {
      expect(cleanRecipientName(null)).toBe(null);
    });

    it('removes "Transfer from" prefix', () => {
      expect(cleanRecipientName('Transfer from Account 123')).toBe('Account 123');
    });

    it('removes "Sent to" prefix', () => {
      expect(cleanRecipientName('Sent to Vendor ABC')).toBe('Vendor ABC');
    });

    it('removes "Received from" prefix', () => {
      expect(cleanRecipientName('Received from Client XYZ')).toBe('Client XYZ');
    });
  });

  describe('cleanKbcRecipientName', () => {
    it('extracts GELDOPNEMING', () => {
      expect(cleanKbcRecipientName('GELDOPNEMING VIA BANCONTACT 26-09...')).toBe('Geldopneming');
    });

    it('extracts OVERSCHRIJVING', () => {
      expect(cleanKbcRecipientName('OVERSCHRIJVING NAAR BE12345...')).toBe('Overschrijving');
    });

    it('extracts AANKOOP', () => {
      expect(cleanKbcRecipientName('AANKOOP MET DEBETKAART BIJ Store Name...')).toBe('Aankoop');
    });

    it('handles no match - returns first word', () => {
      const result = cleanKbcRecipientName('Some Random Transaction Description');
      expect(result).toContain('Some');
    });

    it('handles null', () => {
      expect(cleanKbcRecipientName(null)).toBe(null);
    });

    it('handles empty string', () => {
      expect(cleanKbcRecipientName('')).toBe('');
    });
  });

  describe('normalizeToUppercase', () => {
    it('converts to uppercase', () => {
      expect(normalizeToUppercase('john smith')).toBe('JOHN SMITH');
    });

    it('strips whitespace', () => {
      expect(normalizeToUppercase('  ABC Corp  ')).toBe('ABC CORP');
    });

    it('handles null', () => {
      expect(normalizeToUppercase(null)).toBe(null);
    });

    it('throws on non-string', () => {
      expect(() => normalizeToUppercase(123)).toThrow();
    });
  });

  describe('normalizeForMatching', () => {
    it('sorts tokens alphabetically', () => {
      expect(normalizeForMatching('Smith John')).toBe('JOHN SMITH');
    });

    it('filters single-letter initials', () => {
      expect(normalizeForMatching('John F Doe')).toBe('DOE JOHN');
    });

    it('keeps numbers', () => {
      expect(normalizeForMatching('Test Recipient 1')).toBe('1 RECIPIENT TEST');
    });

    it('handles single word', () => {
      expect(normalizeForMatching('STORE')).toBe('STORE');
    });

    it('handles null', () => {
      expect(normalizeForMatching(null)).toBe(null);
    });
  });

  describe('formatAmountString', () => {
    it('parses simple amount', () => {
      expect(formatAmountString('100.50')).toBe(100.50);
    });

    it('handles comma decimal separator', () => {
      expect(formatAmountString('100,50')).toBe(100.50);
    });

    it('handles null', () => {
      expect(formatAmountString(null)).toBe(null);
    });

    it('handles empty string', () => {
      expect(formatAmountString('')).toBe(null);
    });
  });

  describe('extractCurrencyCode', () => {
    it('extracts simple code', () => {
      expect(extractCurrencyCode('EUR')).toBe('EUR');
    });

    it('extracts from amount string', () => {
      expect(extractCurrencyCode('100.00 EUR')).toBe('EUR');
    });

    it('normalizes to uppercase', () => {
      expect(extractCurrencyCode('eur')).toBe('EUR');
    });

    it('handles null', () => {
      expect(extractCurrencyCode(null)).toBe(null);
    });

    it('returns null for non-currency', () => {
      expect(extractCurrencyCode('Just some text')).toBe(null);
    });
  });
});
