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
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
