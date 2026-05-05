import { describe, expect, test } from 'vitest';
import { parseDecimal } from './decimal';

describe('parseDecimal', () => {
  test('handles null/undefined/empty with fallback', () => {
    expect(parseDecimal(null)).toBe(0);
    expect(parseDecimal(undefined)).toBe(0);
    expect(parseDecimal('')).toBe(0);
    expect(parseDecimal(null, 42)).toBe(42);
  });

  test('passes through numbers directly', () => {
    expect(parseDecimal(1234.56)).toBe(1234.56);
    expect(parseDecimal(0)).toBe(0);
    expect(parseDecimal(-99.5)).toBe(-99.5);
  });

  test('returns fallback for non-finite numbers', () => {
    expect(parseDecimal(NaN)).toBe(0);
    expect(parseDecimal(Infinity)).toBe(0);
    expect(parseDecimal(-Infinity, -1)).toBe(-1);
  });

  test('parses US format (period decimal, comma thousands)', () => {
    expect(parseDecimal('1234.56')).toBe(1234.56);
    expect(parseDecimal('1,234.56')).toBe(1234.56);
    expect(parseDecimal('1,234,567.89')).toBe(1234567.89);
  });

  test('parses EU format (comma decimal, period thousands) correctly', () => {
    expect(parseDecimal('1234,56')).toBe(1234.56);
    expect(parseDecimal('1.234,56')).toBe(1234.56);
    expect(parseDecimal('1.234.567,89')).toBe(1234567.89);
  });

  test('parses negative values', () => {
    expect(parseDecimal('-1234.56')).toBe(-1234.56);
    expect(parseDecimal('-1.234,56')).toBe(-1234.56);
  });

  test('returns fallback for unparseable strings', () => {
    expect(parseDecimal('abc')).toBe(0);
    expect(parseDecimal('abc', 99)).toBe(99);
  });
});
