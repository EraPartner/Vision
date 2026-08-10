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

  it('D6: instrument-less dividend/interest/fee/tax route cash, signed by kind', () => {
    // Income kinds credit the sleeve, expense kinds debit it — the sign is the
    // whole point (staged magnitudes are absolute).
    expect(classifyBrokerageRow({ kind: 'dividend', hasInstrument: false })).toEqual({ target: 'cash', direction: 1 });
    expect(classifyBrokerageRow({ kind: 'interest', hasInstrument: false })).toEqual({ target: 'cash', direction: 1 });
    expect(classifyBrokerageRow({ kind: 'fee', hasInstrument: false })).toEqual({ target: 'cash', direction: -1 });
    expect(classifyBrokerageRow({ kind: 'tax', hasInstrument: false })).toEqual({ target: 'cash', direction: -1 });
  });

  it('D6 leaves everything else alone: instrument-bearing rows and trades stay portfolio', () => {
    // An explicit hasInstrument: true is the pre-D6 behavior…
    for (const kind of ['dividend', 'interest', 'fee', 'tax']) {
      expect(classifyBrokerageRow({ kind, hasInstrument: true })).toEqual({ target: 'portfolio', portfolioTxnType: kind });
    }
    // …and a TRADE without an instrument is a genuine error, not a cash
    // movement — it must keep the portfolio route where commit blocks it.
    expect(classifyBrokerageRow({ kind: 'buy', hasInstrument: false })).toEqual({ target: 'portfolio', portfolioTxnType: 'buy' });
    expect(classifyBrokerageRow({ kind: 'sell', hasInstrument: false })).toEqual({ target: 'portfolio', portfolioTxnType: 'sell' });
    // External cash kinds are indifferent to the flag.
    expect(classifyBrokerageRow({ kind: 'deposit', hasInstrument: false })).toEqual({ target: 'cash', direction: 1 });
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
