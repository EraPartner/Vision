/**
 * Planned transaction route tests.
 * Mirrors: apps/backend/tests/test_planned_transactions.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...handlers) => { routeHandlers[`get:${path}`] = handlers[handlers.length - 1]; }),
  post: vi.fn((path, ...handlers) => { routeHandlers[`post:${path}`] = handlers[handlers.length - 1]; }),
  patch: vi.fn((path, ...handlers) => { routeHandlers[`patch:${path}`] = handlers[handlers.length - 1]; }),
  delete: vi.fn((path, ...handlers) => { routeHandlers[`delete:${path}`] = handlers[handlers.length - 1]; }),
  use: vi.fn(),
};

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
    hardDelete: vi.fn(),
    addExecution: vi.fn(),
    replaceLoanSchedule: vi.fn(),
  },
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

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import plannedTransactionRepository from '../../src/repositories/plannedTransactionRepository.js';
await import('../../src/routes/plannedTransactions.js');

describe('Planned Transaction Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return empty list', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 0 });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return planned transactions', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({
        items: [{ id: 1, planned_date: '2026-03-15', amount: '50.00', is_recurring: false, is_executed: false }],
        total: 1,
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].total).toBe(1);
    });

    it('should respect pagination', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 10 });

      const req = { query: { limit: '5', offset: '2' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.limit).toBe(5);
      expect(result.offset).toBe(2);
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

    it('should return 400 for missing fields', async () => {
      const req = { body: { amount: 50 } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
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
          amount: -850,
          planned_date: '2026-04-01',
        })
      );
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

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await routeHandlers['get:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
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

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { amount: 75 } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /:id/execute', () => {
    it('should execute one-time transaction', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({
        id: 1, is_recurring: false, is_executed: false,
      });
      plannedTransactionRepository.addExecution.mockResolvedValue({});
      plannedTransactionRepository.update.mockResolvedValue({
        id: 1, is_executed: true, last_executed_date: '2026-03-15',
      });

      const req = {
        params: { id: '1' },
        body: { executed_transaction_id: 10, execution_date: '2026-03-15' },
      };
      const res = mockResponse();
      await routeHandlers['post:/:id/execute'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should execute recurring and advance date', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({
        id: 1, is_recurring: true, recurrence_pattern: 'monthly',
        planned_date: '2026-03-15', is_executed: false,
      });
      plannedTransactionRepository.addExecution.mockResolvedValue({});
      plannedTransactionRepository.update.mockResolvedValue({
        id: 1, is_executed: false, planned_date: '2026-04-15',
      });

      const req = { params: { id: '1' }, body: { executed_transaction_id: 10 } };
      const res = mockResponse();
      await routeHandlers['post:/:id/execute'](req, res);

      const updateCall = plannedTransactionRepository.update.mock.calls[0];
      expect(updateCall[1].is_executed).toBe(false);
    });

    it('should return 400 without executed_transaction_id', async () => {
      const req = { params: { id: '1' }, body: {} };
      const res = mockResponse();
      await routeHandlers['post:/:id/execute'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { executed_transaction_id: 10 } };
      const res = mockResponse();
      await routeHandlers['post:/:id/execute'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /:id', () => {
    it('should delete', async () => {
      plannedTransactionRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.json.mock.calls[0][0].message).toContain('deleted permanently');
    });

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
