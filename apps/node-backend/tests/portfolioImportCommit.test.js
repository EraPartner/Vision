import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  // Transaction shim: run the callback; a throw propagates (= rollback).
  // The repo + leg service are module-mocked, so the client goes unused.
  withTransaction: vi.fn(async (fn) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) })),
}));

vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({
  default: { create: vi.fn(), hardDelete: vi.fn() },
}));

vi.mock('../src/services/portfolio/fxResolve.js', () => ({
  autoResolveFxRateToEur: vi.fn(),
}));

vi.mock('../src/services/portfolio/tradeCashLegService.js', () => ({
  createTradeCashLeg: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import portfolioTransactionRepository from '../src/repositories/portfolioTransactionRepository.js';
import { autoResolveFxRateToEur } from '../src/services/portfolio/fxResolve.js';
import { createTradeCashLeg } from '../src/services/portfolio/tradeCashLegService.js';
import { commitBatch } from '../src/services/portfolioImportPipeline/commit.js';

let matchedRows;
let fieldDuplicate;
let marked;
let batchAccountId;
let isBrokerage;
let cashDuplicate;

function dispatch(sql, params) {
  if (/SELECT account_id, is_brokerage FROM portfolio_import_batches/.test(sql)) {
    return { rows: [{ account_id: batchAccountId, is_brokerage: isBrokerage }] };
  }
  if (/FROM portfolio_import_staging_rows isr/.test(sql)) return { rows: matchedRows };
  if (/FROM portfolio_transactions\s+WHERE investment_id/.test(sql)) {
    return { rows: fieldDuplicate ? [{ '?column?': 1 }] : [] };
  }
  if (/SELECT 1 FROM transactions/.test(sql)) {
    return { rows: cashDuplicate ? [{ '?column?': 1 }] : [] };
  }
  if (/INSERT INTO transactions/.test(sql)) return { rows: [{ id: 777 }] };
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
  batchAccountId = null;
  isBrokerage = false;
  cashDuplicate = false;
  query.mockReset();
  query.mockImplementation((sql, params) => Promise.resolve(dispatch(sql, params)));
  portfolioTransactionRepository.create.mockReset();
  portfolioTransactionRepository.create.mockResolvedValue({ id: 100 });
  autoResolveFxRateToEur.mockReset();
  autoResolveFxRateToEur.mockResolvedValue(undefined);
  createTradeCashLeg.mockReset();
  createTradeCashLeg.mockResolvedValue(900);
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

  it('field-dedup predicate matches on account_id and currency, not just trade shape', async () => {
    batchAccountId = 7;
    matchedRows = [row({ currency: 'USD', fx_rate_to_eur: 0.9 })];
    await commitBatch({ batchId: 5 });
    const dedupCall = query.mock.calls.find(([sql]) => /FROM portfolio_transactions\s+WHERE investment_id/.test(sql));
    expect(dedupCall[0]).toContain('account_id IS NOT DISTINCT FROM');
    // [investment_id, tx_date, type, amount, units, account_id, currency]
    expect(dedupCall[1].slice(5)).toEqual([7, 'USD']);
  });

  it('stamps the batch-level account_id onto every committed lot (ADR-095)', async () => {
    batchAccountId = 7;
    matchedRows = [row()];
    await commitBatch({ batchId: 5 });
    expect(portfolioTransactionRepository.create.mock.calls[0][0].account_id).toBe(7);
  });

  it('leaves account_id undefined when the batch has no account', async () => {
    batchAccountId = null;
    matchedRows = [row()];
    await commitBatch({ batchId: 5 });
    expect(portfolioTransactionRepository.create.mock.calls[0][0].account_id).toBeUndefined();
  });

  it('treats an intra-batch repeated tx_hash as a duplicate', async () => {
    matchedRows = [row({ id: 1, tx_hash: 'dup' }), row({ id: 2, tx_hash: 'dup' })];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, duplicates: 1 });
  });

  // ── Brokerage fan-out (ADR-095) ─────────────────────────────────────────────
  it('brokerage trade row: creates the lot + its ADR-090 cash leg, no standalone cash row', async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [row({ route: 'portfolio', type: 'buy', type_raw: 'buy' })];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, legs: 1 });
    expect(createTradeCashLeg).toHaveBeenCalledTimes(1);
    expect(createTradeCashLeg.mock.calls[0][0].cashAccountId).toBe(7);
    // No standalone cash INSERT for the trade (its leg is the cash effect).
    const cashInserts = query.mock.calls.filter(([s]) => /INSERT INTO transactions/.test(s));
    expect(cashInserts).toHaveLength(0);
  });

  it('brokerage trade: rolls back the trade and errors the row when the cash leg fails (ADR-095 atomicity)', async () => {
    isBrokerage = true;
    batchAccountId = 7;
    portfolioTransactionRepository.create.mockResolvedValueOnce({ id: 555, amount: -1000, fees: 0, taxes: 0 });
    createTradeCashLeg.mockRejectedValueOnce(new Error('leg insert failed'));
    matchedRows = [row({ route: 'portfolio', type: 'buy', type_raw: 'buy' })];

    const res = await commitBatch({ batchId: 5 });
    // The pair shares one DB transaction: the leg failure rejects the
    // withTransaction callback, rolling the trade back with it — no
    // compensating delete (which had a crash window between create and delete).
    expect(res).toMatchObject({ imported: 0, errors: 1, legs: 0 });
    expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
    expect(marked[0]).toMatchObject({ status: 'error', message: expect.stringMatching(/cash leg/) });
  });

  it('brokerage cash row: inserts a cash transaction, no trade/leg', async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [row({ id: 9, route: 'cash', type: null, type_raw: 'deposit', investment_id: null, amount: 1000, note: 'wire' })];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, legs: 0 });
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
    expect(createTradeCashLeg).not.toHaveBeenCalled();
    const cashInserts = query.mock.calls.filter(([s]) => /INSERT INTO transactions/.test(s));
    expect(cashInserts).toHaveLength(1);
  });

  it('brokerage withdrawal: debits the sleeve (negative amount) even though staging is absolute', async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [row({ id: 9, route: 'cash', type: null, type_raw: 'withdrawal', investment_id: null, amount: 500 })];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1 });
    const cashInsert = query.mock.calls.find(([s]) => /INSERT INTO transactions/.test(s));
    expect(cashInsert[1][1]).toBe(-500); // amount param — was +500 (credited as a deposit)
  });

  it('brokerage cash row: dedups against an existing cash transaction', async () => {
    isBrokerage = true;
    batchAccountId = 7;
    cashDuplicate = true;
    matchedRows = [row({ id: 9, route: 'cash', type: null, type_raw: 'deposit', investment_id: null, amount: 1000 })];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 0, duplicates: 1 });
  });

  it('brokerage cash row with no batch account is an error', async () => {
    isBrokerage = true;
    batchAccountId = null;
    matchedRows = [row({ id: 9, route: 'cash', type: null, type_raw: 'deposit', investment_id: null, amount: 1000 })];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 0, errors: 1 });
    expect(marked[0]).toMatchObject({ status: 'error', message: expect.stringMatching(/account/) });
  });
});
