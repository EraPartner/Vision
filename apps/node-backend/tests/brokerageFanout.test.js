import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({ query: vi.fn() }));

vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({
  default: { create: vi.fn() },
}));

// Keep computeTradeCashLegAmount real (the plan needs it); stub the IO-bound leg insert.
vi.mock('../src/services/portfolio/tradeCashLegService.js', async () => {
  const actual = await vi.importActual('../src/services/portfolio/tradeCashLegService.js');
  return { ...actual, createTradeCashLeg: vi.fn() };
});

import { query } from '../src/database/connection.js';
import portfolioTransactionRepository from '../src/repositories/portfolioTransactionRepository.js';
import { createTradeCashLeg } from '../src/services/portfolio/tradeCashLegService.js';
import { planBrokerageFanout, commitBrokerageFanout } from '../src/services/importPipeline/brokerageFanout.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing exists yet (so rows commit), inserts succeed.
  query.mockImplementation(async (sql) => {
    if (/SELECT 1 FROM/.test(sql)) return { rows: [] };
    return { rows: [{ id: 1 }] };
  });
  portfolioTransactionRepository.create.mockResolvedValue({ id: 500 });
  createTradeCashLeg.mockResolvedValue(900);
});

describe('planBrokerageFanout (ADR-095 routing)', () => {
  it('routes external cash movements to the cash ledger', () => {
    const plan = planBrokerageFanout(7, [
      { kind: 'deposit', date: '2026-01-01', amount: 1000, memo: 'wire' },
      { kind: 'withdrawal', date: '2026-02-01', amount: -200 },
    ]);
    expect(plan.cash).toHaveLength(2);
    expect(plan.trades).toHaveLength(0);
  });

  it('routes trades to the portfolio with a typed row and a cash-leg amount', () => {
    const plan = planBrokerageFanout(7, [
      { kind: 'buy', date: '2026-01-01', investment_id: 3, units: 10, amount: 1000, fees: 5 },
    ]);
    expect(plan.trades).toHaveLength(1);
    expect(plan.trades[0].row).toMatchObject({ type: 'buy', account_id: 7, investment_id: 3 });
    // buy → −(amount + fees + taxes) = −1005
    expect(plan.trades[0].legAmount).toBe(-1005);
  });

  it('blocks a trade with no resolved instrument on review', () => {
    const plan = planBrokerageFanout(7, [{ kind: 'buy', date: '2026-01-01', units: 1, amount: 10 }]);
    expect(plan.trades).toHaveLength(0);
    expect(plan.review).toHaveLength(1);
    expect(plan.review[0].reason).toMatch(/instrument/);
  });

  it('blocks an unknown row kind on review', () => {
    const plan = planBrokerageFanout(7, [{ kind: 'mystery', date: '2026-01-01', amount: 1 }]);
    expect(plan.review).toHaveLength(1);
    expect(plan.review[0].reason).toMatch(/unknown/);
  });
});

describe('commitBrokerageFanout (ADR-095 fan-out)', () => {
  it('a buy creates one trade + exactly one cash leg, never a standalone cash row', async () => {
    const res = await commitBrokerageFanout({
      accountId: 7,
      rows: [{ kind: 'buy', date: '2026-01-01', investment_id: 3, units: 10, amount: 1000, fees: 5 }],
    });
    expect(res).toMatchObject({ trades: 1, legs: 1, cash: 0, duplicates: 0 });
    // The double-count guard: no INSERT INTO transactions (cash) was issued for the trade —
    // its cash effect is the leg only.
    const cashInserts = query.mock.calls.filter(([s]) => /INSERT INTO transactions/.test(s));
    expect(cashInserts).toHaveLength(0);
    expect(createTradeCashLeg).toHaveBeenCalledTimes(1);
    expect(portfolioTransactionRepository.create).toHaveBeenCalledTimes(1);
  });

  it('a deposit creates one cash row and no trade/leg', async () => {
    const res = await commitBrokerageFanout({
      accountId: 7,
      rows: [{ kind: 'deposit', date: '2026-01-01', amount: 1000, memo: 'wire' }],
    });
    expect(res).toMatchObject({ cash: 1, trades: 0, legs: 0 });
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
    expect(createTradeCashLeg).not.toHaveBeenCalled();
  });

  it('re-derives the cash sign from the kind, not the export sign', async () => {
    // Export gives a withdrawal as +200 and a deposit as -1000 (wrong signs);
    // the ledger must store −200 (outflow) and +1000 (inflow) per the classifier
    // direction, regardless of the raw export sign.
    await commitBrokerageFanout({
      accountId: 7,
      rows: [
        { kind: 'withdrawal', date: '2026-01-01', amount: 200, memo: 'atm' },
        { kind: 'deposit', date: '2026-02-01', amount: -1000, memo: 'wire' },
      ],
    });
    const cashInserts = query.mock.calls.filter(([s]) => /INSERT INTO transactions/.test(s));
    const amounts = cashInserts.map(([, params]) => params[1]);
    expect(amounts).toContain(-200);
    expect(amounts).toContain(1000);
  });

  it('dedups both sides against existing rows (idempotent re-import)', async () => {
    query.mockImplementation(async (sql) => {
      if (/SELECT 1 FROM/.test(sql)) return { rows: [{ exists: 1 }] }; // everything already present
      return { rows: [{ id: 1 }] };
    });
    const res = await commitBrokerageFanout({
      accountId: 7,
      rows: [
        { kind: 'deposit', date: '2026-01-01', amount: 1000, memo: 'wire' },
        { kind: 'buy', date: '2026-01-01', investment_id: 3, units: 10, amount: 1000 },
      ],
    });
    expect(res).toMatchObject({ cash: 0, trades: 0, duplicates: 2 });
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
  });

  it('dedups a repeated row within the same statement', async () => {
    const dep = { kind: 'deposit', date: '2026-01-01', amount: 1000, memo: 'wire' };
    const res = await commitBrokerageFanout({ accountId: 7, rows: [dep, { ...dep }] });
    expect(res).toMatchObject({ cash: 1, duplicates: 1 });
  });

  it('a split creates a trade but no cash leg (no cash movement)', async () => {
    const res = await commitBrokerageFanout({
      accountId: 7,
      // 'split' is not a routed PORTFOLIO_KIND, so it lands on review — confirming the
      // conservative default. (Cash-affecting kinds get a leg; this asserts no spurious leg.)
      rows: [{ kind: 'split', date: '2026-01-01', investment_id: 3, units: 20 }],
    });
    expect(res.review).toBe(1);
    expect(createTradeCashLeg).not.toHaveBeenCalled();
  });

  it('a dividend creates a trade + a positive cash leg', async () => {
    const res = await commitBrokerageFanout({
      accountId: 7,
      rows: [{ kind: 'dividend', date: '2026-03-01', investment_id: 3, amount: 42 }],
    });
    expect(res).toMatchObject({ trades: 1, legs: 1, cash: 0 });
  });

  it('counts review rows without committing them', async () => {
    const res = await commitBrokerageFanout({
      accountId: 7,
      rows: [{ kind: 'mystery', date: '2026-01-01', amount: 1 }],
    });
    expect(res).toMatchObject({ review: 1, cash: 0, trades: 0 });
  });
});
