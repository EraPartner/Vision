import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/repositories/splitRepository.js', () => ({
  default: {
    getOwedSummary: vi.fn(),
    getOwedByRecipient: vi.fn(),
    getSplitsByTransaction: vi.fn(),
    getOwedExportRowsByRecipient: vi.fn(),
    getTransactionSplitTotals: vi.fn(),
    createSplitAtomic: vi.fn(),
    createSplitsBatch: vi.fn(),
    createSplitsBatchAtomic: vi.fn(),
    addPayment: vi.fn(),
    getPayments: vi.fn(),
    settleSplit: vi.fn(),
    settleAllByRecipient: vi.fn(),
    deleteSplit: vi.fn(),
    getSplitById: vi.fn(),
    getAlreadyPaid: vi.fn(),
    writeAudit: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import splitRepository from '../../src/repositories/splitRepository.js';
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/splits.js');

describe('Splits Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /owed', () => {
    it('returns owed summary items', async () => {
      splitRepository.getOwedSummary.mockResolvedValue([{ recipient_id: 2, amount: 12.5 }]);

      const req = { params: {}, query: {}, get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/owed'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: { items: [{ recipient_id: 2, amount: 12.5 }], total: 1 },
      });
    });

    it('propagates error when owed summary fails', async () => {
      splitRepository.getOwedSummary.mockRejectedValue(new Error('boom'));

      const req = { params: {}, query: {}, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['get:/owed'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('GET /owed/:id', () => {
    it('returns owed items by recipient', async () => {
      splitRepository.getOwedByRecipient.mockResolvedValue([{ id: 1, split_id: 4 }]);

      const req = { params: { id: '7' }, get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/owed/:id'](req, res);

      expect(splitRepository.getOwedByRecipient).toHaveBeenCalledWith(7);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: { items: [{ id: 1, split_id: 4 }], total: 1 },
      });
    });

    it('propagates error when owed by recipient fails', async () => {
      splitRepository.getOwedByRecipient.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '7' }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['get:/owed/:id'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('POST /', () => {
    it('throws ValidationError when split exceeds transaction total', async () => {
      splitRepository.createSplitAtomic.mockRejectedValue(new ValidationError('Split would exceed transaction total'));

      const req = { body: { transaction_id: 1, recipient_id: 2, amount: 15 }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates split when amount fits remaining total', async () => {
      splitRepository.createSplitAtomic.mockResolvedValue({ id: 7, transaction_id: 1, recipient_id: 2, amount: 20 });
      splitRepository.writeAudit.mockResolvedValue();

      const req = { body: { transaction_id: 1, recipient_id: 2, amount: 20 }, get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(splitRepository.createSplitAtomic).toHaveBeenCalledWith(expect.objectContaining({ amount: 20 }));
    });
  });

  describe('POST /batch', () => {
    it('throws NotFoundError when transaction does not exist', async () => {
      splitRepository.createSplitsBatchAtomic.mockRejectedValue(new NotFoundError('Transaction not found'));

      const req = {
        body: {
          transaction_id: 1,
          splits: [{ recipient_id: 2, amount: 10 }],
        },
        get: () => null,
      };
      const res = mockResponse();
      await expect(routeHandlers['post:/batch'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws ValidationError when cumulative amount exceeds transaction total', async () => {
      splitRepository.createSplitsBatchAtomic.mockRejectedValue(new ValidationError('Split would exceed transaction total'));

      const req = {
        body: {
          transaction_id: 1,
          splits: [
            { recipient_id: 2, amount: 20 },
            { recipient_id: 3, amount: 15 },
          ],
        },
        get: () => null,
      };
      const res = mockResponse();
      await expect(routeHandlers['post:/batch'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError for non-positive split amounts in batch', async () => {
      splitRepository.createSplitsBatchAtomic.mockRejectedValue(new ValidationError('Split amount must be a positive number'));

      const req = {
        body: {
          transaction_id: 1,
          splits: [{ recipient_id: 2, amount: 0 }],
        },
        get: () => null,
      };
      const res = mockResponse();
      await expect(routeHandlers['post:/batch'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates batch with normalized splits', async () => {
      splitRepository.createSplitsBatchAtomic.mockResolvedValue([{ id: 1 }]);
      splitRepository.writeAudit.mockResolvedValue();

      const req = {
        body: {
          transaction_id: 1,
          splits: [
            { recipient_id: 2, amount: 20, note: 'x' },
            { recipient_id: null, amount: 20, note: 'ignored' },
          ],
        },
        get: () => null,
      };
      const res = mockResponse();
      await routeHandlers['post:/batch'](req, res);

      expect(splitRepository.createSplitsBatchAtomic).toHaveBeenCalledWith({
        transaction_id: 1,
        splits: [{ recipient_id: 2, amount: 20, note: 'x' }],
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: { items: [{ id: 1 }], total: 1 },
      });
    });
  });

  describe('GET /owed/:id/export/csv', () => {
    it('returns csv with remaining split amount rows', async () => {
      splitRepository.getOwedExportRowsByRecipient.mockResolvedValue([
        {
          date: '2026-03-20',
          bank_account: 'Main',
          recipient_name: 'Coffee Shop',
          memo: 'Lunch',
          amount: 5,
          currency: 'EUR',
          balance: 100,
          category_name: 'FOOD:LUNCH',
          comment: 'shared',
        },
      ]);

      const req = { params: { id: '7' }, get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/owed/:id/export/csv'](req, res);

      expect(splitRepository.getOwedExportRowsByRecipient).toHaveBeenCalledWith(7);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
      const body = res.send.mock.calls[0][0];
      expect(body).toContain('Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment');
      expect(body).toContain('2026-03-20,Main,Coffee Shop,Lunch,5,EUR,100,FOOD:LUNCH,shared');
    });

    it('throws NotFoundError when recipient has no unsettled owed transactions', async () => {
      splitRepository.getOwedExportRowsByRecipient.mockResolvedValue([]);

      const req = { params: { id: '7' }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['get:/owed/:id/export/csv'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('GET /transaction/:id', () => {
    it('returns splits for transaction', async () => {
      splitRepository.getSplitsByTransaction.mockResolvedValue([{ id: 8, transaction_id: 2 }]);

      const req = { params: { id: '2' }, get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/transaction/:id'](req, res);

      expect(splitRepository.getSplitsByTransaction).toHaveBeenCalledWith(2);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: { items: [{ id: 8, transaction_id: 2 }], total: 1 },
      });
    });

    it('propagates error when transaction splits lookup fails', async () => {
      splitRepository.getSplitsByTransaction.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '2' }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['get:/transaction/:id'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('POST /:id/pay', () => {
    it('throws NotFoundError when split does not exist', async () => {
      splitRepository.addPayment.mockRejectedValue(new NotFoundError('Split not found'));

      const req = { params: { id: '5' }, body: { amount: 5 }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/pay'](req, res)).rejects.toBeInstanceOf(NotFoundError);
      expect(splitRepository.addPayment).toHaveBeenCalled();
    });

    it('throws ValidationError for non-positive payment amount', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 5, amount: 100 });
      splitRepository.getAlreadyPaid.mockResolvedValue(0);

      const req = { params: { id: '5' }, body: { amount: 0 }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/pay'](req, res)).rejects.toBeInstanceOf(ValidationError);
      expect(splitRepository.addPayment).not.toHaveBeenCalled();
    });

    it('records payment and returns 201', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 7, amount: 100 });
      splitRepository.getAlreadyPaid.mockResolvedValue(0);
      splitRepository.addPayment.mockResolvedValue({ id: 5, split_id: 7, amount: 12 });

      const req = { params: { id: '7' }, body: { amount: 12, note: 'partial', paid_at: '2026-03-20' }, get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/:id/pay'](req, res);

      expect(splitRepository.addPayment).toHaveBeenCalledWith({
        split_id: 7,
        amount: 12,
        note: 'partial',
        paid_at: '2026-03-20',
        actor: null,
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { id: 5, split_id: 7, amount: 12 } });
    });

    it('propagates error when recording payment fails', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 7, amount: 100 });
      splitRepository.getAlreadyPaid.mockResolvedValue(0);
      splitRepository.addPayment.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '7' }, body: { amount: 12 }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/pay'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('GET /:id/payments', () => {
    it('returns split payments', async () => {
      splitRepository.getPayments.mockResolvedValue([{ id: 3, split_id: 7, amount: 6 }]);

      const req = { params: { id: '7' }, get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/:id/payments'](req, res);

      expect(splitRepository.getPayments).toHaveBeenCalledWith(7);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: { items: [{ id: 3, split_id: 7, amount: 6 }], total: 1 },
      });
    });

    it('propagates error when payments lookup fails', async () => {
      splitRepository.getPayments.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '7' }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['get:/:id/payments'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('POST /:id/settle', () => {
    it('throws NotFoundError when split is not found', async () => {
      splitRepository.settleSplit.mockResolvedValue(null);

      const req = { params: { id: '9' }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/settle'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('returns settled split when found', async () => {
      splitRepository.settleSplit.mockResolvedValue({ id: 9, settled: true });
      splitRepository.writeAudit.mockResolvedValue();

      const req = { params: { id: '9' }, get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/:id/settle'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { id: 9, settled: true } });
    });

    it('propagates error when settle fails', async () => {
      splitRepository.settleSplit.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '9' }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/settle'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('POST /owed/:id/settle-all', () => {
    it('returns settle-all result', async () => {
      splitRepository.settleAllByRecipient.mockResolvedValue({ settled_count: 2 });
      splitRepository.writeAudit.mockResolvedValue();

      const req = { params: { id: '12' }, get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/owed/:id/settle-all'](req, res);

      expect(splitRepository.settleAllByRecipient).toHaveBeenCalledWith(12);
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { settled_count: 2 } });
    });

    it('propagates error when settle-all fails', async () => {
      splitRepository.settleAllByRecipient.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '12' }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['post:/owed/:id/settle-all'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('DELETE /:id', () => {
    it('throws NotFoundError when split does not exist', async () => {
      splitRepository.getSplitById.mockResolvedValue(null);

      const req = { params: { id: '1' }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
      expect(splitRepository.deleteSplit).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when split cannot be deleted', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 1, transaction_id: 2, recipient_id: 3, amount: 10 });
      splitRepository.deleteSplit.mockResolvedValue(false);

      const req = { params: { id: '1' }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('returns success payload when split is deleted', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 1, transaction_id: 2, recipient_id: 3, amount: 10 });
      splitRepository.deleteSplit.mockResolvedValue(true);
      splitRepository.writeAudit.mockResolvedValue();

      const req = { params: { id: '1' }, get: () => null };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { message: 'Split deleted' } });
    });

    it('propagates error when deleting split fails', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 1, transaction_id: 2, recipient_id: 3, amount: 10 });
      splitRepository.deleteSplit.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '1' }, get: () => null };
      const res = mockResponse();
      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toThrow('boom');
    });
  });
});

function mockResponse() {
  return createMockResponse({ setHeader: vi.fn() });
}
