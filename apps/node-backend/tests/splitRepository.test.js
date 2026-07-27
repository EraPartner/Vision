import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTxConnection } from './helpers/repoMocks.js';
// Owed-detail / owed-export used to LEFT JOIN a whole-table
// `SELECT split_id, SUM(amount) ... GROUP BY split_id` aggregate of
// split_payments on every call. These tests pin the rewrite to a per-split
// LATERAL aggregate (only the relevant rows) while preserving numeric output.

vi.mock('../src/database/connection.js', () => mockTxConnection());

import { query } from '../src/database/connection.js';
import splitRepository from '../src/repositories/splitRepository.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('splitRepository owed aggregates use a per-split LATERAL sum', () => {
  it('getOwedByRecipient correlates SUM(amount) to the split, not the whole table', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          transaction_id: 9,
          recipient_id: 7,
          amount: '30.00',
          note: null,
          is_settled: false,
          created_at: '2026-03-01',
          updated_at: '2026-03-01',
          transaction_date: '2026-03-01',
          transaction_memo: 'Dinner',
          transaction_amount: '60.00',
          transaction_currency: 'EUR',
          bank_account: 'Main',
          transaction_recipient_name: 'Alice',
          amount_paid: '12.00',
        },
      ],
    });

    const rows = await splitRepository.getOwedByRecipient(7);

    const sql = query.mock.calls[0][0];
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('WHERE split_id = ts.id');
    expect(sql).not.toContain('GROUP BY split_id');

    // Numeric shape preserved: amount_paid summed, remaining = amount - paid.
    expect(rows[0].amount_paid).toBe(12);
    expect(rows[0].remaining).toBe(18);
  });

  it('getOwedExportRowsByRecipient correlates SUM(amount) to the split, not the whole table', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          date: '2026-03-01',
          bank_account: 'Main',
          recipient_name: 'Alice',
          memo: 'Dinner',
          amount: '18.00',
          currency: 'EUR',
          balance: '100.00',
          category_name: 'FOOD:DINNER',
          comment: null,
        },
      ],
    });

    const rows = await splitRepository.getOwedExportRowsByRecipient(7);

    const sql = query.mock.calls[0][0];
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('WHERE split_id = ts.id');
    expect(sql).not.toContain('GROUP BY split_id');

    // amount (split remaining) coerced to a number, rest passed through.
    expect(rows[0].amount).toBe(18);
    expect(rows[0].category_name).toBe('FOOD:DINNER');
  });
});

