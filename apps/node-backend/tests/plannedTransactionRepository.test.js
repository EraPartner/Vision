import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => {
  const getClient = vi.fn();
  return {
    query: vi.fn(),
    getClient,
    withTransaction: vi.fn(async (fn) => {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        throw err;
      } finally {
        client.release();
      }
    }),
  };
});

vi.mock('../src/middleware/validation.js', () => ({
  sanitizeUpdateFields: vi.fn((_, fields) => fields),
}));

import { getClient, query } from '../src/database/connection.js';
import plannedTransactionRepository from '../src/repositories/plannedTransactionRepository.js';

describe('plannedTransactionRepository.getAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty items with total=0 by running fallback count query when page is empty', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const result = await plannedTransactionRepository.getAll({ limit: 25, offset: 1000 });

    expect(result).toEqual({ items: [], total: 0 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('COUNT(*) OVER() AS total_count'),
      [25, 1000]
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT count(*)'),
      []
    );
  });

  it('does not run execution or loan schedule follow-up queries when there are no planned rows', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await plannedTransactionRepository.getAll();

    const sqlCalls = query.mock.calls.map(([sql]) => String(sql));
    expect(sqlCalls.some((sql) => sql.includes('FROM planned_transaction_executions'))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes('FROM planned_transaction_loan_schedule'))).toBe(false);
  });

  it('attaches executions and loan schedules when planned rows are returned', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 1, is_loan: false, total_count: '2' },
          { id: 2, is_loan: true, total_count: '2' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { planned_transaction_id: 1, executed_transaction_id: 90, execution_date: '2026-02-01' },
          { planned_transaction_id: 2, executed_transaction_id: 91, execution_date: '2026-02-03' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            planned_transaction_id: 2,
            installment_number: 1,
            due_date: '2026-03-01',
            payment_amount: '120.00',
            principal_amount: '90.00',
            interest_amount: '30.00',
            remaining_principal: '910.00',
          },
        ],
      });

    const result = await plannedTransactionRepository.getAll({ limit: 10, offset: 0 });

    expect(query).toHaveBeenCalledTimes(3);
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: 1,
        execution_count: 1,
        executed_transaction_id: 90,
        loan_schedule: [],
      })
    );
    expect(result.items[1]).toEqual(
      expect.objectContaining({
        id: 2,
        execution_count: 1,
        executed_transaction_id: 91,
      })
    );
    expect(result.items[1].loan_schedule).toHaveLength(1);
  });
});

describe('plannedTransactionRepository.getById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when planned transaction does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await plannedTransactionRepository.getById(404);

    expect(result).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('WHERE pt.id = $1'), [404]);
  });

  it('attaches executions and loan schedule for loan rows', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 12, is_loan: true, recipient_name: 'Bank', category_name: 'LOAN:MORTGAGE' }],
      })
      .mockResolvedValueOnce({
        rows: [{ planned_transaction_id: 12, executed_transaction_id: 77, execution_date: '2026-03-01' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            installment_number: 1,
            due_date: '2026-04-01',
            payment_amount: '100.00',
            principal_amount: '80.00',
            interest_amount: '20.00',
            remaining_principal: '920.00',
          },
        ],
      });

    const result = await plannedTransactionRepository.getById(12);

    expect(query).toHaveBeenCalledTimes(3);
    expect(result.execution_count).toBe(1);
    expect(result.executed_transaction_id).toBe(77);
    expect(result.loan_schedule).toHaveLength(1);
    expect(result.loan_schedule[0]).toEqual(
      expect.objectContaining({ installment_number: 1, payment_amount: '100.00' })
    );
  });
});

describe('plannedTransactionRepository.create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates loan transaction and inserts schedule entries in a transaction', async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 51 }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    query
      .mockResolvedValueOnce({
        rows: [{ id: 51, is_loan: true, recipient_name: 'Bank', category_name: 'LOAN:MORTGAGE' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            installment_number: 1,
            due_date: '2026-06-01',
            payment_amount: '100.00',
            principal_amount: '80.00',
            interest_amount: '20.00',
            remaining_principal: '920.00',
          },
        ],
      });

    const result = await plannedTransactionRepository.create({
      planned_date: '2026-05-01',
      bank_account: 'be12',
      recipient_id: 3,
      amount: -100,
      memo: 'mortgage',
      currency: 'eur',
      category_id: 2,
      comment: 'loan payment',
      url: null,
      is_recurring: true,
      recurrence_pattern: 'monthly',
      is_loan: true,
      loan_type: 'mortgage',
      loan_principal: 10000,
      loan_annual_interest_rate: 2.5,
      loan_term_months: 120,
      loan_start_date: '2026-05-01',
      loan_payment_day: 1,
      loan_regular_payment_amount: 100,
      loan_first_payment_date: '2026-06-01',
      loan_schedule: [
        {
          installment_number: 1,
          due_date: '2026-06-01',
          payment_amount: 100,
          principal_amount: 80,
          interest_amount: 20,
          remaining_principal: 920,
        },
      ],
    });

    expect(getClient).toHaveBeenCalledTimes(1);
    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO planned_transactions'),
      expect.arrayContaining([
        '2026-05-01',
        'BE12',
        3,
        -100,
        'MORTGAGE',
        'EUR',
        true,
        null,
        true,
      ])
    );
    expect(clientQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO planned_transaction_loan_schedule'),
      expect.arrayContaining([51, 1, '2026-06-01', 100, 80, 20, 920])
    );
    expect(clientQuery).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ id: 51, is_loan: true, execution_count: 0 }));
  });

  it('rolls back and rethrows when loan schedule insert fails', async () => {
    const scheduleError = new Error('schedule insert failed');
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 88 }] })
      .mockRejectedValueOnce(scheduleError)
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    await expect(
      plannedTransactionRepository.create({
        planned_date: '2026-05-01',
        bank_account: 'BE12',
        recipient_id: 3,
        amount: -100,
        memo: 'mortgage',
        currency: 'EUR',
        category_id: 2,
        is_recurring: false,
        is_loan: true,
        loan_schedule: [
          {
            installment_number: 1,
            due_date: '2026-06-01',
            payment_amount: 100,
            principal_amount: 80,
            interest_amount: 20,
            remaining_principal: 920,
          },
        ],
      })
    ).rejects.toThrow('schedule insert failed');

    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO planned_transactions'), expect.any(Array));
    expect(clientQuery).toHaveBeenNthCalledWith(3, expect.stringContaining('INSERT INTO planned_transaction_loan_schedule'), expect.any(Array));
    expect(clientQuery).toHaveBeenNthCalledWith(4, 'ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('creates non-loan transaction without inserting loan schedule rows', async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 52 }] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    query
      .mockResolvedValueOnce({
        rows: [{ id: 52, is_loan: false, recipient_name: 'Employer', category_name: 'INCOME:SALARY' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await plannedTransactionRepository.create({
      planned_date: '2026-05-01',
      bank_account: 'be56',
      recipient_id: 4,
      amount: 2200,
      memo: 'salary',
      currency: 'eur',
      category_id: 5,
      comment: null,
      url: null,
      is_recurring: true,
      recurrence_pattern: 'monthly',
      is_loan: false,
      loan_schedule: [],
    });

    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO planned_transactions'),
      expect.arrayContaining(['BE56', 'SALARY', 'EUR', true, 'monthly', false])
    );
    expect(clientQuery).toHaveBeenNthCalledWith(3, 'COMMIT');
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('planned_transaction_loan_schedule'))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ id: 52, is_loan: false, execution_count: 0, loan_schedule: [] }));
  });
});

