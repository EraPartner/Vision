// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createQueryWrapper } from '@/test/queryWrapper';
import { usePortfolioSummaries } from '@/hooks/portfolio/usePortfolioSummaries';
import type { Investment, PortfolioTransaction } from '@/types/api';

// usePortfolioSummaries pulls FX rates via useExchangeRates (useQuery), so the
// hook needs a QueryClientProvider. The query is left unresolved on purpose: the
// rate map degrades to EUR-only (multiplier 1), which is correct for the all-EUR
// fixtures below.
const makeWrapper = createQueryWrapper;

const inv = (overrides: Partial<Investment>): Investment =>
  ({
    id: 1,
    name: 'X',
    asset_class: 'stock',
    currency: 'EUR',
    current_price: 0,
    interest_rate: 0,
    is_active: true,
    ...overrides,
  }) as unknown as Investment;

const txn = (overrides: Partial<PortfolioTransaction>): PortfolioTransaction =>
  ({
    id: 1,
    investment_id: 1,
    type: 'buy',
    amount: 0,
    units: 0,
    fees: 0,
    taxes: 0,
    date: '2026-01-01',
    currency: 'EUR',
    ...overrides,
  }) as unknown as PortfolioTransaction;

function gainLossOf(investments: Investment[], transactions: PortfolioTransaction[]) {
  const { result } = renderHook(() => usePortfolioSummaries({ investments, transactions }), {
    wrapper: makeWrapper(),
  });
  return result.current.summaries[0].gainLoss;
}

describe('usePortfolioSummaries — gainLoss does not double-count (FE mirror of backend)', () => {
  it('unit-based: a buy fee is folded into cost basis only once', () => {
    // Paid 110 (100 + 10 fee), worth 150 → economic gain 40 (was 30 before fix).
    const gainLoss = gainLossOf(
      [inv({ asset_class: 'stock', current_price: 150 })],
      [txn({ type: 'buy', amount: 100, units: 1, fees: 10 })],
    );
    expect(gainLoss).toBe(40);
  });

  it('real estate: rent + fees + taxes counted once', () => {
    // appreciation 10000 + rent 12000 − fees 2000 − taxes 1000 = 19000 (was 28000).
    const gainLoss = gainLossOf(
      [inv({ asset_class: 'real_estate', current_price: 0 })],
      [
        txn({ id: 1, type: 'buy', amount: 250000 }),
        txn({ id: 2, type: 'appreciation', amount: 10000 }),
        txn({ id: 3, type: 'rent_income', amount: 12000 }),
        txn({ id: 4, type: 'fee', amount: 2000 }),
        txn({ id: 5, type: 'tax', amount: 1000 }),
      ],
    );
    expect(gainLoss).toBe(19000);
  });

  it('fixed income: interest received counted once', () => {
    // One 400 interest payment, no accrual → 400 (was 800: realized + income).
    const gainLoss = gainLossOf(
      [inv({ asset_class: 'savings', interest_rate: 0, current_price: 0 })],
      [
        txn({ id: 1, type: 'buy', amount: 10000, date: '2025-01-01' }),
        txn({ id: 2, type: 'interest', amount: 400, date: '2026-01-01' }),
      ],
    );
    expect(gainLoss).toBe(400);
  });
});
