import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';
vi.mock('fs', () => ({
  default: { promises: { readFile: vi.fn() } },
  promises: { readFile: vi.fn() },
}));

vi.mock('csv-parse/sync', () => ({
  parse: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { parse } from 'csv-parse/sync';
import { parseWithConfig } from '../src/services/portfolioImportPipeline/portfolioGenericAdapter.js';

const COLUMN_MAPPING = {
  date: 'Date', type: 'Type', symbol: 'Symbol', name: 'Name',
  units: 'Qty', price: 'Price', amount: 'Amount', fees: 'Fee',
  taxes: 'Tax', currency: 'Currency', fx_rate: '', note: 'Note',
};

function config(overrides = {}) {
  return {
    date_format: '%Y-%m-%d',
    separator: ',',
    encoding: 'utf-8',
    skip_rows: 0,
    column_mapping: COLUMN_MAPPING,
    ...overrides,
  };
}

beforeEach(() => {
  parse.mockReset();
});

describe('portfolioGenericAdapter.parseWithConfig', () => {
  it('maps columns into shaped rows', async () => {
    parse.mockReturnValue([
      { Date: '2026-01-05', Type: 'Buy', Symbol: 'AAPL', Name: 'Apple', Qty: '10', Price: '185.50', Amount: '1855.00', Fee: '5', Tax: '0', Currency: 'USD', Note: 'lot 1' },
    ]);
    const rows = await parseWithConfig('/tmp/x.csv', config());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      typeRaw: 'Buy', symbolRaw: 'AAPL', nameRaw: 'Apple',
      units: 10, pricePerUnit: 185.5, amount: 1855, fees: 5, taxes: 0,
      currency: 'USD', note: 'lot 1',
    });
    expect(rows[0].date.toISOString().slice(0, 10)).toBe('2026-01-05');
  });

  it('stores absolute magnitudes (direction comes from the type)', async () => {
    parse.mockReturnValue([
      { Date: '2026-01-09', Type: 'Sell', Symbol: 'AAPL', Qty: '-4', Price: '190.10', Amount: '-760.40', Fee: '', Tax: '', Currency: 'USD' },
    ]);
    const rows = await parseWithConfig('/tmp/x.csv', config());
    expect(rows[0].units).toBe(4);
    expect(rows[0].amount).toBe(760.4);
  });

  it('parses EU comma decimals via the shared amount parser', async () => {
    parse.mockReturnValue([
      { Date: '2026-01-05', Type: 'Buy', Symbol: 'AAPL', Qty: '1', Price: '1.234,56', Amount: '1.234,56', Currency: 'EUR' },
    ]);
    const rows = await parseWithConfig('/tmp/x.csv', config());
    expect(rows[0].amount).toBe(1234.56);
  });

  it.each([
    ['%d/%m/%Y', '31/12/2026', '2026-12-31'],
    ['%m/%d/%Y', '12/31/2026', '2026-12-31'],
    ['%d-%m-%Y', '31-12-2026', '2026-12-31'],
  ])('parses the %s date format', async (fmt, raw, iso) => {
    parse.mockReturnValue([{ Date: raw, Type: 'Buy', Symbol: 'AAPL', Qty: '1', Price: '1', Amount: '1' }]);
    const rows = await parseWithConfig('/tmp/x.csv', config({ date_format: fmt }));
    expect(rows[0].date.toISOString().slice(0, 10)).toBe(iso);
  });

  it('skips rows with no parseable date and reports the count', async () => {
    parse.mockReturnValue([
      { Date: '2026-01-05', Type: 'Buy', Symbol: 'AAPL', Qty: '1', Price: '1', Amount: '1' },
      { Date: '', Type: 'Buy', Symbol: 'AAPL', Qty: '1', Price: '1', Amount: '1' },
    ]);
    const rows = await parseWithConfig('/tmp/x.csv', config());
    expect(rows).toHaveLength(1);
    expect(rows.skipped).toBe(1);
  });

  it('throws on an unsupported date_format instead of importing zero rows', async () => {
    parse.mockReturnValue([]);
    await expect(parseWithConfig('/tmp/x.csv', config({ date_format: '%Q' })))
      .rejects.toThrow(/Unsupported date_format/);
  });
});
