/**
 * Planned transaction route tests.
 * Mirrors: apps/backend/tests/test_planned_transactions.py
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js). Notably `validateIdParam` is no longer stubbed —
 * the guard that the old mock-router harness dropped from the chain now runs on
 * every `/:id` route here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent } from '../helpers/routeApp.js';

vi.mock('../../src/repositories/plannedTransactionRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateWithLoanSchedule: vi.fn(),
    hardDelete: vi.fn(),
    addExecution: vi.fn(),
    replaceLoanSchedule: vi.fn(),
    executeAndAdvance: vi.fn(async () => ({ duplicate: false })),
  },
}));

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

// The per-route PATCH limiter (routes/plannedTransactions.js:417) is stubbed
// here on purpose: this suite issues ~28 PATCHes against one in-memory counter
// keyed by IP, so the real 30/min ceiling would make the file self-throttling
// and flaky as tests are added. The transactions suites exercise the real
// limiter chain. Every OTHER middleware on the chain is real.
vi.mock('../../src/middleware/rateLimiter.js', () => ({
  rateLimiter: () => (_req, _res, next) => next(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

// Spy-wrapped, NOT replaced: the schedule maths stays real for every other test
// in this file (the -860.66 pins below depend on it). The wrapper only exists so
// a single test can make the generator throw a non-AppError and prove the route
// does not relabel an internal fault as a client 400.
vi.mock('../../src/services/calculations/loanSchedule.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, generateLoanRepaymentSchedule: vi.fn(actual.generateLoanRepaymentSchedule) };
});

import plannedTransactionRepository from '../../src/repositories/plannedTransactionRepository.js';
import { query as dbQuery } from '../../src/database/connection.js';
import { generateLoanRepaymentSchedule } from '../../src/services/calculations/loanSchedule.js';

const { default: plannedRouter } = await import('../../src/routes/plannedTransactions.js');

const api = routeAgent(plannedRouter, { mountPath: '/api/planned-transactions' });

const BASE = '/api/planned-transactions';
const post = (body) => api.post(`${BASE}/`).send(body);
const patch = (id, body) => api.patch(`${BASE}/${id}`).send(body);
const execute = (id, body) => api.post(`${BASE}/${id}/execute`).send(body);

describe('Planned Transaction Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return empty list', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 0 });

      const res = await api.get(`${BASE}/`).expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(0);
      expect(res.body.meta.requestId).toEqual(expect.any(String));
    });

    it('should return planned transactions', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({
        items: [{ id: 1, planned_date: '2026-03-15', amount: '50.00', is_recurring: false, is_executed: false }],
        total: 1,
      });

      const res = await api.get(`${BASE}/`).expect(200);

      expect(res.body.data.total).toBe(1);
    });

    // Sixth set of the id-parser convergence. `category_id` / `recipient_id`
    // were `x ? parseInt(x) : null` — verbatim the pattern removed from the
    // transactions list endpoint in ae79ec1f — so parseInt took the leading
    // digits of anything: ?category_id=12abc listed the planned transactions of
    // category 12, a filter the caller never asked for, and ?recipient_id=abc
    // produced a NaN that passed the repository's `!= null` guard and reached
    // Postgres as a 22P02 500. Both are 400s now.
    it('rejects a malformed category_id / recipient_id instead of truncating it', async () => {
      for (const query of [
        'category_id=12abc', 'category_id=1e3', 'category_id=12.5', 'category_id=0',
        'category_id=-4', 'category_id=abc', 'category_id=NaN', 'category_id=0x10',
        'category_id=2147483648', 'category_id= 5',
        'recipient_id=12abc', 'recipient_id=abc', 'recipient_id=0', 'recipient_id=1e3',
      ]) {
        const res = await api.get(`${BASE}/?${query}`).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(plannedTransactionRepository.getAll).not.toHaveBeenCalled();
    });

    it('keeps absent and empty meaning "no filter"', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 0 });
      for (const query of ['', 'category_id=', 'recipient_id=', 'category_id=&recipient_id=']) {
        await api.get(`${BASE}/?${query}`).expect(200);
      }
      for (const call of plannedTransactionRepository.getAll.mock.calls) {
        expect(call[0]).toMatchObject({ categoryId: null, recipientId: null });
      }
    });

    it('passes a well-formed id through unchanged', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 0 });
      await api.get(`${BASE}/?category_id=7&recipient_id=99`).expect(200);
      expect(plannedTransactionRepository.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ categoryId: 7, recipientId: 99 }),
      );
    });

    it('should respect pagination', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 10 });

      const res = await api.get(`${BASE}/?limit=5&offset=2`).expect(200);

      expect(res.body.data.limit).toBe(5);
      expect(res.body.data.offset).toBe(2);
    });

    it('should filter by is_recurring', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 0 });

      await api.get(`${BASE}/?is_recurring=true`).expect(200);

      expect(plannedTransactionRepository.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ isRecurring: true })
      );
    });

    it('should filter by is_executed', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 0 });

      await api.get(`${BASE}/?is_executed=false`).expect(200);

      expect(plannedTransactionRepository.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ isExecuted: false })
      );
    });
  });

  describe('POST /', () => {
    it('should create with 201', async () => {
      plannedTransactionRepository.create.mockResolvedValue({
        id: 1, planned_date: '2026-03-15', amount: '50.00', bank_account: 'Chase',
        is_recurring: false, is_executed: false,
      });

      const res = await post({ planned_date: '2026-03-15', bank_account: 'Chase', amount: 50 })
        .expect(201);

      expect(res.body.ok).toBe(true);
      expect(res.body.data.id).toBe(1);
    });

    it('should return a 400 VALIDATION_ERROR envelope for missing fields', async () => {
      const res = await post({ amount: 50 }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a zero amount (meaningless, never auto-matches)', async () => {
      await post({ planned_date: '2026-03-15', bank_account: 'Chase', amount: 0 }).expect(400);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });

    it('rejects an absurd amount above the money-column ceiling', async () => {
      await post({ planned_date: '2026-03-15', bank_account: 'Chase', amount: 1e15 }).expect(400);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a negative reminder_days_before', async () => {
      await post({
        planned_date: '2026-03-15', bank_account: 'Chase', amount: 50, reminder_days_before: -1,
      }).expect(400);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });

    it('should create loan payment and overwrite amount/date from schedule', async () => {
      plannedTransactionRepository.create.mockResolvedValue({
        id: 2,
        planned_date: '2026-04-01',
        amount: '850.00',
        bank_account: 'Mortgage',
        is_loan: true,
        is_recurring: true,
        is_executed: false,
      });

      await post({
        bank_account: 'Mortgage',
        is_loan: true,
        loan_type: 'amortizing',
        loan_principal: 10000,
        loan_annual_interest_rate: 6,
        loan_term_months: 12,
        loan_start_date: '2026-04-01',
        loan_payment_day: 1,
      }).expect(201);

      expect(plannedTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          is_loan: true,
          amount: -860.66,
          planned_date: '2026-04-01',
        })
      );
    });

    it('rejects an invalid recurrence_pattern (fortnightly) with a 400', async () => {
      await post({
        planned_date: '2026-03-15', bank_account: 'Chase', amount: 50,
        is_recurring: true, recurrence_pattern: 'fortnightly',
      }).expect(400);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });

    it('rejects is_recurring:true with no recurrence_pattern (would be perpetually due)', async () => {
      await post({
        planned_date: '2026-03-15', bank_account: 'Chase', amount: 50,
        is_recurring: true,
      }).expect(400);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });

    it('accepts an "every N days" recurrence_pattern', async () => {
      plannedTransactionRepository.create.mockResolvedValue({
        id: 9, planned_date: '2026-03-15', amount: '50.00', bank_account: 'Chase',
        is_recurring: true, is_executed: false,
      });

      await post({
        planned_date: '2026-03-15', bank_account: 'Chase', amount: 50,
        is_recurring: true, recurrence_pattern: 'every 10 days',
      }).expect(201);
    });

    it('stores a loan as a monthly recurrence so /execute advances it', async () => {
      plannedTransactionRepository.create.mockResolvedValue({
        id: 3, planned_date: '2026-04-01', amount: '850.00', bank_account: 'Mortgage',
        is_loan: true, is_recurring: true, recurrence_pattern: 'monthly', is_executed: false,
      });

      await post({
        bank_account: 'Mortgage', is_loan: true, loan_type: 'amortizing',
        loan_principal: 10000, loan_annual_interest_rate: 6, loan_term_months: 12,
        loan_start_date: '2026-04-01', loan_payment_day: 1,
        // The frontend may inject a display string; the route must replace it.
        recurrence_pattern: 'loan(12 months)',
      }).expect(201);

      expect(plannedTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ is_loan: true, is_recurring: true, recurrence_pattern: 'monthly' }),
      );
    });

    it('should return 400 when loan_term_months is out of bounds', async () => {
      await post({
        bank_account: 'Mortgage',
        is_loan: true,
        loan_term_months: 601,
      }).expect(400);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });
  });

  // generateLoanScheduleOrThrow used to wrap EVERY throw from the generator in
  // `new ValidationError('Invalid loan parameters: ' + err.message)`. That did
  // two wrong things at once, pinned separately below.
  describe('loan schedule failures keep their own class and message', () => {
    it('surfaces the generator ValidationError verbatim — one prefix, not two', async () => {
      const res = await post({
        bank_account: 'Mortgage',
        is_loan: true,
        loan_type: 'amortizing',
        loan_principal: -1,
        loan_annual_interest_rate: 6,
        loan_term_months: 12,
        loan_start_date: '2026-04-01',
        loan_payment_day: 1,
      }).expect(400);

      expect(res.body.error.message).toBe(
        'Invalid loan configuration: loan_principal must be a positive number',
      );
      expect(res.body.error.message).not.toMatch(/Invalid loan parameters/);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });

    it('does not relabel a non-AppError fault in the schedule maths as a client 400', async () => {
      generateLoanRepaymentSchedule.mockImplementationOnce(() => {
        throw new TypeError('remaining.toFixed is not a function');
      });

      const res = await post({
        bank_account: 'Mortgage',
        is_loan: true,
        loan_type: 'amortizing',
        loan_principal: 10000,
        loan_annual_interest_rate: 6,
        loan_term_months: 12,
        loan_start_date: '2026-04-01',
        loan_payment_day: 1,
      }).expect(500);

      expect(res.body.error.message).not.toMatch(/Invalid loan parameters/);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });

    it('does not relabel a non-AppError fault raised by a PATCH regeneration either', async () => {
      plannedTransactionRepository.getById.mockResolvedValueOnce({
        id: 1, is_loan: true, loan_type: 'amortizing', loan_principal: 5000,
        loan_annual_interest_rate: 3, loan_term_months: 24,
        loan_start_date: '2026-04-01', loan_payment_day: 1,
      });
      generateLoanRepaymentSchedule.mockImplementationOnce(() => {
        throw new TypeError('remaining.toFixed is not a function');
      });

      const res = await patch(1, { loan_principal: 10000 }).expect(500);

      expect(res.body.error.message).not.toMatch(/Invalid loan parameters/);
      expect(plannedTransactionRepository.updateWithLoanSchedule).not.toHaveBeenCalled();
    });
  });

  // Pins for the zod swap (ZOD-08): accepted inputs keep their exact coercions,
  // rejected inputs stay rejected, loan-branch drop semantics are preserved.
  describe('POST / validation pins', () => {
    const validBody = { planned_date: '2026-03-15', bank_account: 'Chase', amount: 50 };

    beforeEach(() => {
      plannedTransactionRepository.create.mockResolvedValue({
        id: 1, planned_date: '2026-03-15', amount: '50.00', bank_account: 'Chase',
        is_recurring: false, is_executed: false,
      });
    });

    it('coerces a string amount to a number before the repository', async () => {
      await post({ ...validBody, amount: '50.5' }).expect(201);
      expect(plannedTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50.5 }),
      );
    });

    it('rejects an empty-string amount (coerces to 0, which is meaningless)', async () => {
      await post({ ...validBody, amount: '' }).expect(400);
    });

    it('rejects non-array tags (including null)', async () => {
      await post({ ...validBody, tags: 'groceries' }).expect(400);
      await post({ ...validBody, tags: null }).expect(400);
    });

    it('coerces reminder_days_before and accepts the 0/365 boundaries', async () => {
      await post({ ...validBody, reminder_days_before: '5' }).expect(201);
      expect(plannedTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ reminder_days_before: 5 }),
      );
      await post({ ...validBody, reminder_days_before: 0 }).expect(201);
      expect(plannedTransactionRepository.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ reminder_days_before: 0 }),
      );
      await post({ ...validBody, reminder_days_before: 365 }).expect(201);
      expect(plannedTransactionRepository.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ reminder_days_before: 365 }),
      );
    });

    it('rejects out-of-range or fractional reminder_days_before', async () => {
      for (const bad of [366, 2.5, 'abc']) {
        await post({ ...validBody, reminder_days_before: bad }).expect(400);
      }
    });

    it('coerces max_occurrences to an integer and accepts the 1 boundary', async () => {
      await post({ ...validBody, max_occurrences: '3' }).expect(201);
      expect(plannedTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ max_occurrences: 3 }),
      );
      await post({ ...validBody, max_occurrences: 1 }).expect(201);
      expect(plannedTransactionRepository.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ max_occurrences: 1 }),
      );
    });

    it('rejects non-positive or non-numeric max_occurrences', async () => {
      for (const bad of [0, -1, 1.5, 'abc']) {
        await post({ ...validBody, max_occurrences: bad }).expect(400);
      }
    });

    it('accepts a valid recurrence_end_date unchanged and rejects a malformed one', async () => {
      await post({ ...validBody, recurrence_end_date: '2026-12-31' }).expect(201);
      expect(plannedTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ recurrence_end_date: '2026-12-31' }),
      );
      await post({ ...validBody, recurrence_end_date: 'banana' }).expect(400);
    });

    it('normalises currency to uppercase ISO and rejects free text', async () => {
      // Free-typed "euro" used to be uppercased to "EURO" by the repository and
      // then violate the 0046 ISO CHECK as a raw 500.
      await post({ ...validBody, currency: 'euro' }).expect(400);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();

      await post({ ...validBody, currency: 'usd' }).expect(201);
      expect(plannedTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'USD' }),
      );
    });

    it('maps an absent/empty currency to undefined so the repository default (EUR) applies', async () => {
      await post({ ...validBody, currency: '' }).expect(201);
      expect(plannedTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ currency: undefined }),
      );
    });

    it('drops truthy recurrence bounds on a loan instead of validating them', async () => {
      await post({
        bank_account: 'Mortgage', is_loan: true, loan_type: 'amortizing',
        loan_principal: 10000, loan_annual_interest_rate: 6, loan_term_months: 12,
        loan_start_date: '2026-04-01', loan_payment_day: 1,
        // Garbage that would 400 on a non-loan — the loan branch deletes it.
        max_occurrences: 'abc', recurrence_end_date: 'banana',
        frequency: 'x', custom_interval_days: 3, end_date: 'y',
      }).expect(201);

      const arg = plannedTransactionRepository.create.mock.calls[0][0];
      expect('max_occurrences' in arg).toBe(false);
      expect('recurrence_end_date' in arg).toBe(false);
      expect('frequency' in arg).toBe(false);
      expect('custom_interval_days' in arg).toBe(false);
      expect('end_date' in arg).toBe(false);
    });

    it('still rejects a falsy-but-present max_occurrences on a loan (not dropped)', async () => {
      await post({
        bank_account: 'Mortgage', is_loan: true, loan_type: 'amortizing',
        loan_principal: 10000, loan_annual_interest_rate: 6, loan_term_months: 12,
        loan_start_date: '2026-04-01', loan_payment_day: 1,
        max_occurrences: 0,
      }).expect(400);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id validation pins', () => {
    beforeEach(() => {
      plannedTransactionRepository.getById.mockResolvedValue({ id: 1, is_loan: false });
      plannedTransactionRepository.update.mockResolvedValue({ id: 1 });
    });

    it('coerces reminder_days_before and max_occurrences on update', async () => {
      await patch(1, { reminder_days_before: '7', max_occurrences: '4' }).expect(200);
      expect(plannedTransactionRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ reminder_days_before: 7, max_occurrences: 4 }),
      );
    });

    it('rejects invalid reminder_days_before / max_occurrences / recurrence_end_date', async () => {
      for (const body of [
        { reminder_days_before: -1 },
        { max_occurrences: 0 },
        { recurrence_end_date: 'banana' },
        { tags: 'nope' },
        { recurrence_pattern: 'fortnightly' },
      ]) {
        await patch(1, body).expect(400);
      }
      expect(plannedTransactionRepository.update).not.toHaveBeenCalled();
    });

    it('normalises a valid currency and rejects free-text or cleared currency on PATCH', async () => {
      // PATCH forwarded the raw value to the SET builder, so "euro" hit the
      // 0046 ISO CHECK as a raw 500 and null hit the NOT NULL constraint.
      for (const body of [{ currency: 'euro' }, { currency: null }, { currency: '' }]) {
        await patch(1, body).expect(400);
      }
      expect(plannedTransactionRepository.update).not.toHaveBeenCalled();

      await patch(1, { currency: 'usd' }).expect(200);
      expect(plannedTransactionRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ currency: 'USD' }),
      );
    });

    it('coerces a valid amount and rejects zero/absurd/non-finite/cleared amounts on PATCH', async () => {
      for (const body of [
        { amount: 0 },
        { amount: 1e15 },
        { amount: 'Infinity' },
        { amount: null },
        { amount: '' },
      ]) {
        await patch(1, body).expect(400);
      }
      expect(plannedTransactionRepository.update).not.toHaveBeenCalled();

      await patch(1, { amount: '-42.50' }).expect(200);
      expect(plannedTransactionRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ amount: -42.5 }),
      );
    });

    it('rejects turning recurrence on (or clearing the pattern) when the merged state has no valid pattern', async () => {
      // is_recurring:true on a row without a pattern used to store and leave
      // the row perpetually due after /execute (the POST guard has an exact
      // sibling); clearing the pattern on a recurring row recreated it.
      await patch(1, { is_recurring: true }).expect(400);

      plannedTransactionRepository.getById.mockResolvedValue({ id: 1, is_loan: false, is_recurring: true, recurrence_pattern: 'monthly' });
      await patch(1, { recurrence_pattern: null }).expect(400);
      expect(plannedTransactionRepository.update).not.toHaveBeenCalled();

      // Turning recurrence on WITH a valid pattern still passes.
      plannedTransactionRepository.getById.mockResolvedValue({ id: 1, is_loan: false });
      await patch(1, { is_recurring: true, recurrence_pattern: 'monthly' }).expect(200);
      expect(plannedTransactionRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ is_recurring: true, recurrence_pattern: 'monthly' }),
      );

      // An unrelated edit to a legacy broken row (recurring, no pattern) is NOT blocked.
      plannedTransactionRepository.getById.mockResolvedValue({ id: 1, is_loan: false, is_recurring: true, recurrence_pattern: null });
      await patch(1, { memo: 'still editable' }).expect(200);
      expect(plannedTransactionRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ memo: 'still editable' }),
      );
    });

    it('passes explicit nulls through to clear recurrence bounds and pattern', async () => {
      await patch(1, {
        recurrence_end_date: null, max_occurrences: null, recurrence_pattern: null,
      }).expect(200);
      expect(plannedTransactionRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          recurrence_end_date: null,
          max_occurrences: null,
          recurrence_pattern: null,
        }),
      );
    });
  });

  describe('GET /:id', () => {
    it('should return by id', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({
        id: 1, planned_date: '2026-03-15', amount: '50.00',
      });

      const res = await api.get(`${BASE}/1`).expect(200);

      expect(res.body.data.id).toBe(1);
    });

    it('should return a 404 envelope for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const res = await api.get(`${BASE}/99999`).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects a non-integer :id via the real validateIdParam guard', async () => {
      // Previously `vi.mock('.../middleware/validation.js')` replaced
      // validateIdParam with a pass-through, so this guard was never tested.
      const res = await api.get(`${BASE}/abc`).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(plannedTransactionRepository.getById).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id', () => {
    it('should update', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({ id: 1 });
      plannedTransactionRepository.update.mockResolvedValue({ id: 1, amount: '75.00' });

      const res = await patch(1, { amount: 75 }).expect(200);

      expect(res.body.ok).toBe(true);
    });

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      await patch(99999, { amount: 75 }).expect(404);
    });

    it('should resolve recipient_name and category_name to IDs', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({ id: 1, is_loan: false });
      plannedTransactionRepository.update.mockResolvedValue({
        id: 1,
        recipient_id: 11,
        category_id: 22,
      });
      dbQuery
        .mockResolvedValueOnce({ rows: [{ id: 11 }] })
        .mockResolvedValueOnce({ rows: [{ id: 22 }] });

      await patch(1, {
        recipient_name: 'John',
        category_name: 'FOOD:GROCERIES',
      }).expect(200);

      expect(plannedTransactionRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          recipient_id: 11,
          category_id: 22,
        })
      );
    });

    // Sign/amount derivation pins: whenever the repayment schedule is
    // (re)generated by a PATCH, `amount` MUST be re-derived server-side as
    // -|regular_payment_amount| — a defined client amount is ignored, exactly
    // like POST. Keeping the client value desynced amount from
    // loan_regular_payment_amount. (10000 @ 6% / 12 months → 860.66, same
    // real-schedule figure the POST test pins.)
    const existingLoan = {
      id: 1,
      is_loan: true,
      loan_type: 'amortizing',
      loan_principal: 5000,
      loan_annual_interest_rate: 3,
      loan_term_months: 24,
      loan_start_date: '2026-04-01',
      loan_payment_day: 1,
    };

    it('re-derives amount from the regenerated schedule even when the client sends a stale amount', async () => {
      plannedTransactionRepository.getById.mockResolvedValueOnce(existingLoan);
      plannedTransactionRepository.updateWithLoanSchedule.mockResolvedValue({ id: 1, is_loan: true });

      // Client edits the principal but sends its stale (pre-regeneration) amount.
      await patch(1, {
        loan_principal: 10000,
        loan_annual_interest_rate: 6,
        loan_term_months: 12,
        amount: -214.03,
      }).expect(200);

      expect(plannedTransactionRepository.updateWithLoanSchedule).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          amount: -860.66,
          loan_regular_payment_amount: 860.66,
        }),
        expect.any(Array),
      );
    });

    it('re-derives (and force-negates) amount on convert-to-loan even when the client sends a positive amount', async () => {
      plannedTransactionRepository.getById.mockResolvedValueOnce({ id: 1, is_loan: false });
      plannedTransactionRepository.updateWithLoanSchedule.mockResolvedValue({ id: 1, is_loan: true });

      await patch(1, {
        is_loan: true,
        loan_type: 'amortizing',
        loan_principal: 10000,
        loan_annual_interest_rate: 6,
        loan_term_months: 12,
        loan_start_date: '2026-04-01',
        loan_payment_day: 1,
        amount: 500, // stale client value, wrong sign — must be ignored
      }).expect(200);

      expect(plannedTransactionRepository.updateWithLoanSchedule).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ amount: -860.66 }),
        expect.any(Array),
      );
    });

    it('keeps a client amount on a loan PATCH that touches no schedule input', async () => {
      // No loan field changed and is_loan not re-asserted → the schedule is not
      // regenerated, so the client's amount passes through untouched (boundary
      // of the re-derivation rule).
      plannedTransactionRepository.getById.mockResolvedValueOnce(existingLoan);
      plannedTransactionRepository.update.mockResolvedValue({ id: 1, is_loan: true });

      await patch(1, { memo: 'note', amount: -123.45 }).expect(200);

      expect(plannedTransactionRepository.updateWithLoanSchedule).not.toHaveBeenCalled();
      expect(plannedTransactionRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ amount: -123.45 }),
      );
    });

    it('should clear loan fields and loan schedule atomically when toggled off', async () => {
      plannedTransactionRepository.getById.mockResolvedValueOnce({
        id: 1,
        is_loan: true,
        loan_type: 'amortizing',
        loan_principal: 10000,
        loan_annual_interest_rate: 6,
        loan_term_months: 12,
        loan_start_date: '2026-04-01',
        loan_payment_day: 1,
      });
      plannedTransactionRepository.updateWithLoanSchedule.mockResolvedValue({ id: 1, is_loan: false, loan_schedule: [] });

      await patch(1, { is_loan: false }).expect(200);

      // Field update + schedule clear must go through ONE atomic method ([] clears
      // the schedule) — not a separate update() + replaceLoanSchedule() pair.
      expect(plannedTransactionRepository.updateWithLoanSchedule).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          is_loan: false,
          loan_type: null,
          loan_principal: null,
          loan_annual_interest_rate: null,
          loan_term_months: null,
          loan_start_date: null,
          loan_payment_day: null,
          loan_regular_payment_amount: null,
          loan_first_payment_date: null,
        }),
        [],
      );
      expect(plannedTransactionRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/execute', () => {
    it('should execute one-time transaction', async () => {
      plannedTransactionRepository.getById
        .mockResolvedValueOnce({ id: 1, is_recurring: false, is_executed: false })
        .mockResolvedValueOnce({ id: 1, is_executed: true, last_executed_date: '2026-03-15' });
      plannedTransactionRepository.executeAndAdvance.mockResolvedValue({ duplicate: false });

      const res = await execute(1, { executed_transaction_id: 10, execution_date: '2026-03-15' })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it('should execute recurring and advance date', async () => {
      plannedTransactionRepository.getById
        .mockResolvedValueOnce({
          id: 1, is_recurring: true, recurrence_pattern: 'monthly',
          planned_date: '2026-03-15', is_executed: false,
        })
        .mockResolvedValueOnce({ id: 1, is_executed: false, planned_date: '2026-04-15' });
      plannedTransactionRepository.executeAndAdvance.mockResolvedValue({ duplicate: false });

      await execute(1, { executed_transaction_id: 10 }).expect(200);

      const call = plannedTransactionRepository.executeAndAdvance.mock.calls[0];
      expect(call[3].is_executed).toBe(false);
    });

    it('advances a monthly recurrence in APP_TIMEZONE without a UTC day-shift', async () => {
      // planned_date is Brussels-midnight 2026-01-31 (= 2026-01-30T23:00Z), the
      // shape node-postgres returns for a DATE column on the Brussels dev host.
      plannedTransactionRepository.getById
        .mockResolvedValueOnce({
          id: 1, is_recurring: true, recurrence_pattern: 'monthly',
          planned_date: new Date('2026-01-30T23:00:00Z'), is_executed: false,
        })
        .mockResolvedValueOnce({ id: 1 });
      plannedTransactionRepository.executeAndAdvance.mockResolvedValue({ duplicate: false });

      await execute(1, { executed_transaction_id: 10 }).expect(200);

      const updateFields = plannedTransactionRepository.executeAndAdvance.mock.calls[0][3];
      expect(updateFields.planned_date).toBe('2026-02-28'); // not 2026-02-27 (the UTC day)
    });

    it('keeps the clamped day on subsequent monthly advances (sticky clamp)', async () => {
      plannedTransactionRepository.getById
        .mockResolvedValueOnce({
          id: 1, is_recurring: true, recurrence_pattern: 'monthly',
          planned_date: new Date('2026-02-27T23:00:00Z'), is_executed: false, // Brussels 2026-02-28
        })
        .mockResolvedValueOnce({ id: 1 });
      plannedTransactionRepository.executeAndAdvance.mockResolvedValue({ duplicate: false });

      await execute(1, { executed_transaction_id: 11 }).expect(200);

      const updateFields = plannedTransactionRepository.executeAndAdvance.mock.calls[0][3];
      expect(updateFields.planned_date).toBe('2026-03-28');
    });

    it('should return 400 without executed_transaction_id', async () => {
      const res = await execute(1, {}).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const res = await execute(99999, { executed_transaction_id: 10 }).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /:id', () => {
    it('should delete and return 204 with no body', async () => {
      plannedTransactionRepository.hardDelete.mockResolvedValue(true);

      const res = await api.delete(`${BASE}/1`).expect(204);

      expect(res.text).toBe('');
    });

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.hardDelete.mockResolvedValue(false);

      const res = await api.delete(`${BASE}/99999`).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
