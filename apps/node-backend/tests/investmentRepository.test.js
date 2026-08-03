import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockTxConnection } from './helpers/repoMocks.js';
vi.mock('../src/database/connection.js', () => mockTxConnection());

import { query } from '../src/database/connection.js';
import investmentRepository from '../src/repositories/investmentRepository.js';

describe('investmentRepository.create', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('creates through the flat investments table', async () => {
    query
      .mockResolvedValueOnce({ rows: [] }) // symbol-uniqueness check (no duplicate)
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
      'SELECT id FROM investments WHERE LOWER(symbol) = LOWER($1) AND id <> $2 LIMIT 1',
      ['BTC', 0]
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
      ['BTC', 'BTC', 'crypto', 'EUR', 50000, null, null, null, null, null, null, null, 'manual', null, null, null, null, null, null, null, null]
    );
    expect(result).toEqual({ id: 1, name: 'BTC', asset_class: 'crypto' });
  });

  it('carries provider URL/path fields through the insert', async () => {
    query
      .mockResolvedValueOnce({ rows: [] }) // symbol-uniqueness check (no duplicate)
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
      price_provider_history_url: 'https://example.com/history',
      price_provider_history_path: 'points',
      price_provider_history_ts_path: 'timestamp_ms',
      price_provider_history_price_path: 'price',
    });

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO investments'),
      ['Napoleon', 'NAPOLEON', 'metals', 'EUR', 706.5, null, null, null, null, null, null, null, 'custom', null, null, 'https://example.com/latest', 'napoleon.price', 'https://example.com/history', 'points', 'timestamp_ms', 'price']
    );
    expect(result).toEqual({ id: 8, asset_class: 'metals', name: 'Napoleon' });
  });
});

describe('investmentRepository.create symbol uniqueness', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects a duplicate symbol on create with the same error shape as update', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 7 }] }); // uniqueness check finds a match

    await expect(
      investmentRepository.create({ name: 'Apple', symbol: ' aapl ', asset_class: 'stock', currency: 'USD' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'symbol must be unique' });

    // Normalized (trim/uppercase) before the check; excludeId 0 matches no row.
    expect(query).toHaveBeenCalledWith(
      'SELECT id FROM investments WHERE LOWER(symbol) = LOWER($1) AND id <> $2 LIMIT 1',
      ['AAPL', 0]
    );
    expect(query).toHaveBeenCalledTimes(1); // nothing written
  });

  it('skips the uniqueness check when no symbol is provided', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 12, asset_class: 'savings', name: 'Book' }] });

    const result = await investmentRepository.create({
      name: 'Book', asset_class: 'savings', currency: 'EUR', interest_rate: 2,
    });

    expect(result).toEqual({ id: 12, asset_class: 'savings', name: 'Book' });
    expect(query).not.toHaveBeenCalledWith(
      'SELECT id FROM investments WHERE LOWER(symbol) = LOWER($1) AND id <> $2 LIMIT 1',
      expect.anything()
    );
  });
});

describe('investmentRepository.update', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('updates the investments table directly', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, asset_class: 'stock', name: 'AAPL' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'AAPL' }] });

    const result = await investmentRepository.update(1, { current_price: 123.45 });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT i.*, COALESCE(tp.show_in_ticker, true) AS show_in_ticker FROM investments i LEFT JOIN investment_ticker_prefs tp ON tp.investment_id = i.id WHERE i.id = $1',
      [1]
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'UPDATE investments SET current_price = $1 WHERE id = $2 RETURNING *',
      [123.45, 1]
    );
    expect(result).toEqual({ id: 1, name: 'AAPL' });
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

  it('upserts show_in_ticker into the side table and returns the joined value', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 5, asset_class: 'stock', name: 'AAPL' }] }) // getById (existing)
      .mockResolvedValueOnce({ rowCount: 1 })                                            // UPSERT preference
      .mockResolvedValueOnce({ rows: [{ id: 5, asset_class: 'stock', name: 'AAPL', show_in_ticker: false }] }); // getById (joined)

    const result = await investmentRepository.update(5, { show_in_ticker: false });

    // No column UPDATE — only getById, the upsert, then getById.
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO investment_ticker_prefs'),
      [5, false]
    );
    expect(result).toMatchObject({ id: 5, show_in_ticker: false });
  });
});

describe('investmentRepository.updatePrice', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('updates price columns in one statement', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, asset_class: 'etf', current_price: '90.50' }] });

    const result = await investmentRepository.updatePrice(1, {
      current_price: 90.5,
      price_updated_at: '2026-03-23T11:50:00.000Z',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE investments'),
      [90.5, '2026-03-23T11:50:00.000Z', 1]
    );
    expect(result).toEqual({ id: 1, asset_class: 'etf', current_price: 90.5 });
  });

  it('returns null for a missing investment', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await investmentRepository.updatePrice(404, {
      current_price: 1,
      price_updated_at: null,
    });

    expect(result).toBeNull();
  });
});

describe('investmentRepository.updatePricesBulk', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('updates all rows via a single UNNEST statement', async () => {
    query.mockResolvedValueOnce({ rowCount: 2 });

    const updated = await investmentRepository.updatePricesBulk([
      { id: 1, current_price: 10, price_updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 2, current_price: 20, price_updated_at: '2026-01-01T00:00:00.000Z' },
    ]);

    expect(updated).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM UNNEST'),
      [[1, 2], [10, 20], ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']]
    );
  });

  it('returns 0 for an empty batch without querying', async () => {
    expect(await investmentRepository.updatePricesBulk([])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('investmentRepository.hardDelete', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('deletes from the investments table', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });

    const deleted = await investmentRepository.hardDelete(10);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('DELETE FROM investments WHERE id = $1', [10]);
    expect(deleted).toBe(true);
  });

  it('returns false when nothing was deleted', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });

    expect(await investmentRepository.hardDelete(11)).toBe(false);
  });
});

describe('investmentRepository read helpers and extra branches', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('supports getAll/getCount/getAllWithCount/getById branch paths', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'A' }] })
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [{ id: 2, name: 'B', total_count: '5' }] })
      .mockResolvedValueOnce({ rows: [] });

    const all = await investmentRepository.getAll({ limit: 10, offset: 0, active: false, assetClass: 'stock' });
    const count = await investmentRepository.getCount({ active: false, assetClass: 'stock' });
    const withCount = await investmentRepository.getAllWithCount({ limit: 1, offset: 2, active: true, assetClass: null });
    const byId = await investmentRepository.getById(999);

    expect(all).toHaveLength(1);
    expect(count).toBe(3);
    expect(withCount.total).toBe(5);
    expect(withCount.rows[0]).toMatchObject({ id: 2, name: 'B' });
    expect(byId).toBeNull();
  });

  it('returns existing row when update has no allowed fields', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5, asset_class: 'stock', name: 'AAPL' }] });

    const result = await investmentRepository.update(5, { unknownField: 'x' });

    expect(result).toEqual({ id: 5, asset_class: 'stock', name: 'AAPL' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns null when updating non-existing investment', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await investmentRepository.update(404, { name: 'Nope' });

    expect(result).toBeNull();
  });

  it('throws for an unsupported asset class in create', async () => {
    // Must be a VALIDATION_ERROR so the controller maps it to a 400, not a 500
    // (translateRepoError in investmentController keys on this code).
    await expect(
      investmentRepository.create({ name: 'X', asset_class: 'unsupported', currency: 'EUR' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'Unsupported asset_class: unsupported' });
    expect(query).not.toHaveBeenCalled();
  });
});
