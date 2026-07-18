import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockConnection } from './helpers/repoMocks.js';
// Owed-detail / owed-export used to LEFT JOIN a whole-table
// `SELECT split_id, SUM(amount) ... GROUP BY split_id` aggregate of
// split_payments on every call. These tests pin the rewrite to a per-split
// LATERAL aggregate (only the relevant rows) while preserving numeric output.

vi.mock('../src/database/connection.js', () => mockConnection());

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
