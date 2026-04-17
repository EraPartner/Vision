import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../src/repositories/splitRepository.js', () => ({
  default: {
    getOwedSummary: vi.fn(),
    getOwedByRecipient: vi.fn(),
    getSplitsByTransaction: vi.fn(),
    getOwedExportRowsByRecipient: vi.fn(),
    getTransactionSplitTotals: vi.fn(),
    createSplit: vi.fn(),
    createSplitsBatch: vi.fn(),
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
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import splitRepository from '../../src/repositories/splitRepository.js';
await import('../../src/routes/splits.js');

describe('Splits Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /owed', () => {
    it('returns owed summary items', async () => {
      splitRepository.getOwedSummary.mockResolvedValue([{ recipient_id: 2, amount: 12.5 }]);

      const req = { params: {}, query: {}, get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/owed'](req, res);

      expect(res.json).toHaveBeenCalledWith({ items: [{ recipient_id: 2, amount: 12.5 }] });
    });

    it('returns 500 when owed summary fails', async () => {
      splitRepository.getOwedSummary.mockRejectedValue(new Error('boom'));

      const req = { params: {}, query: {}, get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/owed'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error getting owed summary' });
    });
  });

  describe('GET /owed/:id', () => {
    it('returns owed items by recipient', async () => {
      splitRepository.getOwedByRecipient.mockResolvedValue([{ id: 1, split_id: 4 }]);

      const req = { params: { id: '7' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/owed/:id'](req, res);

      expect(splitRepository.getOwedByRecipient).toHaveBeenCalledWith(7);
      expect(res.json).toHaveBeenCalledWith({ items: [{ id: 1, split_id: 4 }] });
    });

    it('returns 500 when owed by recipient fails', async () => {
      splitRepository.getOwedByRecipient.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '7' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/owed/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error getting owed by recipient' });
    });
  });

  describe('POST /', () => {
    it('rejects split that exceeds transaction total', async () => {
      splitRepository.getTransactionSplitTotals.mockResolvedValue({
        transaction_total: 100,
        current_split_total: 90,
      });

      const req = { body: { transaction_id: 1, recipient_id: 2, amount: 15 } , get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Split amount exceeds transaction total' });
      expect(splitRepository.createSplit).not.toHaveBeenCalled();
    });

    it('creates split when amount fits remaining total', async () => {
      splitRepository.getTransactionSplitTotals.mockResolvedValue({
        transaction_total: 100,
        current_split_total: 80,
      });
      splitRepository.createSplit.mockResolvedValue({ id: 7, transaction_id: 1, recipient_id: 2, amount: 20 });

      const req = { body: { transaction_id: 1, recipient_id: 2, amount: 20 } , get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(splitRepository.createSplit).toHaveBeenCalledWith(expect.objectContaining({ amount: 20 }));
    });
  });

  describe('POST /batch', () => {
    it('returns 404 when transaction does not exist', async () => {
      splitRepository.getTransactionSplitTotals.mockResolvedValue(null);

      const req = {
        body: {
          transaction_id: 1,
          splits: [{ recipient_id: 2, amount: 10 }],
        },
        get: () => null,
      };
      const res = mockResponse();
      await routeHandlers['post:/batch'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Transaction not found' });
      expect(splitRepository.createSplitsBatch).not.toHaveBeenCalled();
    });

    it('rejects batch when cumulative amount exceeds transaction total', async () => {
      splitRepository.getTransactionSplitTotals.mockResolvedValue({
        transaction_total: 100,
        current_split_total: 70,
      });

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
      await routeHandlers['post:/batch'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Split amount exceeds transaction total' });
      expect(splitRepository.createSplit).not.toHaveBeenCalled();
    });

    it('rejects non-positive split amounts in batch', async () => {
      splitRepository.getTransactionSplitTotals.mockResolvedValue({
        transaction_total: 100,
        current_split_total: 0,
      });

      const req = {
        body: {
          transaction_id: 1,
          splits: [{ recipient_id: 2, amount: 0 }],
        },
        get: () => null,
      };
      const res = mockResponse();
      await routeHandlers['post:/batch'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Split amount must be a positive number' });
      expect(splitRepository.createSplitsBatch).not.toHaveBeenCalled();
    });

    it('creates batch with normalized splits', async () => {
      splitRepository.getTransactionSplitTotals.mockResolvedValue({
        transaction_total: 100,
        current_split_total: 0,
      });
      splitRepository.createSplitsBatch.mockResolvedValue([{ id: 1 }]);

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

      expect(splitRepository.createSplitsBatch).toHaveBeenCalledWith({
        transaction_id: 1,
        splits: [{ recipient_id: 2, amount: 20, note: 'x' }],
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ items: [{ id: 1 }] });
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

      const req = { params: { id: '7' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/owed/:id/export/csv'](req, res);

      expect(splitRepository.getOwedExportRowsByRecipient).toHaveBeenCalledWith(7);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
      const body = res.send.mock.calls[0][0];
      expect(body).toContain('Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment');
      expect(body).toContain('2026-03-20,Main,Coffee Shop,Lunch,5,EUR,100,FOOD:LUNCH,shared');
    });

    it('returns 404 when recipient has no unsettled owed transactions', async () => {
      splitRepository.getOwedExportRowsByRecipient.mockResolvedValue([]);

      const req = { params: { id: '7' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/owed/:id/export/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'No unsettled owed transactions found for recipient' });
    });
  });

  describe('GET /transaction/:id', () => {
    it('returns splits for transaction', async () => {
      splitRepository.getSplitsByTransaction.mockResolvedValue([{ id: 8, transaction_id: 2 }]);

      const req = { params: { id: '2' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/transaction/:id'](req, res);

      expect(splitRepository.getSplitsByTransaction).toHaveBeenCalledWith(2);
      expect(res.json).toHaveBeenCalledWith({ items: [{ id: 8, transaction_id: 2 }] });
    });

    it('returns 500 when transaction splits lookup fails', async () => {
      splitRepository.getSplitsByTransaction.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '2' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/transaction/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error getting splits' });
    });
  });

  describe('POST /:id/pay', () => {
    it('returns 404 when split does not exist', async () => {
      splitRepository.getSplitById.mockResolvedValue(null);

      const req = { params: { id: '5' }, body: { amount: 5 } , get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/:id/pay'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Split not found' });
      expect(splitRepository.addPayment).not.toHaveBeenCalled();
    });

    it('returns 400 for non-positive payment amount', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 5, amount: 100 });
      splitRepository.getAlreadyPaid.mockResolvedValue(0);

      const req = { params: { id: '5' }, body: { amount: 0 } , get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/:id/pay'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Payment amount must be a positive number' });
      expect(splitRepository.addPayment).not.toHaveBeenCalled();
    });

    it('records payment and returns 201', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 7, amount: 100 });
      splitRepository.getAlreadyPaid.mockResolvedValue(0);
      splitRepository.addPayment.mockResolvedValue({ id: 5, split_id: 7, amount: 12 });

      const req = { params: { id: '7' }, body: { amount: 12, note: 'partial', paid_at: '2026-03-20' } , get: () => null };
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
      expect(res.json).toHaveBeenCalledWith({ id: 5, split_id: 7, amount: 12 });
    });

    it('returns 500 when recording payment fails', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 7, amount: 100 });
      splitRepository.getAlreadyPaid.mockResolvedValue(0);
      splitRepository.addPayment.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '7' }, body: { amount: 12 } , get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/:id/pay'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error recording payment' });
    });
  });

  describe('GET /:id/payments', () => {
    it('returns split payments', async () => {
      splitRepository.getPayments.mockResolvedValue([{ id: 3, split_id: 7, amount: 6 }]);

      const req = { params: { id: '7' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/:id/payments'](req, res);

      expect(splitRepository.getPayments).toHaveBeenCalledWith(7);
      expect(res.json).toHaveBeenCalledWith({ items: [{ id: 3, split_id: 7, amount: 6 }] });
    });

    it('returns 500 when payments lookup fails', async () => {
      splitRepository.getPayments.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '7' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['get:/:id/payments'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error getting payments' });
    });
  });

  describe('POST /:id/settle', () => {
    it('returns 404 when split is not found', async () => {
      splitRepository.settleSplit.mockResolvedValue(null);

      const req = { params: { id: '9' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/:id/settle'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Split not found' });
    });

    it('returns settled split when found', async () => {
      splitRepository.settleSplit.mockResolvedValue({ id: 9, settled: true });

      const req = { params: { id: '9' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/:id/settle'](req, res);

      expect(res.json).toHaveBeenCalledWith({ id: 9, settled: true });
    });

    it('returns 500 when settle fails', async () => {
      splitRepository.settleSplit.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '9' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/:id/settle'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error settling split' });
    });
  });

  describe('POST /owed/:id/settle-all', () => {
    it('returns settle-all result', async () => {
      splitRepository.settleAllByRecipient.mockResolvedValue({ updated: 2 });

      const req = { params: { id: '12' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/owed/:id/settle-all'](req, res);

      expect(splitRepository.settleAllByRecipient).toHaveBeenCalledWith(12);
      expect(res.json).toHaveBeenCalledWith({ updated: 2 });
    });

    it('returns 500 when settle-all fails', async () => {
      splitRepository.settleAllByRecipient.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '12' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['post:/owed/:id/settle-all'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error settling all splits for recipient' });
    });
  });

  describe('DELETE /:id', () => {
    it('returns 404 when split does not exist', async () => {
      splitRepository.getSplitById.mockResolvedValue(null);

      const req = { params: { id: '1' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Split not found' });
      expect(splitRepository.deleteSplit).not.toHaveBeenCalled();
    });

    it('returns 404 when split cannot be deleted', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 1, transaction_id: 2, recipient_id: 3, amount: 10 });
      splitRepository.deleteSplit.mockResolvedValue(false);

      const req = { params: { id: '1' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Split not found' });
    });

    it('returns success payload when split is deleted', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 1, transaction_id: 2, recipient_id: 3, amount: 10 });
      splitRepository.deleteSplit.mockResolvedValue(true);

      const req = { params: { id: '1' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.json).toHaveBeenCalledWith({ message: 'Split deleted' });
    });

    it('returns 500 when deleting split fails', async () => {
      splitRepository.getSplitById.mockResolvedValue({ id: 1, transaction_id: 2, recipient_id: 3, amount: 10 });
      splitRepository.deleteSplit.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '1' } , get: () => null };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error deleting split' });
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
