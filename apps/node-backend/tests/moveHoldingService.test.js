import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTxConnection } from './helpers/repoMocks.js';
const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }));

vi.mock('../src/database/connection.js', () => mockTxConnection(mockClient));

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

  it('partial move (proportional): splits every buy lot by the same fraction', async () => {
    route({ lots: [
      { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      { id: 11, type: 'buy', date: '2021-01-01', amount: 2000, units: 10, fees: 20, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
    ]});
    const r = await moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2, units: 10, strategy: 'proportional' });
    // 10 of 20 units → fraction 0.5 of BOTH lots; no whole-lot re-points.
    expect(r).toMatchObject({ mode: 'partial', strategy: 'proportional', movedUnits: 10, lotsMoved: 0, lotsSplit: 2 });

    const calls = mockClient.query.mock.calls;
    // No bulk re-point in proportional mode.
    expect(calls.find(([s]) => s.includes('SET account_id = $1') && s.includes('ANY'))).toBeUndefined();
    // Both lots get a 5-unit moved sibling on account 2.
    const childUnitUpdates = calls.filter(([s]) => s.includes('SET units = $1'));
    expect(childUnitUpdates).toHaveLength(2);
    expect(childUnitUpdates.every(([, p]) => p[0] === 5)).toBe(true);
    const inserts = calls.filter(([s]) => s.includes('INSERT INTO'));
    expect(inserts).toHaveLength(2);
    // Lot 11 moved half its 2000 cost + 20 fees → 1000 amount, 10 fees, account 2, 5 units.
    expect(inserts.some(([, p]) => p.includes(1000) && p.includes(10) && p.includes(2) && p.includes(5))).toBe(true);
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

  // ── Corporate-action / prior-sell awareness (the C2 fix) ──────────────────

  it('counts held units after a split (units = new absolute total)', async () => {
    // Buy 10 → 2:1 split (row units = 20 post-split total). Held = 20, not 30.
    route({ lots: [
      { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      { id: 11, type: 'split', date: '2021-01-01', amount: 0, units: 20, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
    ]});
    const r = await moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2 });
    expect(r.mode).toBe('whole');
    expect(r.movedUnits).toBe(20); // split applied — the old buy−sell sum would have said 30
    // The whole move re-points the buy AND the split row together.
    const repoint = mockClient.query.mock.calls.find(([s]) => s.includes('SET account_id = $1') && s.includes('ANY'));
    expect(repoint[1]).toEqual([2, [10, 11]]);
  });

  it('rejects moving more units than held once a split has been applied', async () => {
    route({ lots: [
      { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      { id: 11, type: 'split', date: '2021-01-01', amount: 0, units: 20, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
    ]});
    // 25 > 20 held — must reject (the stale sum would have allowed up to 30).
    await expect(moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2, units: 25 }))
      .rejects.toThrow(ValidationError);
  });

  it('refuses a partial move once the source has a prior sell (unsound lot model)', async () => {
    route({ lots: [
      { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      { id: 11, type: 'buy', date: '2020-06-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      { id: 12, type: 'sell', date: '2021-01-01', amount: 400, units: 4, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
    ]});
    // Held = 16; a partial move would physically split a buy lot dated before
    // the sell, retroactively changing the sell's replayed basis → reject.
    await expect(moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2, units: 5 }))
      .rejects.toThrow(/whole holding|sell or split/i);
  });

  it('refuses a partial move once the source has a split', async () => {
    route({ lots: [
      { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      { id: 11, type: 'split', date: '2021-01-01', amount: 0, units: 20, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
    ]});
    await expect(moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2, units: 5 }))
      .rejects.toThrow(ValidationError);
  });

  it('still allows a whole move after a sell (moves the entire history)', async () => {
    route({ lots: [
      { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      { id: 11, type: 'sell', date: '2021-01-01', amount: 400, units: 4, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
    ]});
    const r = await moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2, units: 6 });
    expect(r.mode).toBe('whole'); // requested 6 == net (10−4) → whole
    expect(r.movedUnits).toBe(6);
  });

  it('return_of_capital does not change held units', async () => {
    route({ lots: [
      { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      { id: 11, type: 'return_of_capital', date: '2021-01-01', amount: 200, units: 0, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
    ]});
    const r = await moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2 });
    expect(r.movedUnits).toBe(10); // RoC leaves units untouched
  });

  // ── Investment-wide split replay (the C-scoped fix) ───────────────────────
  //
  // Splits are corporate actions recorded once for the whole investment, often
  // with a NULL account_id. An account-filtered replay never sees them, so the
  // partial-move guard would not trip and FIFO would split lots at stale
  // pre-split units. These tests mock the two SELECTs separately: the
  // account-local query (`account_id = $2`) and the investment-wide one.

  // Distinguishes the account-local lot query from the investment-wide one.
  function routeWide({ localLots, wideLots, accounts = [1, 2], assetClass = 'stock' }) {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('FROM accounts WHERE id = ANY')) return { rows: accounts.map((id) => ({ id })) };
      if (sql.includes('asset_class FROM investments')) return { rows: [{ asset_class: assetClass }] };
      if (sql.includes('to_regclass')) return { rows: [{ r: 'public.portfolio_transactions_base' }] };
      // Order matters: the account-local query also contains 'ORDER BY date'.
      if (sql.includes('FROM portfolio_transactions') && sql.includes('account_id = $2')) return { rows: localLots };
      if (sql.includes('FROM portfolio_transactions') && sql.includes('ORDER BY date')) return { rows: wideLots };
      return { rowCount: 1, rows: [] };
    });
  }

  it('a NULL-account split trips the partial-move guard (buy 10 / 2:1 split / move 5)', async () => {
    // The source account holds only the buy; the 2:1 split (units = 20 absolute
    // post-split total) is a corporate-action row with NO account, so it is
    // absent from the account-local query but present investment-wide.
    routeWide({
      localLots: [
        { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      ],
      wideLots: [
        { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
        { id: 11, type: 'split', date: '2021-01-01', amount: 0, units: 20, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      ],
    });
    // Pre-fix: split invisible → net stays 10, no consumption → move 5 proceeds
    // and buys lots at half basis. Post-fix: the split makes hasPriorConsumption
    // true, so the partial move is rejected.
    await expect(moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2, units: 5 }))
      .rejects.toThrow(/whole holding|sell or split/i);
  });

  it('a NULL-account split ratio is applied to account-local units (whole move reports post-split total)', async () => {
    routeWide({
      localLots: [
        { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      ],
      wideLots: [
        { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
        { id: 11, type: 'split', date: '2021-01-01', amount: 0, units: 20, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      ],
    });
    const r = await moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 2 });
    expect(r.mode).toBe('whole');
    expect(r.movedUnits).toBe(20); // 10 buy × (20/10 split ratio) = 20 post-split
    // Only the account-local buy is repointed — the NULL-account split row stays.
    const repoint = mockClient.query.mock.calls.find(([s]) => s.includes('SET account_id = $1') && s.includes('ANY'));
    expect(repoint[1]).toEqual([2, [10]]);
  });

  it('split ratio uses the investment-wide denominator, not the account-local total', async () => {
    // Source (acct 1) holds buy 10; another account holds buy 10; a 2:1 split
    // (units = 40 = new investment-wide total) carries the source account. The
    // ratio must be 40/20 = 2 (investment-wide), giving 20 local units — not
    // 40/10 = 4 (account-local) which would inflate to 40.
    routeWide({
      accounts: [1, 3],
      localLots: [
        { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
        { id: 30, type: 'split', date: '2021-01-01', amount: 0, units: 40, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      ],
      wideLots: [
        { id: 10, type: 'buy', date: '2020-01-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
        { id: 20, type: 'buy', date: '2020-06-01', amount: 1000, units: 10, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
        { id: 30, type: 'split', date: '2021-01-01', amount: 0, units: 40, fees: 0, taxes: 0, currency: 'EUR', fx_rate_to_eur: 1 },
      ],
    });
    const r = await moveHolding({ investmentId: 1, fromAccountId: 1, toAccountId: 3 });
    expect(r.mode).toBe('whole');
    expect(r.movedUnits).toBe(20); // 10 × (40/20) = 20, not the inflated 40
  });
});
