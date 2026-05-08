import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import {
  hasPortfolioTransactionInheritanceSchema,
  markInheritanceSchemaPresent,
  markInheritanceSchemaAbsent,
  __resetPortfolioTransactionSchemaCache,
  isNonUpdatablePortfolioTransactionsViewError,
  isMissingInheritanceRelationError,
  TRANSACTION_TABLE_BY_ASSET_CLASS,
  UNIT_BASED_ASSET_CLASSES,
  buildListWhereClause,
  makeValidationError,
  normalizeTransactionPayload,
  validateSellUnitsAvailability,
  BASE_ALLOWED_FIELDS,
  CHILD_ALLOWED_FIELDS_BY_ASSET_CLASS,
} from '../src/repositories/portfolioTxRepo.common.js';

beforeEach(() => {
  vi.clearAllMocks();
  __resetPortfolioTransactionSchemaCache();
});

afterEach(() => __resetPortfolioTransactionSchemaCache());

describe('schema cache', () => {
  it('queries Postgres on first probe and caches result', async () => {
    query.mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: 'public.portfolio_transactions_base' }] });
    expect(await hasPortfolioTransactionInheritanceSchema()).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);

    // Second call should not re-query.
    expect(await hasPortfolioTransactionInheritanceSchema()).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('caches absence (null result)', async () => {
    query.mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: null }] });
    expect(await hasPortfolioTransactionInheritanceSchema()).toBe(false);
  });

  it('mark helpers override the cache', async () => {
    markInheritanceSchemaAbsent();
    expect(await hasPortfolioTransactionInheritanceSchema()).toBe(false);
    expect(query).not.toHaveBeenCalled();

    markInheritanceSchemaPresent();
    expect(await hasPortfolioTransactionInheritanceSchema()).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('reset clears the cache', async () => {
    markInheritanceSchemaPresent();
    __resetPortfolioTransactionSchemaCache();
    query.mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: 'present' }] });
    await hasPortfolioTransactionInheritanceSchema();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('error classifiers', () => {
  it('isNonUpdatablePortfolioTransactionsViewError matches view-update messages', () => {
    expect(isNonUpdatablePortfolioTransactionsViewError({ message: 'cannot update view "portfolio_transactions"' })).toBe(true);
    expect(isNonUpdatablePortfolioTransactionsViewError({ message: 'cannot insert into view "portfolio_transactions"' })).toBe(true);
    expect(isNonUpdatablePortfolioTransactionsViewError({ message: 'cannot delete from view "portfolio_transactions"' })).toBe(true);
    expect(isNonUpdatablePortfolioTransactionsViewError({ message: 'something else' })).toBe(false);
    expect(isNonUpdatablePortfolioTransactionsViewError(null)).toBe(false);
  });

  it('isMissingInheritanceRelationError catches code 42P01', () => {
    expect(isMissingInheritanceRelationError({ code: '42P01' })).toBe(true);
  });

  it('isMissingInheritanceRelationError catches each missing-relation message', () => {
    for (const tableName of [
      'portfolio_transactions_base',
      'stock_transactions',
      'etf_transactions',
      'crypto_transactions',
      'metals_transactions',
      'real_estate_transactions',
      'savings_transactions',
      'bond_transactions',
    ]) {
      expect(isMissingInheritanceRelationError({ message: `relation "${tableName}" does not exist` })).toBe(true);
    }
  });

  it('isMissingInheritanceRelationError returns false on unrelated errors', () => {
    expect(isMissingInheritanceRelationError({ code: '23505' })).toBe(false);
    expect(isMissingInheritanceRelationError({ message: 'syntax error' })).toBe(false);
    expect(isMissingInheritanceRelationError(null)).toBe(false);
  });
});

describe('asset class maps', () => {
  it('TRANSACTION_TABLE_BY_ASSET_CLASS covers all expected classes', () => {
    expect(Object.keys(TRANSACTION_TABLE_BY_ASSET_CLASS)).toEqual([
      'stock', 'etf', 'crypto', 'metals', 'real_estate', 'savings', 'bond',
    ]);
  });

  it('UNIT_BASED_ASSET_CLASSES includes the unit-based classes only', () => {
    for (const c of ['stock', 'etf', 'crypto', 'metals']) {
      expect(UNIT_BASED_ASSET_CLASSES.has(c)).toBe(true);
    }
    for (const c of ['real_estate', 'savings', 'bond']) {
      expect(UNIT_BASED_ASSET_CLASSES.has(c)).toBe(false);
    }
  });
});

