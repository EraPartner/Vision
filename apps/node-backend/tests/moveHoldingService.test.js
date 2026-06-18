import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }));

vi.mock('../src/database/connection.js', () => ({
  withTransaction: vi.fn(async (fn) => fn(mockClient)),
}));

import { moveHolding } from '../src/services/portfolio/moveHoldingService.js';
import { ValidationError, NotFoundError } from '../src/middleware/errorHandler.js';

// Routes the shared client mock. `lots` is the (investment, fromAccount) lot set returned by the
// view SELECT; `inheritance` toggles the schema shape.
function route({ lots = [], inheritance = true, accounts = [1, 2], assetClass = 'stock' } = {}) {
  mockClient.query.mockImplementation(async (sql) => {
    if (sql.includes('FROM accounts WHERE id = ANY')) return { rows: accounts.map((id) => ({ id })) };
    if (sql.includes('asset_class FROM investments')) return { rows: [{ asset_class: assetClass }] };
    if (sql.includes('to_regclass')) return { rows: [{ r: inheritance ? 'public.portfolio_transactions_base' : null }] };
    if (sql.includes('FROM portfolio_transactions') && sql.includes('ORDER BY date')) return { rows: lots };
    return { rowCount: 1, rows: [] };
  });
}

beforeEach(() => vi.clearAllMocks());

describe('moveHolding (ADR-091)', () => {
  it('rejects same-account and non-positive units', async () => {
    await expect(moveHolding({ investmentId: 1, fromAccountId: 2, toAccountId: 2 })).rejects.toThrow(ValidationError);
    await expect(moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2, units: 0 })).rejects.toThrow(ValidationError);
  });

  it('throws NotFound when an account is missing', async () => {
    route({ accounts: [1] }); // account 2 missing
    await expect(moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2 })).rejects.toThrow(NotFoundError);
  });

  it('whole move re-points every lot (units omitted)', async () => {
    route({ lots: [
      { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      { id: 11, type: 'sell', date: '2021-01-01', amount: 300, units: 3, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
    ]});
    const r = await moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2 });
    expect(r.mode).toBe('whole');
    expect(r.movedUnits).toBe(7); // net = 10 buy − 3 sell
    const repoint = mockClient.query.mock.calls.find(([s]) => s.includes('SET account_id = $1') && s.includes('ANY'));
    expect(repoint[1]).toEqual([2, [10, 11]]); // all lots, incl. the sell
  });

  it('partial move: FIFO full-lot re-point + pro-rata boundary split', async () => {
    route({ lots: [
      { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      { id: 11, type: 'buy', date: '2021-01-01', amount: 2000, units: 10, fees: 20, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
    ]});
    const r = await moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2, units: 15 });
    expect(r).toMatchObject({ mode: 'partial', movedUnits: 15, lotsMoved: 1, lotsSplit: 1 });

    const calls = mockClient.query.mock.calls;
    // lot 10 fully re-pointed
    const repoint = calls.find(([s]) => s.includes('SET account_id = $1') && s.includes('ANY'));
    expect(repoint[1]).toEqual([2, [10]]);
    // boundary lot 11: move 5 of 10 (f=0.5) → stay amount 1000, stay fees 10
    const stayUpd = calls.find(([s]) => s.includes('UPDATE portfolio_transactions_base SET amount'));
    expect(stayUpd[1]).toEqual([1000, 10, 0, 11]); // amount, fees, taxes, id
    const childUnits = calls.find(([s]) => s.includes('SET units = $1'));
    expect(childUnits[1]).toEqual([5, 11]);
    // inserted target lot: 5 units, amount 1000, fees 10, account 2
    const insert = calls.find(([s]) => s.startsWith('\n          INSERT INTO') || s.includes('INSERT INTO stock_transactions'));
    expect(insert[1]).toEqual(expect.arrayContaining([1000, 10, 2, 5]));
  });

  it('rejects moving more units than held', async () => {
    route({ lots: [{ id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 }] });
    await expect(moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2, units: 50 })).rejects.toThrow(ValidationError);
  });

  it('non-unit-based investment always does a whole move even if units passed', async () => {
    route({ assetClass: 'savings', lots: [{ id: 20, type: 'buy', date: '2020-01-01', amount: 5000, units: null, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 }] });
    const r = await moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2, units: 100 });
    expect(r.mode).toBe('whole');
  });
});
