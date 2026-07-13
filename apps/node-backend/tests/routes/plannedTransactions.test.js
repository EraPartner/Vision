/**
 * Planned transaction route tests.
 * Mirrors: apps/backend/tests/test_planned_transactions.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

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

vi.mock('../../src/services/loanRepaymentService.js', () => ({
  generateLoanRepaymentSchedule: vi.fn(() => ({
    regular_payment_amount: 850,
    first_due_date: '2026-04-01',
    schedule: [
      {
        installment_number: 1,
        due_date: '2026-04-01',
        payment_amount: 850,
        principal_amount: 700,
        interest_amount: 150,
        remaining_principal: 9300,
      },
    ],
  })),
}));

vi.mock('../../src/middleware/validation.js', async (importOriginal) => ({
  // Keep the real helpers (assertYmd, validateId, …); only stub the middleware.
  ...(await importOriginal()),
  validateIdParam: (_req, _res, next) => next(),
}));

vi.mock('../../src/middleware/rateLimiter.js', () => ({
  rateLimiter: () => (_req, _res, next) => next(),
}));

vi.mock('../../src/services/recurrenceService.js', () => ({
  calculateNextDate: vi.fn((base, pattern) => {
    if (pattern === 'monthly') {
      const d = new Date(base);
      d.setMonth(d.getMonth() + 1);
      return d;
    }
    return null;
  }),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import plannedTransactionRepository from '../../src/repositories/plannedTransactionRepository.js';
import { query as dbQuery } from '../../src/database/connection.js';
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/plannedTransactions.js');

function mockResponse() {
  return createMockResponse({ set: vi.fn() });
}

describe('Planned Transaction Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return empty list', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 0 });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.data.items).toEqual([]);
      expect(result.data.total).toBe(0);
    });

    it('should return planned transactions', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({
        items: [{ id: 1, planned_date: '2026-03-15', amount: '50.00', is_recurring: false, is_executed: false }],
        total: 1,
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].data.total).toBe(1);
    });

    it('should respect pagination', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 10 });

      const req = { query: { limit: '5', offset: '2' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data.limit).toBe(5);
      expect(data.offset).toBe(2);
    });

    it('should filter by is_recurring', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 0 });

      const req = { query: { is_recurring: 'true' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(plannedTransactionRepository.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ isRecurring: true })
      );
    });

    it('should filter by is_executed', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 0 });

      const req = { query: { is_executed: 'false' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

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

      const req = { body: { planned_date: '2026-03-15', bank_account: 'Chase', amount: 50 } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should throw ValidationError for missing fields', async () => {
      const req = { body: { amount: 50 } };
      const res = mockResponse();
      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
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

      const req = {
        body: {
          bank_account: 'Mortgage',
          is_loan: true,
          loan_type: 'amortizing',
          loan_principal: 10000,
          loan_annual_interest_rate: 6,
          loan_term_months: 12,
          loan_start_date: '2026-04-01',
          loan_payment_day: 1,
        },
      };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(plannedTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          is_loan: true,
          amount: -860.66,
          planned_date: '2026-04-01',
        })
      );
    });

    it('rejects an invalid recurrence_pattern (fortnightly) with ValidationError', async () => {
      const req = {
        body: {
          planned_date: '2026-03-15', bank_account: 'Chase', amount: 50,
          is_recurring: true, recurrence_pattern: 'fortnightly',
        },
      };
      const res = mockResponse();
      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });

    it('accepts an "every N days" recurrence_pattern', async () => {
      plannedTransactionRepository.create.mockResolvedValue({
        id: 9, planned_date: '2026-03-15', amount: '50.00', bank_account: 'Chase',
        is_recurring: true, is_executed: false,
      });
      const req = {
        body: {
          planned_date: '2026-03-15', bank_account: 'Chase', amount: 50,
          is_recurring: true, recurrence_pattern: 'every 10 days',
        },
      };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('stores a loan as a monthly recurrence so /execute advances it', async () => {
      plannedTransactionRepository.create.mockResolvedValue({
        id: 3, planned_date: '2026-04-01', amount: '850.00', bank_account: 'Mortgage',
        is_loan: true, is_recurring: true, recurrence_pattern: 'monthly', is_executed: false,
      });

      const req = {
        body: {
          bank_account: 'Mortgage', is_loan: true, loan_type: 'amortizing',
          loan_principal: 10000, loan_annual_interest_rate: 6, loan_term_months: 12,
          loan_start_date: '2026-04-01', loan_payment_day: 1,
          // The frontend may inject a display string; the route must replace it.
          recurrence_pattern: 'loan(12 months)',
        },
      };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(plannedTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ is_loan: true, is_recurring: true, recurrence_pattern: 'monthly' }),
      );
    });

    it('should throw ValidationError when loan_term_months is out of bounds', async () => {
      const req = {
        body: {
          bank_account: 'Mortgage',
          is_loan: true,
          loan_term_months: 601,
        },
      };
      const res = mockResponse();
      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
      expect(plannedTransactionRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /:id', () => {
    it('should return by id', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({
        id: 1, planned_date: '2026-03-15', amount: '50.00',
      });

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/:id'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should throw NotFoundError for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await expect(routeHandlers['get:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('PATCH /:id', () => {
    it('should update', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({ id: 1 });
      plannedTransactionRepository.update.mockResolvedValue({ id: 1, amount: '75.00' });

      const req = { params: { id: '1' }, body: { amount: 75 } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should throw NotFoundError for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { amount: 75 } };
      const res = mockResponse();
      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
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

      const req = {
        params: { id: '1' },
        body: {
          recipient_name: 'John',
          category_name: 'FOOD:GROCERIES',
        },
      };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(plannedTransactionRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          recipient_id: 11,
          category_id: 22,
        })
      );
      expect(res.json).toHaveBeenCalled();
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

      const req = {
        params: { id: '1' },
        body: { is_loan: false },
      };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

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
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('POST /:id/execute', () => {
    it('should execute one-time transaction', async () => {
      plannedTransactionRepository.getById
        .mockResolvedValueOnce({ id: 1, is_recurring: false, is_executed: false })
        .mockResolvedValueOnce({ id: 1, is_executed: true, last_executed_date: '2026-03-15' });
      plannedTransactionRepository.executeAndAdvance.mockResolvedValue({ duplicate: false });

      const req = {
        params: { id: '1' },
        body: { executed_transaction_id: 10, execution_date: '2026-03-15' },
      };
      const res = mockResponse();
      await routeHandlers['post:/:id/execute'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should execute recurring and advance date', async () => {
      plannedTransactionRepository.getById
        .mockResolvedValueOnce({
          id: 1, is_recurring: true, recurrence_pattern: 'monthly',
          planned_date: '2026-03-15', is_executed: false,
        })
        .mockResolvedValueOnce({ id: 1, is_executed: false, planned_date: '2026-04-15' });
      plannedTransactionRepository.executeAndAdvance.mockResolvedValue({ duplicate: false });

      const req = { params: { id: '1' }, body: { executed_transaction_id: 10 } };
      const res = mockResponse();
      await routeHandlers['post:/:id/execute'](req, res);

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

      const req = { params: { id: '1' }, body: { executed_transaction_id: 10 } };
      await routeHandlers['post:/:id/execute'](req, mockResponse());

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

      const req = { params: { id: '1' }, body: { executed_transaction_id: 11 } };
      await routeHandlers['post:/:id/execute'](req, mockResponse());

      const updateFields = plannedTransactionRepository.executeAndAdvance.mock.calls[0][3];
      expect(updateFields.planned_date).toBe('2026-03-28');
    });

    it('should throw ValidationError without executed_transaction_id', async () => {
      const req = { params: { id: '1' }, body: {} };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/execute'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should throw NotFoundError for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { executed_transaction_id: 10 } };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/execute'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('DELETE /:id', () => {
    it('should delete', async () => {
      plannedTransactionRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.json.mock.calls[0][0].data.message).toContain('deleted permanently');
    });

    it('should throw NotFoundError for non-existent', async () => {
      plannedTransactionRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
