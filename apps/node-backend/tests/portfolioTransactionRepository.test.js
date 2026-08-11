import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockConnection } from './helpers/repoMocks.js';
vi.mock('../src/database/connection.js', () => mockConnection());

import { query } from '../src/database/connection.js';
import portfolioTransactionRepository, { __resetPortfolioTransactionSchemaCache } from '../src/repositories/portfolioTransactionRepository.js';

describe('portfolioTransactionRepository.create', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it('inserts into the flat portfolio_transactions table', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
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

    expect(query).toHaveBeenNthCalledWith(1, 'SELECT asset_class FROM investments WHERE id = $1', [1]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO portfolio_transactions'),
      [1, 'buy', '2026-03-24', 1000, 3, 333.33, 0, 0, 'EUR', null, false, null, null, null, null]
    );
    const insertSql = query.mock.calls[1][0];
    expect(insertSql).toContain('(investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur, account_id)');
    expect(insertSql).toContain('RETURNING *');
    expect(result).toEqual({ id: 11, investment_id: 1, type: 'buy' });
  });

  it('skips the investment lookup when asset class is preloaded', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 12, investment_id: 2, type: 'dividend' }] });

    const result = await portfolioTransactionRepository.create({
      investment_id: 2,
      type: 'dividend',
      date: '2026-03-24',
      amount: 50,
      currency: 'EUR',
      preloaded_asset_class: 'stock',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO portfolio_transactions'),
      [2, 'dividend', '2026-03-24', 50, null, null, 0, 0, 'EUR', null, false, null, null, null, null]
    );
    expect(result).toEqual({ id: 12, investment_id: 2, type: 'dividend' });
  });

  it('calculates missing buy/sell field when two of three are provided', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
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
      2,
      expect.stringContaining('INSERT INTO portfolio_transactions'),
      [1, 'buy', '2026-03-24', 1000, 5, 200, 0, 0, 'EUR', null, false, null, null, null, null]
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
      .mockResolvedValueOnce({ rows: [{ id: 40, type: 'gift', amount: '0.0000', units: '2.00000000' }] });

    const result = await portfolioTransactionRepository.create({
      investment_id: 1,
      type: 'gift',
      date: '2026-03-24',
      units: 2,
      currency: 'EUR',
    });

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO portfolio_transactions'),
      [1, 'gift', '2026-03-24', 0, 2, null, 0, 0, 'EUR', null, false, null, null, null, null]
    );
    expect(result).toEqual({ id: 40, type: 'gift', amount: 0, units: 2 });
  });

  it('appends import_batch_id only when set and the column exists', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ present: true }] }) // column probe (0086)
      .mockResolvedValueOnce({ rows: [{ id: 50, investment_id: 1, type: 'buy', import_batch_id: '7' }] });

    const result = await portfolioTransactionRepository.create({
      investment_id: 1,
      type: 'buy',
      date: '2026-03-24',
      amount: 1000,
      units: 5,
      price_per_unit: 200,
      currency: 'EUR',
      import_batch_id: 7,
    });

    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('import_batch_id'),
      [1, 'buy', '2026-03-24', 1000, 5, 200, 0, 0, 'EUR', null, false, null, null, null, null, 7]
    );
    expect(result).toMatchObject({ id: 50, investment_id: 1, type: 'buy' });
  });

  it('omits import_batch_id on an un-migrated database', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ present: false }] }) // column probe (0086)
      .mockResolvedValueOnce({ rows: [{ id: 51, investment_id: 1, type: 'buy' }] });

    await portfolioTransactionRepository.create({
      investment_id: 1,
      type: 'buy',
      date: '2026-03-24',
      amount: 1000,
      units: 5,
      price_per_unit: 200,
      currency: 'EUR',
      import_batch_id: 7,
    });

    const insertSql = query.mock.calls[2][0];
    expect(insertSql).not.toContain('import_batch_id');
    expect(query.mock.calls[2][1]).toHaveLength(15);
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

  it('deletes from the flat table', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });

    const deleted = await portfolioTransactionRepository.hardDelete(44);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('DELETE FROM portfolio_transactions WHERE id = $1', [44]);
    expect(deleted).toBe(true);
  });

  it('returns false when delete affects no rows', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });

    const deleted = await portfolioTransactionRepository.hardDelete(99);

    expect(deleted).toBe(false);
  });
});

describe('portfolioTransactionRepository.hardDeleteByImportBatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it('bulk-deletes lots by batch stamp and returns their ids', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ present: true }] }) // column probe (0086)
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });

    const ids = await portfolioTransactionRepository.hardDeleteByImportBatch(7);

    expect(query).toHaveBeenNthCalledWith(
      2,
      'DELETE FROM portfolio_transactions WHERE import_batch_id = $1 RETURNING id',
      [7]
    );
    expect(ids).toEqual([1, 2]);
  });

  it('returns [] without deleting on an un-migrated database', async () => {
    query.mockResolvedValueOnce({ rows: [{ present: false }] }); // column probe (0086)

    const ids = await portfolioTransactionRepository.hardDeleteByImportBatch(7);

    expect(ids).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('portfolioTransactionRepository.repointAccount', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it('repoints lots on the flat table', async () => {
    query.mockResolvedValueOnce({ rowCount: 3 });

    const count = await portfolioTransactionRepository.repointAccount(5, [7, 8]);

    expect(query).toHaveBeenCalledWith(
      'UPDATE portfolio_transactions SET account_id = $1 WHERE account_id = ANY($2::int[])',
      [5, [7, 8]]
    );
    expect(count).toBe(3);
  });
});

describe('portfolioTransactionRepository.update', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it('normalizes buy/sell math on update when one of three fields is omitted', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 8, investment_id: 1, type: 'buy', amount: '1000', units: '5', price_per_unit: '200', fees: '0', taxes: '0' }] })
      .mockResolvedValueOnce({ rows: [{ asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ id: 8, amount: '1200.0000', units: '6.00000000', price_per_unit: '200.000000' }] });

    const result = await portfolioTransactionRepository.update(8, {
      units: 6,
      price_per_unit: 200,
    });

    expect(query).toHaveBeenNthCalledWith(
      3,
      'UPDATE portfolio_transactions SET units = $1, price_per_unit = $2, amount = $3, fees = $4, taxes = $5 WHERE id = $6 RETURNING *',
      [6, 200, 1200, 0, 0, 8]
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
      .mockResolvedValueOnce({ rows: [{ id: 9, amount: '1200.00' }] });

    const result = await portfolioTransactionRepository.update(9, { amount: 1200 });

    expect(query).toHaveBeenNthCalledWith(
      3,
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

  // The existing pins above only used values `Number.parseInt` also rejected
  // ('x', 'invalid'), so they passed either way. These are the ones that made
  // the layer retarget: parseInt took the leading digits, so a malformed entry
  // did not drop out, it named a real investment nobody asked for. The route
  // now 400s on them before this runs (routes are pinned in
  // routes/investmentsIdValidation.test.js); here they must drop, not resolve.
  it('drops ids the old parseInt truncated into a different investment', async () => {
    const rows = await portfolioTransactionRepository.getAllByInvestmentIds({
      investmentIds: ['12abc', '1e3', '12.5', '0x10', ' 7 ', '+7'],
    });

    expect(rows).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('drops the malformed element of a mixed list without dropping the good one', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await portfolioTransactionRepository.getAllByInvestmentIds({ investmentIds: [5, '12abc'] });

    expect(query.mock.calls[0][1][0]).toEqual([5]);
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
