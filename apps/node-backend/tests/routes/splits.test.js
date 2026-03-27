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
    addPayment: vi.fn(),
    getPayments: vi.fn(),
    settleSplit: vi.fn(),
    settleAllByRecipient: vi.fn(),
    deleteSplit: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import splitRepository from '../../src/repositories/splitRepository.js';
await import('../../src/routes/splits.js');

describe('Splits Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('POST /', () => {
    it('rejects split that exceeds transaction total', async () => {
      splitRepository.getTransactionSplitTotals.mockResolvedValue({
        transaction_total: 100,
        current_split_total: 90,
      });

      const req = { body: { transaction_id: 1, recipient_id: 2, amount: 15 } };
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

      const req = { body: { transaction_id: 1, recipient_id: 2, amount: 20 } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(splitRepository.createSplit).toHaveBeenCalledWith(expect.objectContaining({ amount: 20 }));
    });
  });

  describe('POST /batch', () => {
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
      };
      const res = mockResponse();
      await routeHandlers['post:/batch'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Split amount exceeds transaction total' });
      expect(splitRepository.createSplit).not.toHaveBeenCalled();
    });

    it('rejects non-positive split amounts in batch', async () => {
      const req = {
        body: {
          transaction_id: 1,
          splits: [{ recipient_id: 2, amount: 0 }],
        },
      };
      const res = mockResponse();
      await routeHandlers['post:/batch'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Split amount must be a positive number' });
      expect(splitRepository.getTransactionSplitTotals).not.toHaveBeenCalled();
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

      const req = { params: { id: '7' } };
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

      const req = { params: { id: '7' } };
      const res = mockResponse();
      await routeHandlers['get:/owed/:id/export/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'No unsettled owed transactions found for recipient' });
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
