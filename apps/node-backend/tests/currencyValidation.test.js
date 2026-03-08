/**
 * Currency validation tests.
 * Mirrors: apps/backend/tests/test_currency_validation.py
 *
 * Tests that currency codes are properly validated.
 */
import { describe, it, expect } from 'vitest';

const SUPPORTED_CURRENCIES = [
  'EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'TRY', 'RUB', 'CNY', 'INR',
  'BRL', 'ZAR', 'MXN', 'SGD', 'HKD', 'NZD', 'KRW', 'THB',
];

/**
 * Validate a currency code.
 * @param {string|null} currency
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCurrency(currency) {
  if (currency === null || currency === undefined) {
    return { valid: true }; // null is allowed
  }
  if (typeof currency !== 'string') {
    return { valid: false, error: 'Currency must be a string' };
  }
  const trimmed = currency.trim().toUpperCase();
  if (trimmed.length !== 3) {
    return { valid: false, error: 'Currency code must be exactly 3 characters' };
  }
  if (!SUPPORTED_CURRENCIES.includes(trimmed)) {
    return { valid: false, error: `Unsupported currency code: ${trimmed}. Supported currencies: ${SUPPORTED_CURRENCIES.join(', ')}` };
  }
  return { valid: true, normalized: trimmed };
}

describe('Currency Validation', () => {
  it('should accept valid currency codes', () => {
    for (const code of ['EUR', 'USD', 'GBP', 'JPY', 'CHF']) {
      expect(validateCurrency(code).valid).toBe(true);
    }
  });

  it('should normalize lowercase to uppercase', () => {
    const result = validateCurrency('eur');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('EUR');
  });

  it('should reject invalid currency codes', () => {
    const result = validateCurrency('XYZ');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported currency code');
    expect(result.error).toContain('XYZ');
  });

  it('should reject wrong length codes', () => {
    expect(validateCurrency('EU').valid).toBe(false);
    expect(validateCurrency('EU').error).toContain('exactly 3 characters');

    expect(validateCurrency('EURO').valid).toBe(false);
    expect(validateCurrency('EURO').error).toContain('exactly 3 characters');
  });

  it('should accept null currency', () => {
    expect(validateCurrency(null).valid).toBe(true);
    expect(validateCurrency(undefined).valid).toBe(true);
  });

  it('should have common currencies in supported list', () => {
    expect(SUPPORTED_CURRENCIES).toContain('EUR');
    expect(SUPPORTED_CURRENCIES).toContain('USD');
    expect(SUPPORTED_CURRENCIES).toContain('GBP');
    expect(SUPPORTED_CURRENCIES.length).toBeGreaterThan(0);
  });

  it('should include supported currencies in error message', () => {
    const result = validateCurrency('ZZZ');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Supported currencies:');
    expect(result.error).toContain('EUR');
  });
});
