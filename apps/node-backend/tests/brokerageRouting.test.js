import { describe, expect, it } from 'vitest';
import { classifyBrokerageRow, tradeDedupKey, cashDirection } from '../src/services/importPipeline/brokerageRouting.js';

describe('classifyBrokerageRow (ADR-095)', () => {
  it('routes deposits/withdrawals to a plain cash transaction', () => {
    expect(classifyBrokerageRow({ kind: 'deposit' })).toEqual({ target: 'cash' });
    expect(classifyBrokerageRow({ kind: 'withdrawal' })).toEqual({ target: 'cash' });
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

describe('cashDirection', () => {
  it('credits inflows (+1): deposit / transfer-in and EN/NL/DE synonyms', () => {
    for (const k of ['deposit', 'deposits', 'cash deposit', 'transfer in', 'storting', 'inleg', 'einzahlung']) {
      expect(cashDirection(k)).toBe(1);
    }
  });

  it('debits outflows (-1): withdrawal / transfer-out and EN/NL/DE synonyms', () => {
    for (const k of ['withdrawal', 'withdrawals', 'cash withdrawal', 'transfer out', 'opname', 'terugbetaling', 'auszahlung']) {
      expect(cashDirection(k)).toBe(-1);
    }
  });

  it('normalizes case/whitespace and defaults unknown kinds to +1', () => {
    expect(cashDirection('  WITHDRAWAL ')).toBe(-1);
    expect(cashDirection('mystery')).toBe(1);
    expect(cashDirection('')).toBe(1);
    expect(cashDirection(null)).toBe(1);
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
