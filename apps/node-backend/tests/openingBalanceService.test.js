import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../src/repositories/accountRepository.js', () => ({
  default: { getById: vi.fn() },
}));

import { query } from '../src/database/connection.js';
import accountRepository from '../src/repositories/accountRepository.js';
import {
  normalizeOpeningBalance,
  setOpeningBalance,
} from '../src/services/openingBalanceService.js';

beforeEach(() => vi.clearAllMocks());

describe('normalizeOpeningBalance (ADR-094 D4)', () => {
  const account = { currency: 'EUR' };

  it('accepts a numeric balance + ISO date and defaults currency to the account', () => {
    expect(normalizeOpeningBalance({ balance: 1234.56, date: '2024-01-01' }, account)).toEqual({
      balance: 1234.56,
      date: '2024-01-01',
      currency: 'EUR',
    });
  });

  it('coerces string-typed numerics and uppercases an explicit currency', () => {
    expect(normalizeOpeningBalance({ balance: '10', date: '2024-01-01', currency: 'usd' }, account)).toEqual({
      balance: 10,
      date: '2024-01-01',
      currency: 'USD',
    });
  });

  it('allows a zero opening balance (anchor is legitimately zero-amount)', () => {
    expect(normalizeOpeningBalance({ balance: 0, date: '2024-01-01' }, account).balance).toBe(0);
  });

  it('rejects a missing/non-numeric balance', () => {
    expect(() => normalizeOpeningBalance({ date: '2024-01-01' }, account)).toThrow(/balance/);
    expect(() => normalizeOpeningBalance({ balance: 'abc', date: '2024-01-01' }, account)).toThrow(/balance/);
  });

  it('rejects a non-ISO date', () => {
    expect(() => normalizeOpeningBalance({ balance: 1, date: '01/01/2024' }, account)).toThrow(/date/);
  });

  it('rejects an impossible calendar date the bare regex would pass', () => {
    // 2026-13-40 matches /^\d{4}-\d{2}-\d{2}$/ but is not a real date; without
    // the calendar parse-check it reaches Postgres and 500s on the DATE cast.
    expect(() => normalizeOpeningBalance({ balance: 1, date: '2026-13-40' }, account)).toThrow(/date/);
  });

  it('rejects a malformed currency', () => {
    expect(() => normalizeOpeningBalance({ balance: 1, date: '2024-01-01', currency: 'EURO' }, account)).toThrow(/currency/);
  });
});

describe('setOpeningBalance (ADR-094 D4)', () => {
  beforeEach(() => {
    accountRepository.getById.mockResolvedValue({ id: 5, currency: 'EUR' });
  });

  it('404s when the account does not exist', async () => {
    accountRepository.getById.mockResolvedValueOnce(null);
    await expect(setOpeningBalance(99, { balance: 1, date: '2024-01-01' })).rejects.toThrow(/not found/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('stamps a system anchor row (amount 0, transfer_source opening, server balance)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ earliest: null }] }) // no prior activity
      .mockResolvedValueOnce({ rows: [{ id: 42, amount: 0, balance: 1000, transfer_source: 'opening' }] });

    const result = await setOpeningBalance(5, { balance: 1000, date: '2024-01-01' });

    expect(result.warning).toBeNull();
    expect(result.transaction.id).toBe(42);

    // Second query is the upsert; params carry the server-stamped balance and currency.
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/transfer_source = 'opening'/);
    expect(sql).toMatch(/is_transfer, transfer_source, is_active/);
    expect(params).toEqual([5, 1000, 'EUR', '2024-01-01', 'OPENING BALANCE']);
  });

  it('warns when the anchor date does not precede existing activity', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ earliest: '2023-06-01' }] }) // activity predates the anchor
      .mockResolvedValueOnce({ rows: [{ id: 7 }] });

    const result = await setOpeningBalance(5, { balance: 500, date: '2024-01-01' });
    expect(result.warning).toMatch(/does not precede/i);
  });

  it('warns even when pg returns MIN(date) as a Date object (real driver shape)', async () => {
    // pg reads a DATE column as a local-midnight JS Date, not an ISO string.
    // String(Date) is "Sat Jun 01 2023 …", which is never lexically <= an ISO
    // "YYYY-MM-DD" — so the pre-fix String(earliest).slice(0,10) compare made
    // the warning dead code in production. toWireDate normalizes it first.
    query
      .mockResolvedValueOnce({ rows: [{ earliest: new Date(2023, 5, 1) }] })
      .mockResolvedValueOnce({ rows: [{ id: 8 }] });

    const result = await setOpeningBalance(5, { balance: 500, date: '2024-01-01' });
    expect(result.warning).toMatch(/does not precede/i);
  });

  it('does not warn when a Date-typed earliest is after the anchor', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ earliest: new Date(2024, 5, 1) }] })
      .mockResolvedValueOnce({ rows: [{ id: 9 }] });

    const result = await setOpeningBalance(5, { balance: 500, date: '2024-01-01' });
    expect(result.warning).toBeNull();
  });
});
