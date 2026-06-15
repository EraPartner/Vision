import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({
  default: { create: vi.fn() },
}));

vi.mock('../src/services/portfolio/fxResolve.js', () => ({
  autoResolveFxRateToEur: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import portfolioTransactionRepository from '../src/repositories/portfolioTransactionRepository.js';
import { autoResolveFxRateToEur } from '../src/services/portfolio/fxResolve.js';
import { commitBatch } from '../src/services/portfolioImportPipeline/commit.js';

let matchedRows;
let fieldDuplicate;
let marked;

function dispatch(sql, params) {
  if (/FROM portfolio_import_staging_rows isr/.test(sql)) return { rows: matchedRows };
  if (/FROM portfolio_transactions\s+WHERE investment_id/.test(sql)) {
    return { rows: fieldDuplicate ? [{ '?column?': 1 }] : [] };
  }
  if (/SET status = \$2, error_message/.test(sql)) {
    marked.push({ id: params[0], status: params[1], message: params[2] });
    return { rows: [] };
  }
  return { rows: [] };
}

function row(overrides = {}) {
  return {
    id: 1, tx_date: '2026-01-05', type: 'buy',
    units: 10, price_per_unit: 185.5, amount: 1855, fees: 0, taxes: 0,
    currency: 'EUR', fx_rate_to_eur: null, note: null, tx_hash: 'h1',
    investment_id: 1, asset_class: 'stock', investment_currency: 'EUR',
    ...overrides,
  };
}

beforeEach(() => {
  matchedRows = [];
  fieldDuplicate = false;
  marked = [];
  query.mockReset();
  query.mockImplementation((sql, params) => Promise.resolve(dispatch(sql, params)));
  portfolioTransactionRepository.create.mockReset();
  portfolioTransactionRepository.create.mockResolvedValue({ id: 100 });
  autoResolveFxRateToEur.mockReset();
  autoResolveFxRateToEur.mockResolvedValue(undefined);
});

describe('commitBatch (portfolio)', () => {
  it('commits a matched row via the repo', async () => {
    matchedRows = [row()];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, duplicates: 0, errors: 0 });
    expect(portfolioTransactionRepository.create).toHaveBeenCalledTimes(1);
    expect(portfolioTransactionRepository.create.mock.calls[0][0]).toMatchObject({
      investment_id: 1, type: 'buy', units: 10, price_per_unit: 185.5, amount: 1855,
      preloaded_asset_class: 'stock',
    });
  });

  it('records a per-row error on oversell without aborting the batch', async () => {
    matchedRows = [row({ id: 1, type: 'sell' }), row({ id: 2, tx_hash: 'h2' })];
    portfolioTransactionRepository.create
      .mockRejectedValueOnce(Object.assign(new Error('sell units exceed available holdings'), { code: 'VALIDATION_ERROR' }))
      .mockResolvedValueOnce({ id: 101 });

    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, errors: 1 });
    expect(marked).toContainEqual(expect.objectContaining({ id: 1, status: 'error', message: expect.stringMatching(/exceed/) }));
  });

  it('flags an unresolved instrument as an error and never calls create', async () => {
    matchedRows = [row({ investment_id: null, asset_class: null })];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 0, errors: 1 });
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
    expect(marked[0]).toMatchObject({ status: 'error', message: expect.stringMatching(/unresolved/) });
  });

  it('auto-resolves FX for a non-EUR row with no supplied rate', async () => {
    matchedRows = [row({ currency: 'USD', fx_rate_to_eur: null })];
    autoResolveFxRateToEur.mockResolvedValue(0.92);
    await commitBatch({ batchId: 5 });
    expect(autoResolveFxRateToEur).toHaveBeenCalledWith('USD', '2026-01-05');
    expect(portfolioTransactionRepository.create.mock.calls[0][0].fx_rate_to_eur).toBe(0.92);
  });

  it('does not re-resolve FX when the row already carries a rate', async () => {
    matchedRows = [row({ currency: 'USD', fx_rate_to_eur: 0.9 })];
    await commitBatch({ batchId: 5 });
    expect(autoResolveFxRateToEur).not.toHaveBeenCalled();
    expect(portfolioTransactionRepository.create.mock.calls[0][0].fx_rate_to_eur).toBe(0.9);
  });

  it('skips a field-level duplicate already in portfolio_transactions', async () => {
    matchedRows = [row()];
    fieldDuplicate = true;
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 0, duplicates: 1 });
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
  });

  it('treats an intra-batch repeated tx_hash as a duplicate', async () => {
    matchedRows = [row({ id: 1, tx_hash: 'dup' }), row({ id: 2, tx_hash: 'dup' })];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, duplicates: 1 });
  });
});