describe('buildListWhereClause', () => {
  it('returns the trivial WHERE 1=1 with empty filters', () => {
    expect(buildListWhereClause()).toEqual({ where: 'WHERE 1=1', params: [], nextParam: 1 });
  });

  it('appends investment_id filter', () => {
    const r = buildListWhereClause({ investmentId: 7 });
    expect(r.where).toBe('WHERE 1=1 AND investment_id = $1');
    expect(r.params).toEqual([7]);
    expect(r.nextParam).toBe(2);
  });

  it('appends type filter', () => {
    const r = buildListWhereClause({ type: 'buy' });
    expect(r.where).toBe('WHERE 1=1 AND type = $1');
    expect(r.params).toEqual(['buy']);
  });

  it('appends both with sequential parameters', () => {
    const r = buildListWhereClause({ investmentId: 7, type: 'sell' });
    expect(r.where).toBe('WHERE 1=1 AND investment_id = $1 AND type = $2');
    expect(r.params).toEqual([7, 'sell']);
    expect(r.nextParam).toBe(3);
  });
});

describe('makeValidationError', () => {
  it('attaches VALIDATION_ERROR code', () => {
    const err = makeValidationError('bad input');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('bad input');
  });
});

describe('normalizeTransactionPayload — buy/sell on unit-based assets', () => {
  it('derives amount from units * price', () => {
    const r = normalizeTransactionPayload(
      { type: 'buy', units: 5, price_per_unit: 100 },
      { assetClass: 'stock' },
    );
    expect(r).toMatchObject({ amount: 500, units: 5, price_per_unit: 100 });
  });

  it('derives units from amount / price', () => {
    const r = normalizeTransactionPayload(
      { type: 'sell', amount: 250, price_per_unit: 50 },
      { assetClass: 'etf' },
    );
    expect(r.units).toBe(5);
  });

  it('derives price from amount / units', () => {
    const r = normalizeTransactionPayload(
      { type: 'buy', amount: 200, units: 4 },
      { assetClass: 'crypto' },
    );
    expect(r.price_per_unit).toBe(50);
  });

  it('rejects when fewer than two of (amount, units, price) provided', () => {
    expect(() => normalizeTransactionPayload({ type: 'buy', amount: 100 }, { assetClass: 'stock' })).toThrow(/at least two/);
  });

  it('rejects when amount inconsistent with units * price', () => {
    expect(() => normalizeTransactionPayload(
      { type: 'buy', amount: 100, units: 5, price_per_unit: 50 },
      { assetClass: 'stock' },
    )).toThrow(/amount must equal/);
  });

  it('rejects negative or zero values', () => {
    expect(() => normalizeTransactionPayload(
      { type: 'buy', amount: 0, units: 1, price_per_unit: 1 },
      { assetClass: 'stock' },
    )).toThrow(/positive/);
    expect(() => normalizeTransactionPayload(
      { type: 'buy', amount: 1, units: -1, price_per_unit: 1 },
      { assetClass: 'stock' },
    )).toThrow(/positive/);
  });

  it('rejects negative fx_rate_to_eur', () => {
    expect(() => normalizeTransactionPayload(
      { type: 'buy', amount: 1, units: 1, price_per_unit: 1, fx_rate_to_eur: -1 },
      { assetClass: 'stock' },
    )).toThrow(/fx_rate_to_eur/);
  });

  it('defaults fees and taxes to 0', () => {
    const r = normalizeTransactionPayload(
      { type: 'buy', units: 5, price_per_unit: 100 },
      { assetClass: 'stock' },
    );
    expect(r.fees).toBe(0);
    expect(r.taxes).toBe(0);
  });
});

describe('normalizeTransactionPayload — buy/sell on non-unit assets', () => {
  it('requires amount and skips unit math for savings/bond/real_estate', () => {
    const r = normalizeTransactionPayload(
      { type: 'buy', amount: 1000 },
      { assetClass: 'savings' },
    );
    expect(r.amount).toBe(1000);
    expect(r.units).toBeUndefined();
  });

  it('rejects missing amount on non-unit buy', () => {
    expect(() => normalizeTransactionPayload(
      { type: 'buy' },
      { assetClass: 'savings' },
    )).toThrow(/amount is required/);
  });
});