describe('splitRepository emits coerced money on every write path', () => {
  it('addPayment returns the same wire shape as getPayments (number amount, wire paid_at)', async () => {
    // 1) lock the split, 2) sum existing payments, 3) INSERT the payment,
    // 4) auto-settle probe, 5) audit insert.
    query
      .mockResolvedValueOnce({ rows: [{ id: 7, amount: '30.00' }] })
      .mockResolvedValueOnce({ rows: [{ paid: '0' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 3,
          split_id: 7,
          amount: '12.50',
          note: null,
          paid_at: new Date(Date.UTC(2026, 2, 4)),
          created_at: '2026-03-04T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const payment = await splitRepository.addPayment({ split_id: 7, amount: 12.5 });

    // pg hands NUMERIC back as a string; the POST /pay path used to return it
    // raw while getPayments coerced, so the same row had two wire shapes.
    expect(payment.amount).toBe(12.5);
    expect(typeof payment.amount).toBe('number');
    expect(payment.paid_at).toBe('2026-03-04');
    expect(payment.id).toBe(3);
  });

  it('getPayments and addPayment agree on the shape of the same stored row', async () => {
    const stored = {
      id: 3,
      split_id: 7,
      amount: '12.50',
      note: null,
      paid_at: new Date(Date.UTC(2026, 2, 4)),
      created_at: '2026-03-04T00:00:00.000Z',
    };

    query
      .mockResolvedValueOnce({ rows: [{ id: 7, amount: '30.00' }] })
      .mockResolvedValueOnce({ rows: [{ paid: '0' }] })
      .mockResolvedValueOnce({ rows: [{ ...stored }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const posted = await splitRepository.addPayment({ split_id: 7, amount: 12.5 });

    query.mockResolvedValueOnce({ rows: [{ ...stored }] });
    const [fetched] = await splitRepository.getPayments(7);

    expect(posted).toEqual(fetched);
  });

  it('createSplitAtomic returns a formatSplit row, not the raw RETURNING * row', async () => {
    query
      // lockAndGetTotals: FOR UPDATE lock, then the totals read.
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ transaction_total: '60.00', current_split_total: '0' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 5,
          transaction_id: 1,
          recipient_id: 2,
          amount: '30.00',
          note: null,
          is_settled: false,
          created_at: '2026-03-01',
          updated_at: '2026-03-01',
          recipient_name: 'Alice',
          amount_paid: 0,
        }],
      });

    const split = await splitRepository.createSplitAtomic({
      transaction_id: 1, recipient_id: 2, amount: 30, note: null,
    });

    // The INSERT re-selects through recipients so the created row carries the
    // same fields every other split-reading endpoint emits.
    const insertSql = query.mock.calls[2][0];
    expect(insertSql).toContain('WITH created AS');
    expect(insertSql).toContain('LEFT JOIN recipients');

    expect(split.amount).toBe(30);
    expect(split.amount_paid).toBe(0);
    expect(split.recipient_name).toBe('Alice');
    expect(split).not.toHaveProperty('paid_amount');
  });

  it('createSplitsBatchAtomic returns formatSplit rows for every created split', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ transaction_total: '60.00', current_split_total: '0' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 5, transaction_id: 1, recipient_id: 2, amount: '20.00', note: null,
            is_settled: false, created_at: '2026-03-01', updated_at: '2026-03-01',
            recipient_name: 'Alice', amount_paid: 0,
          },
          {
            id: 6, transaction_id: 1, recipient_id: 3, amount: '10.00', note: 'half',
            is_settled: false, created_at: '2026-03-01', updated_at: '2026-03-01',
            recipient_name: 'Bob', amount_paid: 0,
          },
        ],
      });

    const splits = await splitRepository.createSplitsBatchAtomic({
      transaction_id: 1,
      splits: [
        { recipient_id: 2, amount: 20 },
        { recipient_id: 3, amount: 10, note: 'half' },
      ],
    });

    expect(splits.map((s) => s.amount)).toEqual([20, 10]);
    expect(splits.map((s) => s.recipient_name)).toEqual(['Alice', 'Bob']);
    expect(splits.every((s) => s.amount_paid === 0)).toBe(true);
  });
});

// The split lists only page when the caller asks: an absent limit must leave
// the query unbounded so the pre-pagination clients keep seeing every row.
describe('splitRepository opt-in LIMIT/OFFSET', () => {
  const cases = [
    ['getSplitsByTransaction', (page) => splitRepository.getSplitsByTransaction(2, page)],
    ['getOwedByRecipient', (page) => splitRepository.getOwedByRecipient(7, page)],
    ['getPayments', (page) => splitRepository.getPayments(7, page)],
  ];

  it.each(cases)('%s emits no LIMIT when unpaginated', async (_name, call) => {
    query.mockResolvedValueOnce({ rows: [] });
    await call(undefined);
    expect(query.mock.calls[0][0]).not.toContain('LIMIT');
    expect(query.mock.calls[0][1]).toHaveLength(1);
  });

  it.each(cases)('%s appends LIMIT/OFFSET after the existing params', async (_name, call) => {
    query.mockResolvedValueOnce({ rows: [] });
    await call({ limit: 10, offset: 20 });
    expect(query.mock.calls[0][0]).toContain('LIMIT $2 OFFSET $3');
    expect(query.mock.calls[0][1].slice(1)).toEqual([10, 20]);
  });

  it('counts coerce the pg bigint string to a number', async () => {
    query.mockResolvedValue({ rows: [{ count: '13' }] });
    expect(await splitRepository.countSplitsByTransaction(2)).toBe(13);
    expect(await splitRepository.countOwedByRecipient(7)).toBe(13);
    expect(await splitRepository.countPayments(7)).toBe(13);
  });
});
