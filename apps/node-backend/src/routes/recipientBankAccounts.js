/**
 * Recipient Bank Account routes.
 */

import { Router } from 'express';
import recipientBankAccountRepository from '../services/recipientBankAccountService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam, assertMaxLength } from '../middleware/validation.js';

const router = Router();

function parseAccountId(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) throw new ValidationError('Invalid account ID');
  return n;
}

router.get('/:id/bank-accounts', validateIdParam, async (req, res) => {
  const recipientId = parseInt(req.params.id, 10);
  const activeOnly = req.query.active !== 'false';
  const accounts = await recipientBankAccountRepository.getByRecipientId(recipientId, activeOnly);
  res.ok({ items: accounts, total: accounts.length });
});

router.post('/:id/bank-accounts', validateIdParam, async (req, res) => {
  const recipientId = parseInt(req.params.id, 10);
  const { account_number, bank_name, address, account_label, set_as_primary } = req.body;

  if (!account_number) throw new ValidationError('Missing required field: account_number');
  // account_number is VARCHAR(34) (IBAN max width, migration 0001) — an
  // over-length value otherwise reached the column as a raw 22001 500.
  assertMaxLength(account_number, 34, 'account_number');

  const { bankAccount, created } = await recipientBankAccountRepository.createOrGet({
    recipientId,
    accountNumber: account_number,
    bankName: bank_name || null,
    address: address || null,
    accountLabel: account_label || null,
    setAsPrimary: !!set_as_primary,
  });

  res.status(created ? 201 : 200);
  res.ok({ ...bankAccount, links: [] });
});

router.patch('/:id/bank-accounts/:accountId', validateIdParam, async (req, res) => {
  const accountId = parseAccountId(req.params.accountId);
  const { bank_name, address, account_label } = req.body;
  const updated = await recipientBankAccountRepository.update(accountId, {
    bankName: bank_name,
    address,
    accountLabel: account_label,
  });
  if (!updated) throw new NotFoundError('Bank account not found');
  res.ok({ ...updated, links: [] });
});

// Deactivation, not a hard delete: the row survives with is_active = false, so
// this returns the deactivated entity rather than 204 (docs/reference/code-patterns.md,
// "DELETE responses") — same shape as set-primary below.
router.delete('/:id/bank-accounts/:accountId', validateIdParam, async (req, res) => {
  const accountId = parseAccountId(req.params.accountId);
  const deactivated = await recipientBankAccountRepository.softDelete(accountId);
  if (!deactivated) throw new NotFoundError('Bank account not found');
  const account = await recipientBankAccountRepository.getById(accountId);
  res.ok({ ...account, links: [] });
});

router.post('/:id/bank-accounts/:accountId/set-primary', validateIdParam, async (req, res) => {
  const recipientId = parseInt(req.params.id, 10);
  const accountId = parseAccountId(req.params.accountId);
  const success = await recipientBankAccountRepository.setPrimary(accountId, recipientId);
  if (!success) throw new NotFoundError('Bank account not found or does not belong to this recipient');
  const account = await recipientBankAccountRepository.getById(accountId);
  res.ok({ ...account, links: [] });
});

export default router;