describe('normalizeTransactionPayload — gift', () => {
  it('rejects gifts on non-unit-based asset classes', () => {
    expect(() => normalizeTransactionPayload(
      { type: 'gift', units: 5 },
      { assetClass: 'savings' },
    )).toThrow(/unit-based/);
  });

  it('requires positive units', () => {
    expect(() => normalizeTransactionPayload(
      { type: 'gift', units: 0 },
      { assetClass: 'stock' },
    )).toThrow(/units > 0/);
  });

  it('rejects non-zero fees or taxes', () => {
    expect(() => normalizeTransactionPayload(
      { type: 'gift', units: 5, fees: 1 },
      { assetClass: 'stock' },
    )).toThrow(/0 fees/);
  });

  it('rejects negative amount', () => {
    expect(() => normalizeTransactionPayload(
      { type: 'gift', units: 5, amount: -1 },
      { assetClass: 'stock' },
    )).toThrow(/cannot be negative/);
  });

  it('defaults amount to 0 when omitted', () => {
    const r = normalizeTransactionPayload(
      { type: 'gift', units: 5 },
      { assetClass: 'stock' },
    );
    expect(r.amount).toBe(0);
    expect(r.fees).toBe(0);
    expect(r.taxes).toBe(0);
  });
});

describe('normalizeTransactionPayload — other types (dividend/fee/tax/etc)', () => {
  it('requires amount for non-buy/sell/gift types', () => {
    expect(() => normalizeTransactionPayload({ type: 'dividend' })).toThrow(/amount is required/);
  });

  it('preserves payload values for non-buy/sell types', () => {
    const r = normalizeTransactionPayload({ type: 'dividend', amount: 100, fees: 1 });
    expect(r.amount).toBe(100);
    expect(r.fees).toBe(1);
    expect(r.taxes).toBe(0);
  });

  it('rejects non-numeric input', () => {
    expect(() => normalizeTransactionPayload({ type: 'dividend', amount: 'free' })).toThrow(/amount must be a valid number/);
  });
});

describe('validateSellUnitsAvailability', () => {
  it('is a no-op for non-sell types', async () => {
    await expect(validateSellUnitsAvailability({ type: 'buy', assetClass: 'stock', units: 100 })).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('is a no-op for non-unit asset classes', async () => {
    await expect(validateSellUnitsAvailability({ type: 'sell', assetClass: 'savings', units: 100 })).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('is a no-op when units is zero or negative', async () => {
    await expect(validateSellUnitsAvailability({ type: 'sell', assetClass: 'stock', units: 0 })).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('passes when sell units fit available holdings', async () => {
    query.mockResolvedValueOnce({ rows: [{ net_units: '10' }] });
    await expect(validateSellUnitsAvailability({
      type: 'sell', assetClass: 'stock', investmentId: 1, date: '2025-04-01', units: 10,
    })).resolves.toBeUndefined();
  });

  it('throws VALIDATION_ERROR when exceeds available holdings', async () => {
    query.mockResolvedValueOnce({ rows: [{ net_units: '5' }] });
    await expect(validateSellUnitsAvailability({
      type: 'sell', assetClass: 'stock', investmentId: 1, date: '2025-04-01', units: 10,
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('sell units exceed'),
    });
  });

  it('binds excludeTransactionId when provided', async () => {
    query.mockResolvedValueOnce({ rows: [{ net_units: '50' }] });
    await validateSellUnitsAvailability({
      type: 'sell', assetClass: 'stock', investmentId: 1, date: '2025-04-01', units: 5, excludeTransactionId: 99,
    });
    expect(query.mock.calls[0][1]).toEqual([1, '2025-04-01', 99]);
  });
});

describe('allowed-fields constants', () => {
  it('BASE_ALLOWED_FIELDS includes core columns', () => {
    expect(BASE_ALLOWED_FIELDS).toContain('amount');
    expect(BASE_ALLOWED_FIELDS).toContain('date');
    expect(BASE_ALLOWED_FIELDS).toContain('fx_rate_to_eur');
    expect(BASE_ALLOWED_FIELDS).not.toContain('id');
  });

  it('CHILD_ALLOWED_FIELDS_BY_ASSET_CLASS limits fields by class', () => {
    expect(CHILD_ALLOWED_FIELDS_BY_ASSET_CLASS.stock).toEqual(['units', 'price_per_unit']);
    expect(CHILD_ALLOWED_FIELDS_BY_ASSET_CLASS.real_estate).toEqual([]);
    expect(CHILD_ALLOWED_FIELDS_BY_ASSET_CLASS.savings).toEqual([]);
  });
});
