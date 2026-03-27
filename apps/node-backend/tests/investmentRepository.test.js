import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import investmentRepository, { __resetInvestmentSchemaCache } from '../src/repositories/investmentRepository.js';

describe('investmentRepository.create', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetInvestmentSchemaCache();
  });

  it('creates through legacy investments table when inheritance schema is absent', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ investments_base: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'BTC', asset_class: 'crypto' }] });

    const result = await investmentRepository.create({
      name: 'BTC',
      symbol: 'BTC',
      asset_class: 'crypto',
      currency: 'EUR',
      current_price: 50000,
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT to_regclass('public.investments_base') AS investments_base"
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
      ['BTC', 'BTC', 'crypto', 'EUR', 50000, null, null, null, null, null, null, null, 'manual', null, null, null, null, null, null, null, null]
    );
    expect(result).toEqual({ id: 1, name: 'BTC', asset_class: 'crypto' });
  });

  it('falls back to inheritance tables when insert into investments view is not updatable', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ investments_base: null }] })
      .mockRejectedValueOnce({ message: 'cannot insert into view "investments"', code: '55000' })
      .mockResolvedValueOnce({ rows: [{ id: 17 }] })
      .mockResolvedValueOnce({ rows: [{ id: 17, asset_class: 'stock', name: 'AAPL' }] });

    const result = await investmentRepository.create({
      name: 'AAPL',
      symbol: 'AAPL',
      asset_class: 'stock',
      currency: 'USD',
      current_price: 180.5,
      notes: 'Tech stock',
      price_provider: 'yahoo',
      price_provider_id: 'AAPL',
    });

    expect(query).toHaveBeenNthCalledWith(
      2,
      `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
      ['AAPL', 'AAPL', 'stock', 'USD', 180.5, null, null, null, null, null, null, 'Tech stock', 'yahoo', 'AAPL', null, null, null, null, null, null, null]
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'INSERT INTO stock_investments (name, currency, notes, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, symbol, current_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id',
      ['AAPL', 'USD', 'Tech stock', 'yahoo', 'AAPL', null, null, null, null, null, null, null, 'AAPL', 180.5]
    );
    expect(query).toHaveBeenNthCalledWith(4, 'SELECT * FROM investments WHERE id = $1', [17]);
    expect(result).toEqual({ id: 17, asset_class: 'stock', name: 'AAPL' });
  });

  it('falls back to legacy insert columns when modern provider columns are missing', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ investments_base: null }] })
      .mockRejectedValueOnce({
        code: '42703',
        message: 'column "price_provider_latest_url" of relation "investments" does not exist',
      })
      .mockResolvedValueOnce({ rows: [{ id: 8, asset_class: 'metals', name: 'Napoleon' }] });

    const result = await investmentRepository.create({
      name: 'Napoleon',
      symbol: 'NAPOLEON',
      asset_class: 'metals',
      currency: 'EUR',
      current_price: 706.5,
      price_provider: 'custom',
      price_provider_latest_url: 'https://example.com/latest',
      price_provider_latest_path: 'napoleon.price',
    });

    expect(query).toHaveBeenNthCalledWith(
      3,
      `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, price_provider, price_provider_id, price_provider_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      ['Napoleon', 'NAPOLEON', 'metals', 'EUR', 706.5, null, null, null, null, null, null, null, 'custom', 'napoleon.price', 'https://example.com/latest']
    );
    expect(result).toEqual({ id: 8, asset_class: 'metals', name: 'Napoleon' });
  });

  it('falls back to inheritance create when legacy insert also hits non-updatable investments view', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ investments_base: null }] })
      .mockRejectedValueOnce({
        code: '42703',
        message: 'column "price_provider_latest_url" of relation "investments" does not exist',
      })
      .mockRejectedValueOnce({
        code: '55000',
        message: 'cannot insert into view "investments"',
      })
      .mockResolvedValueOnce({ rows: [{ metals_investments: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })
      .mockResolvedValueOnce({ rows: [{ id: 99, asset_class: 'metals', name: 'Napoleon 20F' }] });

    const result = await investmentRepository.create({
      name: 'Napoleon 20F',
      symbol: 'NAPOLEON',
      asset_class: 'metals',
      currency: 'EUR',
      current_price: 706.5,
      price_provider: 'custom',
      price_provider_latest_url: 'https://example.com/latest',
      price_provider_latest_path: 'napoleon.price',
      price_provider_history_url: 'https://example.com/history',
      price_provider_history_path: 'points',
      price_provider_history_ts_path: 'timestamp_ms',
      price_provider_history_price_path: 'price',
    });

    expect(query).toHaveBeenNthCalledWith(
      5,
      'INSERT INTO stock_investments (name, currency, notes, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, symbol, current_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id',
      ['Napoleon 20F', 'EUR', null, 'custom', null, null, 'https://example.com/latest', 'napoleon.price', 'https://example.com/history', 'points', 'timestamp_ms', 'price', 'NAPOLEON', 706.5]
    );
    expect(query).toHaveBeenNthCalledWith(6, 'SELECT * FROM investments WHERE id = $1', [99]);
    expect(result).toEqual({ id: 99, asset_class: 'metals', name: 'Napoleon 20F' });
  });

  it('creates directly through inheritance tables when schema exists', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ investments_base: 'investments_base' }] })
      .mockResolvedValueOnce({ rows: [{ id: 25 }] })
      .mockResolvedValueOnce({ rows: [{ id: 25, asset_class: 'real_estate', name: 'Apartment' }] });

    const result = await investmentRepository.create({
      name: 'Apartment',
      asset_class: 'real_estate',
      currency: 'EUR',
      current_price: 220000,
      location: 'Brussels',
      municipality: 'Brussels',
      cadastral_income: 1200,
      municipality_tax_rate: 7.5,
    });

    expect(query).toHaveBeenNthCalledWith(
      2,
      'INSERT INTO real_estate_investments (name, currency, notes, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, current_price, location, municipality, cadastral_income, municipality_tax_rate) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id',
      ['Apartment', 'EUR', null, 'manual', null, null, null, null, null, null, null, null, 220000, 'Brussels', 'Brussels', 1200, 7.5]
    );
    expect(query).toHaveBeenNthCalledWith(3, 'SELECT * FROM investments WHERE id = $1', [25]);
    expect(result).toEqual({ id: 25, asset_class: 'real_estate', name: 'Apartment' });
  });

  it('falls back to legacy inheritance columns when child table misses modern provider columns', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ investments_base: 'investments_base' }] })
      .mockResolvedValueOnce({ rows: [{ metals_investments: null }] })
      .mockRejectedValueOnce({
        code: '42703',
        message: 'column "price_provider_latest_url" of relation "stock_investments" does not exist',
      })
      .mockResolvedValueOnce({ rows: [{ id: 44 }] })
      .mockResolvedValueOnce({ rows: [{ id: 44, asset_class: 'metals', name: 'Napoleon 20F' }] });

    const result = await investmentRepository.create({
      name: 'Napoleon 20F',
      symbol: 'NAPOLEON',
      asset_class: 'metals',
      currency: 'EUR',
      current_price: 705.2,
      price_provider: 'custom',
      price_provider_latest_url: 'https://example.com/latest',
      price_provider_latest_path: 'napoleon.price',
    });

    expect(query).toHaveBeenNthCalledWith(
      4,
      'INSERT INTO stock_investments (name, currency, notes, price_provider, price_provider_id, price_provider_url, symbol, current_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      ['Napoleon 20F', 'EUR', null, 'custom', 'napoleon.price', 'https://example.com/latest', 'NAPOLEON', 705.2]
    );
    expect(query).toHaveBeenNthCalledWith(5, 'SELECT * FROM investments WHERE id = $1', [44]);
    expect(result).toEqual({ id: 44, asset_class: 'metals', name: 'Napoleon 20F' });
  });

  it('resyncs investments_base sequence and retries when inherited insert hits duplicate id', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ investments_base: 'investments_base' }] })
      .mockRejectedValueOnce({
        code: '23505',
        constraint: 'stock_investments_pkey',
        detail: 'Key (id)=(1) already exists.',
        message: 'duplicate key value violates unique constraint "stock_investments_pkey"',
      })
      .mockResolvedValueOnce({ rows: [{ setval: 42 }] })
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })
      .mockResolvedValueOnce({ rows: [{ id: 42, asset_class: 'stock', name: 'AAPL' }] });

    const result = await investmentRepository.create({
      name: 'AAPL',
      symbol: 'AAPL',
      asset_class: 'stock',
      currency: 'USD',
      current_price: 180.5,
    });

    expect(query).toHaveBeenNthCalledWith(
      2,
      'INSERT INTO stock_investments (name, currency, notes, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, symbol, current_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id',
      ['AAPL', 'USD', null, 'manual', null, null, null, null, null, null, null, null, 'AAPL', 180.5]
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      "SELECT setval(pg_get_serial_sequence('investments_base', 'id'), COALESCE((SELECT MAX(id) FROM investments_base), 0) + 1, false)"
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      'INSERT INTO stock_investments (name, currency, notes, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, symbol, current_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id',
      ['AAPL', 'USD', null, 'manual', null, null, null, null, null, null, null, null, 'AAPL', 180.5]
    );
    expect(query).toHaveBeenNthCalledWith(5, 'SELECT * FROM investments WHERE id = $1', [42]);
    expect(result).toEqual({ id: 42, asset_class: 'stock', name: 'AAPL' });
  });
});

