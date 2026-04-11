/**
 * Recipient Bank Account route tests.
 * Mirrors: apps/backend/tests/test_recipient_bank_accounts.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...args) => { routeHandlers[`get:${path}`] = args[args.length - 1]; }),
  post: vi.fn((path, ...args) => { routeHandlers[`post:${path}`] = args[args.length - 1]; }),
  patch: vi.fn((path, ...args) => { routeHandlers[`patch:${path}`] = args[args.length - 1]; }),
  delete: vi.fn((path, ...args) => { routeHandlers[`delete:${path}`] = args[args.length - 1]; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/repositories/recipientBankAccountRepository.js', () => ({
  default: {
    getByRecipientId: vi.fn(),
    getByAccountNumber: vi.fn(),
    getById: vi.fn(),
    createOrGet: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    setPrimary: vi.fn(),
  },
}));

vi.mock('../../src/middleware/validation.js', () => ({
  validateIdParam: (req, res, next) => next(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import bankAccountRepo from '../../src/repositories/recipientBankAccountRepository.js';
await import('../../src/routes/recipientBankAccounts.js');

describe('Recipient Bank Account Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /:recipientId/bank-accounts', () => {
    it('should return bank accounts for recipient', async () => {
      bankAccountRepo.getByRecipientId.mockResolvedValue([
        { id: 1, recipient_id: 1, account_number: 'BE61734041478017', bank_name: 'BELFIUS', is_primary: true },
      ]);

      const req = { params: { id: '1' }, query: {} };
      const res = mockResponse();
      await routeHandlers['get:/:id/bank-accounts'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.items).toHaveLength(1);
      expect(data.items[0].account_number).toBe('BE61734041478017');
    });

    it('should return empty list', async () => {
      bankAccountRepo.getByRecipientId.mockResolvedValue([]);

      const req = { params: { id: '999' }, query: {} };
      const res = mockResponse();
      await routeHandlers['get:/:id/bank-accounts'](req, res);

      expect(res.json.mock.calls[0][0].items).toEqual([]);
    });
  });

  describe('POST /:recipientId/bank-accounts', () => {
    it('should create bank account with 201', async () => {
      bankAccountRepo.createOrGet.mockResolvedValue({
        bankAccount: { id: 1, account_number: 'BE61734041478017', bank_name: 'BELFIUS' },
        created: true,
      });

      const req = {
        params: { id: '1' },
        body: { account_number: 'BE61734041478017', bank_name: 'Belfius' },
      };
      const res = mockResponse();
      await routeHandlers['post:/:id/bank-accounts'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 200 for existing account', async () => {
      bankAccountRepo.createOrGet.mockResolvedValue({
        bankAccount: { id: 1, account_number: 'BE61734041478017' },
        created: false,
      });

      const req = {
        params: { id: '1' },
        body: { account_number: 'BE61734041478017' },
      };
      const res = mockResponse();
      await routeHandlers['post:/:id/bank-accounts'](req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should return 400 for missing account_number', async () => {
      const req = { params: { id: '1' }, body: {} };
      const res = mockResponse();
      await routeHandlers['post:/:id/bank-accounts'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('PATCH /:recipientId/bank-accounts/:accountId', () => {
    it('should return 400 for invalid account ID', async () => {
      const req = { params: { id: '1', accountId: '0' }, body: {} };
      const res = mockResponse();
      await routeHandlers['patch:/:id/bank-accounts/:accountId'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Invalid account ID' });
      expect(bankAccountRepo.update).not.toHaveBeenCalled();
    });

    it('should return 404 when account does not exist', async () => {
      bankAccountRepo.update.mockResolvedValue(null);

      const req = {
        params: { id: '1', accountId: '99' },
        body: { bank_name: 'Belfius' },
      };
      const res = mockResponse();
      await routeHandlers['patch:/:id/bank-accounts/:accountId'](req, res);

      expect(bankAccountRepo.update).toHaveBeenCalledWith(99, {
        bankName: 'Belfius',
        address: undefined,
        accountLabel: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Bank account not found' });
    });

    it('should return updated account with links when update succeeds', async () => {
      bankAccountRepo.update.mockResolvedValue({ id: 5, bank_name: 'Updated Bank' });

      const req = {
        params: { id: '1', accountId: '5' },
        body: { bank_name: 'Updated Bank', address: 'Main Street 1', account_label: 'Primary' },
      };
      const res = mockResponse();
      await routeHandlers['patch:/:id/bank-accounts/:accountId'](req, res);

      expect(bankAccountRepo.update).toHaveBeenCalledWith(5, {
        bankName: 'Updated Bank',
        address: 'Main Street 1',
        accountLabel: 'Primary',
      });
      expect(res.json).toHaveBeenCalledWith({ id: 5, bank_name: 'Updated Bank', links: [] });
    });

    it('should return 500 when update throws', async () => {
      bankAccountRepo.update.mockRejectedValue(new Error('boom'));

      const req = {
        params: { id: '1', accountId: '5' },
        body: { bank_name: 'Updated Bank' },
      };
      const res = mockResponse();
      await routeHandlers['patch:/:id/bank-accounts/:accountId'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error updating bank account' });
    });
  });

  describe('DELETE /:recipientId/bank-accounts/:accountId', () => {
    it('should return 400 for invalid account ID', async () => {
      const req = { params: { id: '1', accountId: '0' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id/bank-accounts/:accountId'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Invalid account ID' });
      expect(bankAccountRepo.softDelete).not.toHaveBeenCalled();
    });

    it('should return 404 when delete target does not exist', async () => {
      bankAccountRepo.softDelete.mockResolvedValue(false);

      const req = { params: { id: '1', accountId: '15' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id/bank-accounts/:accountId'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Bank account not found' });
    });

    it('should deactivate account and return message when delete succeeds', async () => {
      bankAccountRepo.softDelete.mockResolvedValue(true);

      const req = { params: { id: '1', accountId: '15' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id/bank-accounts/:accountId'](req, res);

      expect(res.json).toHaveBeenCalledWith({ message: 'Bank account 15 deactivated', links: [] });
    });

    it('should return 500 when delete throws', async () => {
      bankAccountRepo.softDelete.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '1', accountId: '15' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id/bank-accounts/:accountId'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error deleting bank account' });
    });
  });

  describe('POST /:recipientId/bank-accounts/:accountId/set-primary', () => {
    it('should return 404 when setPrimary fails', async () => {
      bankAccountRepo.setPrimary.mockResolvedValue(false);

      const req = { params: { id: '1', accountId: '99' } };
      const res = mockResponse();
      await routeHandlers['post:/:id/bank-accounts/:accountId/set-primary'](req, res);

      expect(bankAccountRepo.setPrimary).toHaveBeenCalledWith(99, 1);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Bank account not found or does not belong to this recipient' });
    });

    it('should return 400 when account ID is invalid', async () => {
      const req = { params: { id: '1', accountId: 'invalid' } };
      const res = mockResponse();
      await routeHandlers['post:/:id/bank-accounts/:accountId/set-primary'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Invalid account ID' });
      expect(bankAccountRepo.setPrimary).not.toHaveBeenCalled();
    });

    it('should return account payload when setting primary succeeds', async () => {
      bankAccountRepo.setPrimary.mockResolvedValue(true);
      bankAccountRepo.getById.mockResolvedValue({ id: 2, recipient_id: 1, is_primary: true });

      const req = { params: { id: '1', accountId: '2' } };
      const res = mockResponse();
      await routeHandlers['post:/:id/bank-accounts/:accountId/set-primary'](req, res);

      expect(bankAccountRepo.setPrimary).toHaveBeenCalledWith(2, 1);
      expect(bankAccountRepo.getById).toHaveBeenCalledWith(2);
      expect(res.json).toHaveBeenCalledWith({ id: 2, recipient_id: 1, is_primary: true, links: [] });
    });

    it('should return 500 when setPrimary throws', async () => {
      bankAccountRepo.setPrimary.mockRejectedValue(new Error('boom'));

      const req = { params: { id: '1', accountId: '2' } };
      const res = mockResponse();
      await routeHandlers['post:/:id/bank-accounts/:accountId/set-primary'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error setting primary bank account' });
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
