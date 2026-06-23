import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({ query: vi.fn() }));

import { query } from '../src/database/connection.js';
import { computeTradeCashLegAmount, createTradeCashLeg } from '../src/services/portfolio/tradeCashLegService.js';

beforeEach(() => vi.clearAllMocks());

describe('computeTradeCashLegAmount (ADR-090)', () => {
  it('buy debits the sleeve by amount + fees + taxes', () => {
    expect(computeTradeCashLegAmount({ type: 'buy', amount: 1000, fees: 5, taxes: 2 })).toBe(-1007);
  });

  it('sell credits net proceeds (amount − fees − taxes)', () => {
    expect(computeTradeCashLegAmount({ type: 'sell', amount: 1000, fees: 5, taxes: 2 })).toBe(993);
  });

  it('dividend / interest / rent_income credit the amount', () => {
    expect(computeTradeCashLegAmount({ type: 'dividend', amount: 50 })).toBe(50);
    expect(computeTradeCashLegAmount({ type: 'interest', amount: 12.5 })).toBe(12.5);
    expect(computeTradeCashLegAmount({ type: 'rent_income', amount: 800 })).toBe(800);
  });

  it('fee / tax debit the amount', () => {
    expect(computeTradeCashLegAmount({ type: 'fee', amount: 9 })).toBe(-9);
    expect(computeTradeCashLegAmount({ type: 'tax', amount: 3 })).toBe(-3);
  });

  it('returns null for non-cash types (gift, appreciation)', () => {
    expect(computeTradeCashLegAmount({ type: 'gift', units: 2 })).toBeNull();
    expect(computeTradeCashLegAmount({ type: 'appreciation', amount: 100 })).toBeNull();
  });

  it('handles string-typed numerics without float drift', () => {
    expect(computeTradeCashLegAmount({ type: 'buy', amount: '0.10', fees: '0.20', taxes: '0' })).toBe(-0.3);
  });
});

describe('createTradeCashLeg', () => {
  const buy = { id: 7, type: 'buy', date: '2026-06-18', amount: 1000, fees: 0, taxes: 0, currency: 'EUR' };

  it('no-ops when no cash account is designated', async () => {
    expect(await createTradeCashLeg({ portfolioTxn: buy, cashAccountId: undefined })).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('no-ops for a non-cash type even with a cash account', async () => {
    expect(await createTradeCashLeg({ portfolioTxn: { id: 8, type: 'gift', date: '2026-06-18' }, cashAccountId: 3 })).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('inserts a transfer_source=trade leg linked to the trade on the cash account', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 99 }] });
    const id = await createTradeCashLeg({ portfolioTxn: buy, cashAccountId: 3 });
    expect(id).toBe(99);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("'trade'");
    expect(sql).toContain('portfolio_transaction_id');
    expect(sql).toContain('is_transfer');
    // [date, amount(−1000), currency, memo, account_id(3), portfolio_transaction_id(7)]
    expect(params[1]).toBe(-1000);
    expect(params[4]).toBe(3);
    expect(params[5]).toBe(7);
  });
});