describe('investmentRepository.update', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetInvestmentSchemaCache();
  });

  it('updates legacy updatable investments view directly when possible', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, asset_class: 'stock', name: 'AAPL' }] })
      .mockResolvedValueOnce({ rows: [{ investments_base: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'AAPL' }] });

    const result = await investmentRepository.update(1, { current_price: 123.45 });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT * FROM investments WHERE id = $1',
      [1]
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT to_regclass('public.investments_base') AS investments_base"
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'UPDATE investments SET current_price = $1 WHERE id = $2 RETURNING *',
      [123.45, 1]
    );
    expect(result).toEqual({ id: 1, name: 'AAPL' });
  });

  it('falls back to base + child table updates when investments is a non-updatable view', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rows: [{ investments_base: null }] })
      .mockRejectedValueOnce({ message: 'cannot update view "investments"', code: '55000' })
      .mockResolvedValueOnce({ rows: [{ id: 1, asset_class: 'stock' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 1, asset_class: 'stock', current_price: '31.20', price_provider_id: 'IONQ' }] });

    const result = await investmentRepository.update(1, {
      current_price: 31.2,
      price_updated_at: '2026-03-23T11:34:56.000Z',
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT * FROM investments WHERE id = $1',
      [1]
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT to_regclass('public.investments_base') AS investments_base"
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'UPDATE investments SET current_price = $1, price_updated_at = $2 WHERE id = $3 RETURNING *',
      [31.2, '2026-03-23T11:34:56.000Z', 1]
    );
    expect(query).toHaveBeenNthCalledWith(4, 'SELECT * FROM investments WHERE id = $1', [1]);
    expect(query).toHaveBeenNthCalledWith(
      5,
      'UPDATE investments_base SET price_updated_at = $1 WHERE id = $2',
      ['2026-03-23T11:34:56.000Z', 1]
    );
    expect(query).toHaveBeenNthCalledWith(
      6,
      'UPDATE stock_investments SET current_price = $1 WHERE id = $2',
      [31.2, 1]
    );
    expect(query).toHaveBeenNthCalledWith(7, 'SELECT * FROM investments WHERE id = $1', [1]);
    expect(result).toEqual({ id: 1, asset_class: 'stock', current_price: '31.20', price_provider_id: 'IONQ' });
  });

  it('updates price via inheritance tables without touching investments view', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, asset_class: 'etf' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 1, asset_class: 'etf', current_price: '90.50' }] });

    const result = await investmentRepository.updatePrice(1, {
      current_price: 90.5,
      price_updated_at: '2026-03-23T11:50:00.000Z',
    });

    expect(query).toHaveBeenNthCalledWith(1, 'SELECT * FROM investments WHERE id = $1', [1]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      'UPDATE investments_base SET price_updated_at = $1 WHERE id = $2',
      ['2026-03-23T11:50:00.000Z', 1]
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'UPDATE etf_investments SET current_price = $1 WHERE id = $2',
      [90.5, 1]
    );
    expect(query).toHaveBeenNthCalledWith(4, 'SELECT * FROM investments WHERE id = $1', [1]);
    expect(result).toEqual({ id: 1, asset_class: 'etf', current_price: '90.50' });
  });

  it('updates generic fields via inheritance tables when schema exists', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 7, asset_class: 'stock', name: 'Old Name' }] })
      .mockResolvedValueOnce({ rows: [{ investments_base: 'investments_base' }] })
      .mockResolvedValueOnce({ rows: [{ id: 7, asset_class: 'stock', name: 'Old Name' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 7, asset_class: 'stock', name: 'New Name' }] });

    const result = await investmentRepository.update(7, { name: 'New Name' });

    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT * FROM investments WHERE id = $1',
      [7]
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT to_regclass('public.investments_base') AS investments_base"
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'SELECT * FROM investments WHERE id = $1',
      [7]
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      'UPDATE investments_base SET name = $1 WHERE id = $2',
      ['New Name', 7]
    );
    expect(query).toHaveBeenNthCalledWith(5, 'SELECT * FROM investments WHERE id = $1', [7]);
    expect(result).toEqual({ id: 7, asset_class: 'stock', name: 'New Name' });
  });

  it('rejects changing asset_class', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 2, asset_class: 'stock' }] });

    await expect(
      investmentRepository.update(2, { asset_class: 'etf' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'asset_class cannot be changed' });
  });

  it('rejects empty symbol', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 3, asset_class: 'stock', symbol: 'OLD' }] });

    await expect(
      investmentRepository.update(3, { symbol: '   ' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'symbol is required' });
  });

  it('normalizes symbol and enforces uniqueness', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 4, asset_class: 'stock', symbol: 'OLD' }] })
      .mockResolvedValueOnce({ rows: [{ id: 99 }] });

    await expect(
      investmentRepository.update(4, { symbol: ' aapl ' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'symbol must be unique' });

    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT id FROM investments WHERE LOWER(symbol) = LOWER($1) AND id <> $2 LIMIT 1',
      ['AAPL', 4]
    );
  });
});

describe('investmentRepository.hardDelete', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetInvestmentSchemaCache();
  });

  it('falls back to deleting from investments_base when investments view is non-updatable', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ investments_base: null }] })
      .mockRejectedValueOnce({ message: 'cannot delete from view "investments"', code: '55000' })
      .mockResolvedValueOnce({ rowCount: 1 });

    const deleted = await investmentRepository.hardDelete(9);

    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT to_regclass('public.investments_base') AS investments_base"
    );
    expect(query).toHaveBeenNthCalledWith(2, 'DELETE FROM investments WHERE id = $1', [9]);
    expect(query).toHaveBeenNthCalledWith(3, 'DELETE FROM investments_base WHERE id = $1', [9]);
    expect(deleted).toBe(true);
  });
});
