/**
 * Recipient Bank Account route tests.
 * Mirrors: apps/backend/tests/test_recipient_bank_accounts.py
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js) — validateIdParam is no longer stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, errEnvelope } from '../helpers/routeApp.js';

// The route imports its repository through services/recipientBankAccountService.js,
// which re-exports the default from this module — mocking the repository here
// intercepts that same binding.
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

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import bankAccountRepo from '../../src/repositories/recipientBankAccountRepository.js';

const { default: recipientBankAccountsRouter } = await import('../../src/routes/recipientBankAccounts.js');

const api = routeAgent(recipientBankAccountsRouter, { mountPath: '/api/recipients' });
const BASE = '/api/recipients';

describe('Recipient Bank Account Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /:recipientId/bank-accounts', () => {
    it('should return bank accounts for recipient', async () => {
      bankAccountRepo.getByRecipientId.mockResolvedValue([
        { id: 1, recipient_id: 1, account_number: 'BE61734041478017', bank_name: 'BELFIUS', is_primary: true },
      ]);

      const res = await api.get(`${BASE}/1/bank-accounts`).expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].account_number).toBe('BE61734041478017');
    });

    it('should return empty list', async () => {
      bankAccountRepo.getByRecipientId.mockResolvedValue([]);

      const res = await api.get(`${BASE}/999/bank-accounts`).expect(200);

      expect(res.body.data.items).toEqual([]);
    });
  });

  describe('POST /:recipientId/bank-accounts', () => {
    it('should create bank account with 201', async () => {
      bankAccountRepo.createOrGet.mockResolvedValue({
        bankAccount: { id: 1, account_number: 'BE61734041478017', bank_name: 'BELFIUS' },
        created: true,
      });

      await api.post(`${BASE}/1/bank-accounts`)
        .send({ account_number: 'BE61734041478017', bank_name: 'Belfius' })
        .expect(201);
    });

    it('should return 200 for existing account', async () => {
      bankAccountRepo.createOrGet.mockResolvedValue({
        bankAccount: { id: 1, account_number: 'BE61734041478017' },
        created: false,
      });

      await api.post(`${BASE}/1/bank-accounts`)
        .send({ account_number: 'BE61734041478017' })
        .expect(200);
    });

    it('should return a 400 VALIDATION_ERROR envelope for missing account_number', async () => {
      const res = await api.post(`${BASE}/1/bank-accounts`).send({}).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('rejects an account_number longer than the VARCHAR(34) column (was a raw 22001 500)', async () => {
      const res = await api.post(`${BASE}/1/bank-accounts`)
        .send({ account_number: 'X'.repeat(35) })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(bankAccountRepo.createOrGet).not.toHaveBeenCalled();
    });

    it('accepts an account_number at the 34-char boundary (IBAN max)', async () => {
      const acct = 'X'.repeat(34);
      bankAccountRepo.createOrGet.mockResolvedValue({
        bankAccount: { id: 2, account_number: acct },
        created: true,
      });

      await api.post(`${BASE}/1/bank-accounts`).send({ account_number: acct }).expect(201);

      expect(bankAccountRepo.createOrGet).toHaveBeenCalledWith(
        expect.objectContaining({ accountNumber: acct }),
      );
    });

    it('rejects a non-integer :id via the real validateIdParam guard', async () => {
      // Previously `vi.mock('.../middleware/validation.js')` replaced
      // validateIdParam with a pass-through, so this guard was never tested.
      const res = await api.post(`${BASE}/abc/bank-accounts`)
        .send({ account_number: 'BE61734041478017' })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(bankAccountRepo.createOrGet).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:recipientId/bank-accounts/:accountId', () => {
    it('should return a 400 VALIDATION_ERROR envelope for invalid account ID', async () => {
      const res = await api.patch(`${BASE}/1/bank-accounts/0`).send({}).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(bankAccountRepo.update).not.toHaveBeenCalled();
    });

    it('should return a 404 NOT_FOUND envelope when account does not exist', async () => {
      bankAccountRepo.update.mockResolvedValue(null);

      const res = await api.patch(`${BASE}/1/bank-accounts/99`)
        .send({ bank_name: 'Belfius' })
        .expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));

      expect(bankAccountRepo.update).toHaveBeenCalledWith(99, {
        bankName: 'Belfius',
        address: undefined,
        accountLabel: undefined,
      });
    });

    it('should return updated account with links when update succeeds', async () => {
      bankAccountRepo.update.mockResolvedValue({ id: 5, bank_name: 'Updated Bank' });

      const res = await api.patch(`${BASE}/1/bank-accounts/5`)
        .send({ bank_name: 'Updated Bank', address: 'Main Street 1', account_label: 'Primary' })
        .expect(200);

      expect(bankAccountRepo.update).toHaveBeenCalledWith(5, {
        bankName: 'Updated Bank',
        address: 'Main Street 1',
        accountLabel: 'Primary',
      });
      expect(res.body.data).toEqual({ id: 5, bank_name: 'Updated Bank', links: [] });
    });

    it('should answer a 500 when update throws', async () => {
      bankAccountRepo.update.mockRejectedValue(new Error('boom'));

      const res = await api.patch(`${BASE}/1/bank-accounts/5`)
        .send({ bank_name: 'Updated Bank' })
        .expect(500);
      expect(res.body.error.message).toBe('boom');
    });
  });

  describe('DELETE /:recipientId/bank-accounts/:accountId', () => {
    it('should return a 400 VALIDATION_ERROR envelope for invalid account ID', async () => {
      const res = await api.delete(`${BASE}/1/bank-accounts/0`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(bankAccountRepo.softDelete).not.toHaveBeenCalled();
    });

    it('should return a 404 NOT_FOUND envelope when delete target does not exist', async () => {
      bankAccountRepo.softDelete.mockResolvedValue(false);

      const res = await api.delete(`${BASE}/1/bank-accounts/15`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });

    // Soft delete, so 200 + the deactivated entity rather than 204 (see
    // docs/reference/code-patterns.md, "DELETE responses").
    it('should deactivate account and return the deactivated entity', async () => {
      bankAccountRepo.softDelete.mockResolvedValue(true);
      bankAccountRepo.getById.mockResolvedValue({ id: 15, account_number: 'BE01', is_active: false });

      const res = await api.delete(`${BASE}/1/bank-accounts/15`).expect(200);

      expect(res.body.data).toEqual({ id: 15, account_number: 'BE01', is_active: false, links: [] });
    });

    it('should answer a 500 when delete throws', async () => {
      bankAccountRepo.softDelete.mockRejectedValue(new Error('boom'));

      const res = await api.delete(`${BASE}/1/bank-accounts/15`).expect(500);
      expect(res.body.error.message).toBe('boom');
    });
  });

  describe('POST /:recipientId/bank-accounts/:accountId/set-primary', () => {
    it('should return a 404 NOT_FOUND envelope when setPrimary fails', async () => {
      bankAccountRepo.setPrimary.mockResolvedValue(false);

      const res = await api.post(`${BASE}/1/bank-accounts/99/set-primary`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
      expect(bankAccountRepo.setPrimary).toHaveBeenCalledWith(99, 1);
    });

    it('should return a 400 VALIDATION_ERROR envelope when account ID is invalid', async () => {
      const res = await api.post(`${BASE}/1/bank-accounts/invalid/set-primary`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(bankAccountRepo.setPrimary).not.toHaveBeenCalled();
    });

    it('should return account payload when setting primary succeeds', async () => {
      bankAccountRepo.setPrimary.mockResolvedValue(true);
      bankAccountRepo.getById.mockResolvedValue({ id: 2, recipient_id: 1, is_primary: true });

      const res = await api.post(`${BASE}/1/bank-accounts/2/set-primary`).expect(200);

      expect(bankAccountRepo.setPrimary).toHaveBeenCalledWith(2, 1);
      expect(bankAccountRepo.getById).toHaveBeenCalledWith(2);
      expect(res.body.data).toEqual({ id: 2, recipient_id: 1, is_primary: true, links: [] });
    });

    it('should answer a 500 when setPrimary throws', async () => {
      bankAccountRepo.setPrimary.mockRejectedValue(new Error('boom'));

      const res = await api.post(`${BASE}/1/bank-accounts/2/set-primary`).expect(500);
      expect(res.body.error.message).toBe('boom');
    });
  });
});