describe('plannedTransactionRepository.update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns getById(id) when sanitized update fields are empty', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 33, is_loan: false, recipient_name: 'Shop', category_name: 'FOOD:GROCERIES' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await plannedTransactionRepository.update(33, { unsafe_field: undefined });

    expect(result).toEqual(expect.objectContaining({ id: 33, execution_count: 0, loan_schedule: [] }));
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('WHERE pt.id = $1'), [33]);
  });

  it('returns null when update affects zero rows', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await plannedTransactionRepository.update(999, { memo: 'updated' });

    expect(result).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WITH updated AS'),
      ['updated', 999]
    );
  });

  it('returns updated loan row with executions and schedule', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 70, is_loan: true, recipient_name: 'Bank', category_name: 'LOAN:CAR' }],
      })
      .mockResolvedValueOnce({
        rows: [{ planned_transaction_id: 70, executed_transaction_id: 701, execution_date: '2026-06-02' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            installment_number: 2,
            due_date: '2026-07-01',
            payment_amount: '250.00',
            principal_amount: '200.00',
            interest_amount: '50.00',
            remaining_principal: '4800.00',
          },
        ],
      });

    const result = await plannedTransactionRepository.update(70, { memo: 'updated memo' });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WITH updated AS'),
      ['updated memo', 70]
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: 70,
        execution_count: 1,
        executed_transaction_id: 701,
      })
    );
    expect(result.loan_schedule).toHaveLength(1);
  });
});

describe('plannedTransactionRepository.small mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true from hardDelete when a row is deleted', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });

    const deleted = await plannedTransactionRepository.hardDelete(7);

    expect(query).toHaveBeenCalledWith('DELETE FROM planned_transactions WHERE id = $1', [7]);
    expect(deleted).toBe(true);
  });

  it('returns false from hardDelete when no rows are deleted', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });

    const deleted = await plannedTransactionRepository.hardDelete(777);

    expect(query).toHaveBeenCalledWith('DELETE FROM planned_transactions WHERE id = $1', [777]);
    expect(deleted).toBe(false);
  });

  it('adds execution with provided execution date', async () => {
    query.mockResolvedValueOnce({});

    await plannedTransactionRepository.addExecution(10, 99, '2026-08-09');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO planned_transaction_executions'),
      [10, 99, '2026-08-09']
    );
  });

  it('adds execution with current date when execution date is missing', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-10T12:30:00.000Z'));
      query.mockResolvedValueOnce({});

      await plannedTransactionRepository.addExecution(11, 101);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO planned_transaction_executions'),
        [11, 101, '2026-09-10']
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces loan schedule in one transaction', async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    await plannedTransactionRepository.replaceLoanSchedule(12, [
      {
        installment_number: 1,
        due_date: '2026-10-01',
        payment_amount: 300,
        principal_amount: 250,
        interest_amount: 50,
        remaining_principal: 4700,
      },
    ]);

    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenNthCalledWith(
      2,
      'DELETE FROM planned_transaction_loan_schedule WHERE planned_transaction_id = $1',
      [12]
    );
    expect(clientQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO planned_transaction_loan_schedule'),
      expect.arrayContaining([12, 1, '2026-10-01', 300, 250, 50, 4700])
    );
    expect(clientQuery).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back loan schedule replacement when delete fails', async () => {
    const deleteError = new Error('delete failed');
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(deleteError)
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    await expect(plannedTransactionRepository.replaceLoanSchedule(13, [])).rejects.toThrow('delete failed');

    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenNthCalledWith(
      2,
      'DELETE FROM planned_transaction_loan_schedule WHERE planned_transaction_id = $1',
      [13]
    );
    expect(clientQuery).toHaveBeenNthCalledWith(3, 'ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
