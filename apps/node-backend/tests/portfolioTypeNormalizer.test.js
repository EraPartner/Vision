import { describe, it, expect } from 'vitest';
import { normalizeType, VALID_PORTFOLIO_TXN_TYPES } from '../src/services/portfolioImportPipeline/portfolioTypeNormalizer.js';

describe('normalizeType', () => {
  it('resolves built-in aliases case-insensitively', () => {
    expect(normalizeType('Buy')).toEqual({ type: 'buy' });
    expect(normalizeType('BUY')).toEqual({ type: 'buy' });
    expect(normalizeType('purchase')).toEqual({ type: 'buy' });
    expect(normalizeType('koop')).toEqual({ type: 'buy' });
    expect(normalizeType('Sell')).toEqual({ type: 'sell' });
    expect(normalizeType('verkoop')).toEqual({ type: 'sell' });
    expect(normalizeType('div')).toEqual({ type: 'dividend' });
    expect(normalizeType('Commission')).toEqual({ type: 'fee' });
  });

  it('lets a user mapping win over the built-in aliases', () => {
    expect(normalizeType('Buy', { typeMapping: { Buy: 'dividend' } })).toEqual({ type: 'dividend' });
    // case-insensitive mapping key
    expect(normalizeType('FOO', { typeMapping: { foo: 'sell' } })).toEqual({ type: 'sell' });
  });

  it('errors when a user mapping points at an invalid type', () => {
    const result = normalizeType('Buy', { typeMapping: { Buy: 'not_a_type' } });
    expect(result.error).toMatch(/not a valid/);
    expect(result.type).toBeUndefined();
  });

  it('passes through a value that is already canonical', () => {
    expect(normalizeType('rent_income')).toEqual({ type: 'rent_income' });
    expect(normalizeType('RETURN_OF_CAPITAL')).toEqual({ type: 'return_of_capital' });
  });

  it('uses the default type only when there is no value', () => {
    expect(normalizeType('', { defaultType: 'buy' })).toEqual({ type: 'buy' });
    expect(normalizeType(undefined, { defaultType: 'dividend' })).toEqual({ type: 'dividend' });
  });

  it('errors on a missing value with no default', () => {
    expect(normalizeType('').error).toMatch(/missing/);
  });

  it('errors on a present-but-unknown value instead of silently defaulting', () => {
    const result = normalizeType('Reinvestment', { defaultType: 'buy' });
    expect(result.error).toMatch(/unknown transaction type/);
    expect(result.type).toBeUndefined();
  });

  it('exposes the canonical type set', () => {
    expect(VALID_PORTFOLIO_TXN_TYPES.has('buy')).toBe(true);
    expect(VALID_PORTFOLIO_TXN_TYPES.has('split')).toBe(true);
    expect(VALID_PORTFOLIO_TXN_TYPES.has('nonsense')).toBe(false);
  });
});
