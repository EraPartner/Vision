import { describe, it, expect } from 'vitest';
import { buildInvestmentSummaryCore } from '@vision/shared-utils/portfolio';
import { accountPositionsFor } from '@/hooks/portfolio/useAccountPositions';
import { toNumber } from '@/lib/money';
import type { Investment, PortfolioTransaction } from '@/types/api';

const inv = {
  id: 1,
  name: 'AAPL',
  asset_class: 'stock',
  currency: 'EUR',
  current_price: 12,
  interest_rate: 0,
  is_active: true,
} as unknown as Investment;

const txn = (o: Partial<PortfolioTransaction>): PortfolioTransaction =>
  ({
    id: 1,
    investment_id: 1,
    type: 'buy',
    amount: 0,
    units: 0,
    fees: 0,
    taxes: 0,
    date: '2025-01-01',
    currency: 'EUR',
    ...o,
  }) as unknown as PortfolioTransaction;

const OPTS = {
  costBasisMethod: 'weighted_avg' as const,
  multiplier: 1,
  today: '2026-06-18',
  accountName: (id: number) => ({ 10: 'IBKR', 20: 'Degiro' }[id] ?? `#${id}`),
};

describe('accountPositionsFor (ADR-091 per-account split)', () => {
  it('splits a holding across its custodian accounts', () => {
    const txns = [
      txn({ id: 1, account_id: 10, units: 100, amount: 1000 }),
      txn({ id: 2, account_id: 20, units: 50, amount: 500 }),
    ];
    const positions = accountPositionsFor(inv, txns, OPTS);

    expect(positions).toHaveLength(2);
    // Sorted by current value desc → IBKR (100 units) first.
    expect(positions[0]).toMatchObject({ accountId: 10, accountName: 'IBKR', totalUnits: 100 });
    expect(positions[1]).toMatchObject({ accountId: 20, accountName: 'Degiro', totalUnits: 50 });
  });

  it('re-sums to the whole-investment totals (the ADR-091 guarantee)', () => {
    const txns = [
      txn({ id: 1, account_id: 10, units: 100, amount: 1000 }),
      txn({ id: 2, account_id: 20, units: 50, amount: 500 }),
      txn({ id: 3, account_id: 10, type: 'sell', units: 30, amount: 360 }),
    ];
    const whole = buildInvestmentSummaryCore(inv, txns, { costBasisMethod: 'weighted_avg', todayYmd: OPTS.today });
    const positions = accountPositionsFor(inv, txns, OPTS);

    const sum = (k: 'totalUnits' | 'currentValue' | 'costBasis' | 'gainLoss') =>
      positions.reduce((acc, p) => acc + p[k], 0);

    expect(sum('totalUnits')).toBeCloseTo(toNumber(whole.totalUnits), 6);
    expect(sum('currentValue')).toBeCloseTo(toNumber(whole.currentValue), 2);
    expect(sum('costBasis')).toBeCloseTo(toNumber(whole.totalBuyCost), 2);
    expect(sum('gainLoss')).toBeCloseTo(toNumber(whole.gainLoss), 2);
  });

  it('labels lots with no account as unassigned (null)', () => {
    const positions = accountPositionsFor(inv, [txn({ id: 1, units: 10, amount: 100 })], OPTS);
    expect(positions).toEqual([
      expect.objectContaining({ accountId: null, accountName: null, totalUnits: 10 }),
    ]);
  });
});
