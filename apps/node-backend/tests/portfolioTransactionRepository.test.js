import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query, withTransaction } from '../src/database/connection.js';
import portfolioTransactionRepository, { __resetPortfolioTransactionSchemaCache } from '../src/repositories/portfolioTransactionRepository.js';

describe('portfolioTransactionRepository.create', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it('falls back to inheritance tables when portfolio_transactions is non-updatable view', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: null }] })
      .mockRejectedValueOnce({ message: 'cannot insert into view "portfolio_transactions"', code: '55000' })
      .mockResolvedValueOnce({ rows: [{ id: 11 }] })
      .mockResolvedValueOnce({ rows: [{ id: 11, investment_id: 1, type: 'buy' }] });

    const result = await portfolioTransactionRepository.create({
      investment_id: 1,
      type: 'buy',
      date: '2026-03-24',
      amount: 1000,
      units: 3,
      price_per_unit: 333.33,
      currency: 'EUR',
    });

    expect(query).toHaveBeenNthCalledWith(
      3,
      `INSERT INTO portfolio_transactions
         (investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
      [1, 'buy', '2026-03-24', 1000, 3, 333.33, 0, 0, 'EUR', null, false, null, null, null, null]
    );
    // No unconditional pre-resync — the child INSERT runs straight after the
    // view INSERT fails.
    expect(query).toHaveBeenNthCalledWith(
      4,
      'INSERT INTO stock_transactions (investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id, units, price_per_unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id',
      [1, 'buy', '2026-03-24', 1000, 0, 0, 'EUR', null, false, null, null, null, null, 3, 333.33]
    );
    expect(query).toHaveBeenNthCalledWith(5, 'SELECT * FROM portfolio_transactions WHERE id = $1', [11]);
    expect(result).toEqual({ id: 11, investment_id: 1, type: 'buy' });
  });

  it('retries insert once after a duplicate-id collision', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: 'portfolio_transactions_base' }] })
      .mockRejectedValueOnce({
        code: '23505',
        constraint: 'stock_transactions_pkey',
        detail: 'Key (id)=(1) already exists.',
        message: 'duplicate key value violates unique constraint "stock_transactions_pkey"',
      })
      .mockResolvedValueOnce({ rows: [{ setval: 21 }] })
      .mockResolvedValueOnce({ rows: [{ id: 21 }] })
      .mockResolvedValueOnce({ rows: [{ id: 21, investment_id: 1, type: 'buy' }] });

    const result = await portfolioTransactionRepository.create({
      investment_id: 1,
      type: 'buy',
      date: '2026-03-24',
      amount: 1000,
      units: 3,
      price_per_unit: 333.33,
      currency: 'EUR',
    });

    // First child INSERT collides on a duplicate id...
    expect(query).toHaveBeenNthCalledWith(
      3,
      'INSERT INTO stock_transactions (investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id, units, price_per_unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id',
      [1, 'buy', '2026-03-24', 1000, 0, 0, 'EUR', null, false, null, null, null, null, 3, 333.33]
    );
    // ...which triggers a resync only in the catch path...
    expect(query).toHaveBeenNthCalledWith(
      4,
      "SELECT setval(pg_get_serial_sequence('portfolio_transactions_base', 'id'), COALESCE((SELECT MAX(id) FROM portfolio_transactions_base), 0) + 1, false)"
    );
    // ...then the insert is retried once.
    expect(query).toHaveBeenNthCalledWith(
      5,
      'INSERT INTO stock_transactions (investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id, units, price_per_unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id',
      [1, 'buy', '2026-03-24', 1000, 0, 0, 'EUR', null, false, null, null, null, null, 3, 333.33]
    );
    expect(query).toHaveBeenNthCalledWith(6, 'SELECT * FROM portfolio_transactions WHERE id = $1', [21]);
    expect(result).toEqual({ id: 21, investment_id: 1, type: 'buy' });
  });

  it('calculates missing buy/sell field when two of three are provided', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: 'portfolio_transactions_base' }] })
      .mockResolvedValueOnce({ rows: [{ id: 30 }] })
      .mockResolvedValueOnce({ rows: [{ id: 30, amount: '1000.0000', units: '5.00000000', price_per_unit: '200.000000' }] });

    const result = await portfolioTransactionRepository.create({
      investment_id: 1,
      type: 'buy',
      date: '2026-03-24',
      units: 5,
      price_per_unit: 200,
      currency: 'EUR',
    });

    expect(query).toHaveBeenNthCalledWith(
      3,
      'INSERT INTO stock_transactions (investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id, units, price_per_unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id',
      [1, 'buy', '2026-03-24', 1000, 0, 0, 'EUR', null, false, null, null, null, null, 5, 200]
    );
    expect(result).toEqual({ id: 30, amount: 1000, units: 5, price_per_unit: 200 });
  });

  it('rejects buy/sell when fewer than two of amount/units/price_per_unit are provided', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] });

    await expect(
      portfolioTransactionRepository.create({
        investment_id: 1,
        type: 'buy',
        date: '2026-03-24',
        amount: 1000,
        currency: 'EUR',
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('supports gift as zero-cost asset injection with optional basis', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: 'portfolio_transactions_base' }] })
      .mockResolvedValueOnce({ rows: [{ id: 40 }] })
      .mockResolvedValueOnce({ rows: [{ id: 40, type: 'gift', amount: '0.0000', units: '2.00000000' }] });

    const result = await portfolioTransactionRepository.create({
      investment_id: 1,
      type: 'gift',
      date: '2026-03-24',
      units: 2,
      currency: 'EUR',
    });

    expect(query).toHaveBeenNthCalledWith(
      3,
      'INSERT INTO stock_transactions (investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id, units, price_per_unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id',
      [1, 'gift', '2026-03-24', 0, 0, 0, 'EUR', null, false, null, null, null, null, 2, null]
    );
    expect(result).toEqual({ id: 40, type: 'gift', amount: 0, units: 2 });
  });

  it('routes metals transactions to metals_transactions table in inheritance mode', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'metals' }] })
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: 'portfolio_transactions_base' }] })
      .mockResolvedValueOnce({ rows: [{ id: 60 }] })
      .mockResolvedValueOnce({ rows: [{ id: 60, investment_id: 1, type: 'buy' }] });

    const result = await portfolioTransactionRepository.create({
      investment_id: 1,
      type: 'buy',
      date: '2026-03-24',
      amount: 1000,
      units: 2,
      price_per_unit: 500,
      currency: 'EUR',
    });

    expect(query).toHaveBeenNthCalledWith(
      3,
      'INSERT INTO metals_transactions (investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id, units, price_per_unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id',
      [1, 'buy', '2026-03-24', 1000, 0, 0, 'EUR', null, false, null, null, null, null, 2, 500]
    );
    expect(result).toEqual({ id: 60, investment_id: 1, type: 'buy' });
  });

  it('rejects sell transaction when sell units exceed holdings on that date', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ net_units: '1.00000000' }] });

    await expect(
      portfolioTransactionRepository.create({
        investment_id: 1,
        type: 'sell',
        date: '2026-03-24',
        amount: 1000,
        units: 2,
        price_per_unit: 500,
        currency: 'EUR',
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'sell units exceed available holdings' });
  });
});

describe('portfolioTransactionRepository.hardDelete', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it('falls back to deleting from base table when portfolio_transactions view is non-updatable', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: 'portfolio_transactions_base' }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const deleted = await portfolioTransactionRepository.hardDelete(44);

    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT to_regclass('public.portfolio_transactions_base') AS portfolio_transactions_base"
    );
    expect(query).toHaveBeenNthCalledWith(2, 'DELETE FROM portfolio_transactions_base WHERE id = $1', [44]);
    expect(deleted).toBe(true);
  });

  it('returns false when direct delete affects no rows', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: null }] })
      .mockResolvedValueOnce({ rowCount: 0 });

    const deleted = await portfolioTransactionRepository.hardDelete(99);

    expect(query).toHaveBeenNthCalledWith(2, 'DELETE FROM portfolio_transactions WHERE id = $1', [99]);
    expect(deleted).toBe(false);
  });

  it('falls back to base-table delete when direct delete hits non-updatable view', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: null }] })
      .mockRejectedValueOnce({ message: 'cannot delete from view "portfolio_transactions"', code: '55000' })
      .mockResolvedValueOnce({ rowCount: 1 });

    const deleted = await portfolioTransactionRepository.hardDelete(55);

    expect(query).toHaveBeenNthCalledWith(3, 'DELETE FROM portfolio_transactions_base WHERE id = $1', [55]);
    expect(deleted).toBe(true);
  });
});

describe('portfolioTransactionRepository.update', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withTransaction.mockImplementation(async (fn) => fn({ query }));
    __resetPortfolioTransactionSchemaCache();
  });

  it('falls back to inheritance updates when portfolio_transactions is non-updatable view', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 6, investment_id: 1, type: 'buy', amount: '1000', units: '3', price_per_unit: '333.33', fees: '0', taxes: '0' }] })
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: null }] })
      .mockRejectedValueOnce({ message: 'cannot update view "portfolio_transactions"', code: '55000' })
      .mockResolvedValueOnce({ rows: [{ id: 6, investment_id: 1, type: 'buy', amount: '1000', units: '3', price_per_unit: '333.33', fees: '0', taxes: '0' }] })
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 6, investment_id: 1, amount: '1200.00', units: '4.00000000', fees: '3.00' }] });

    const result = await portfolioTransactionRepository.update(6, {
      amount: 1200,
      units: 4,
      fees: 3,
    });

    expect(query).toHaveBeenNthCalledWith(
      4,
      'UPDATE portfolio_transactions SET amount = $1, units = $2, fees = $3, price_per_unit = $4, taxes = $5 WHERE id = $6 RETURNING *',
      [1200, 4, 3, 300, 0, 6]
    );
    expect(query).toHaveBeenNthCalledWith(5, 'SELECT * FROM portfolio_transactions WHERE id = $1', [6]);
    expect(query).toHaveBeenNthCalledWith(6, 'SELECT asset_class FROM investments WHERE id = $1', [1]);
    expect(query).toHaveBeenNthCalledWith(7, 'UPDATE portfolio_transactions_base SET amount = $1, fees = $2, taxes = $3 WHERE id = $4', [1200, 3, 0, 6]);
    expect(query).toHaveBeenNthCalledWith(8, 'UPDATE stock_transactions SET units = $1, price_per_unit = $2 WHERE id = $3', [4, 300, 6]);
    expect(query).toHaveBeenNthCalledWith(9, 'SELECT * FROM portfolio_transactions WHERE id = $1', [6]);
    expect(result).toEqual({ id: 6, investment_id: 1, amount: 1200, units: 4, fees: 3 });
  });

  it('normalizes buy/sell math on update when one of three fields is omitted', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 8, investment_id: 1, type: 'buy', amount: '1000', units: '5', price_per_unit: '200', fees: '0', taxes: '0' }] })
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: 'portfolio_transactions_base' }] })
      .mockResolvedValueOnce({ rows: [{ id: 8, investment_id: 1, type: 'buy', amount: '1000', units: '5', price_per_unit: '200', fees: '0', taxes: '0' }] })
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 8, amount: '1200.0000', units: '6.00000000', price_per_unit: '200.000000' }] });

    const result = await portfolioTransactionRepository.update(8, {
      units: 6,
      price_per_unit: 200,
    });

    expect(query).toHaveBeenNthCalledWith(
      6,
      'UPDATE portfolio_transactions_base SET amount = $1, fees = $2, taxes = $3 WHERE id = $4',
      [1200, 0, 0, 8]
    );
    expect(query).toHaveBeenNthCalledWith(
      7,
      'UPDATE stock_transactions SET units = $1, price_per_unit = $2 WHERE id = $3',
      [6, 200, 8]
    );
    expect(result).toEqual({ id: 8, amount: 1200, units: 6, price_per_unit: 200 });
  });

  it('rejects buy/sell update when only one of amount/units/price_per_unit is provided', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 10, investment_id: 1, type: 'buy', amount: '1000', units: '5', price_per_unit: '200', fees: '0', taxes: '0' }] })
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] });

    await expect(
      portfolioTransactionRepository.update(10, { amount: 1200 })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('keeps non-unit buy/sell update behavior amount-only', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 9, investment_id: 2, type: 'buy', amount: '1000', fees: '0', taxes: '0' }] })
      .mockResolvedValueOnce({ rows: [{ asset_class: 'bond' }] })
      .mockResolvedValueOnce({ rows: [{ portfolio_transactions_base: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 9, amount: '1200.00' }] });

    const result = await portfolioTransactionRepository.update(9, { amount: 1200 });

    expect(query).toHaveBeenNthCalledWith(
      4,
      'UPDATE portfolio_transactions SET amount = $1 WHERE id = $2 RETURNING *',
      [1200, 9]
    );
    expect(result).toEqual({ id: 9, amount: 1200 });
  });

  it('rejects changing transaction type', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 12, investment_id: 1, type: 'buy', amount: '1000', units: '5', price_per_unit: '200', fees: '0', taxes: '0' }] });

    await expect(
      portfolioTransactionRepository.update(12, { type: 'sell' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'type cannot be changed' });
  });

  it('returns null when update target does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await portfolioTransactionRepository.update(404, { note: 'x' });

    expect(result).toBeNull();
  });

  it('returns existing row unchanged when patch has no allowed fields', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 21, investment_id: 1, type: 'dividend', amount: '100', asset_class: 'stock' }] });

    const result = await portfolioTransactionRepository.update(21, { unsupported: 'field' });

    expect(result).toEqual({ id: 21, investment_id: 1, type: 'dividend', amount: 100, asset_class: 'stock' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects sell update when sell units exceed holdings on the effective date', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 13, investment_id: 1, type: 'sell', date: '2026-03-24', amount: '1000', units: '1', price_per_unit: '1000', fees: '0', taxes: '0' }] })
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ net_units: '0.50000000' }] });

    await expect(
      portfolioTransactionRepository.update(13, { units: 1, price_per_unit: 1000 })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'sell units exceed available holdings' });
  });
});

describe('portfolioTransactionRepository.getAllByInvestmentIds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it('returns empty list when investmentIds normalize to empty', async () => {
    const rows = await portfolioTransactionRepository.getAllByInvestmentIds({
      investmentIds: ['x', 0, -2, null],
    });

    expect(rows).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('applies sanitized ids, type filter, and clamps pagination limits', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 9 }] });

    const rows = await portfolioTransactionRepository.getAllByInvestmentIds({
      investmentIds: [1, '2', '2', 'invalid', -7],
      type: 'buy',
      perInvestmentLimit: 7000,
      limit: 999999,
      offset: -5,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('pt.investment_id = ANY($1::int[])');
    expect(sql).toContain('AND pt.type = $3');
    expect(sql).toContain('WHERE rn <= $2');
    expect(sql).toContain('LIMIT $4');
    expect(sql).toContain('OFFSET $5');
    expect(params).toEqual([[1, 2], 5000, 'buy', 200000, 0]);
    expect(rows).toEqual([{ id: 9 }]);
  });

  it('omits type and limit clauses when not provided', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 44 }] });

    const rows = await portfolioTransactionRepository.getAllByInvestmentIds({
      investmentIds: [44],
      perInvestmentLimit: 0,
      limit: null,
      offset: 3,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('AND pt.type');
    expect(sql).not.toContain(' LIMIT ');
    expect(sql).toContain('OFFSET $3');
    expect(params).toEqual([[44], 1000, 3]);
    expect(rows).toEqual([{ id: 44 }]);
  });
});

describe('portfolioTransactionRepository.getCount', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it('counts by single investmentId and type', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '7' }] });

    const total = await portfolioTransactionRepository.getCount({
      investmentId: 10,
      type: 'buy',
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('investment_id = $1');
    expect(sql).toContain('type = $2');
    expect(params).toEqual([10, 'buy']);
    expect(total).toBe(7);
  });

  it('counts by normalized investmentIds array', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '9' }] });

    const total = await portfolioTransactionRepository.getCount({
      investmentIds: ['3', 0, '3', 'abc', 4],
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('investment_id = ANY($1::int[])');
    expect(params).toEqual([[3, 4]]);
    expect(total).toBe(9);
  });

  it('skips investmentIds clause when all ids are invalid', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '2' }] });

    const total = await portfolioTransactionRepository.getCount({
      investmentIds: ['bad', 0, -1],
      type: 'sell',
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('ANY(');
    expect(sql).toContain('type = $1');
    expect(params).toEqual(['sell']);
    expect(total).toBe(2);
  });
});

describe('portfolioTransactionRepository.getSummary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it('returns grouped summary rows for an investment', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          type: 'buy',
          total_amount: '1000.00',
          total_units: '5.00000000',
          total_fees: '2.00',
          total_taxes: '1.00',
          count: '2',
        },
      ],
    });

    const rows = await portfolioTransactionRepository.getSummary(77);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM portfolio_transactions'),
      [77]
    );
    expect(rows).toEqual([
      {
        type: 'buy',
        total_amount: 1000,
        total_units: 5,
        total_fees: 2,
        total_taxes: 1,
        count: 2,
      },
    ]);
  });
});
