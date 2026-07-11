import { describe, expect, it } from 'vitest';
import { classifyBrokerageRow, tradeDedupKey } from '../src/services/importPipeline/brokerageRouting.js';

describe('classifyBrokerageRow (ADR-095)', () => {
  it('routes deposits/withdrawals to a plain cash transaction, with the ledger direction', () => {
    // Magnitudes are staged absolute, so the sign MUST come from the kind —
    // without it withdrawals were credited as deposits.
    expect(classifyBrokerageRow({ kind: 'deposit' })).toEqual({ target: 'cash', direction: 1 });
    expect(classifyBrokerageRow({ kind: 'withdrawal' })).toEqual({ target: 'cash', direction: -1 });
    expect(classifyBrokerageRow({ kind: 'transfer in' })).toEqual({ target: 'cash', direction: 1 });
    expect(classifyBrokerageRow({ kind: 'transfer out' })).toEqual({ target: 'cash', direction: -1 });
    expect(classifyBrokerageRow({ kind: 'storting' })).toEqual({ target: 'cash', direction: 1 });
    expect(classifyBrokerageRow({ kind: 'opname' })).toEqual({ target: 'cash', direction: -1 });
    expect(classifyBrokerageRow({ kind: 'einzahlung' })).toEqual({ target: 'cash', direction: 1 });
    expect(classifyBrokerageRow({ kind: 'auszahlung' })).toEqual({ target: 'cash', direction: -1 });
  });

  it('routes buy/sell/dividend/interest/fee/tax to a portfolio_transaction (cash leg follows)', () => {
    for (const kind of ['buy', 'sell', 'dividend', 'interest', 'fee', 'tax']) {
      expect(classifyBrokerageRow({ kind })).toEqual({ target: 'portfolio', portfolioTxnType: kind });
    }
  });

  it('normalizes case/whitespace', () => {
    expect(classifyBrokerageRow({ kind: '  BUY ' })).toEqual({ target: 'portfolio', portfolioTxnType: 'buy' });
  });

  it('blocks unknown kinds on review rather than guessing', () => {
    expect(classifyBrokerageRow({ kind: 'mystery' })).toEqual({ target: 'review' });
    expect(classifyBrokerageRow({})).toEqual({ target: 'review' });
  });
});

describe('tradeDedupKey', () => {
  it('is stable and identical for the same trade (idempotent re-import)', () => {
    const row = { account_id: 3, investment_id: 7, date: '2026-06-18', kind: 'BUY', units: 10, amount: 1000 };
    const again = { account_id: '3', investment_id: '7', date: '2026-06-18', kind: 'buy', units: '10', amount: '1000' };
    expect(tradeDedupKey(row)).toBe(tradeDedupKey(again));
  });

  it('differs when any identifying field differs', () => {
    const base = { account_id: 3, investment_id: 7, date: '2026-06-18', kind: 'buy', units: 10, amount: 1000 };
    expect(tradeDedupKey(base)).not.toBe(tradeDedupKey({ ...base, units: 11 }));
    expect(tradeDedupKey(base)).not.toBe(tradeDedupKey({ ...base, account_id: 4 }));
  });
});
