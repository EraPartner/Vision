/**
 * Recipient Bank Account routes.
 *
 * Mirrors: apps/backend/api/api_routes_recipients.py (bank account sub-resources)
 * + apps/backend/services/recipient_bank_account_service.py
 *
 * Provides CRUD endpoints for managing bank accounts linked to recipients.
 */

import { Router } from 'express';
import recipientBankAccountRepository from '../repositories/recipientBankAccountRepository.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';

const router = Router();

// GET /api/recipients/:id/bank-accounts - List all bank accounts for a recipient
router.get('/:id/bank-accounts', validateIdParam, async (req, res) => {
  try {
    const recipientId = parseInt(req.params.id, 10);
    const activeOnly = req.query.active !== 'false';
    const accounts = await recipientBankAccountRepository.getByRecipientId(recipientId, activeOnly);
    res.json({ items: accounts, total: accounts.length, links: [] });
  } catch (err) {
    logger.error('Error retrieving bank accounts', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving bank accounts' });
  }
});

// POST /api/recipients/:id/bank-accounts - Create or get a bank account
router.post('/:id/bank-accounts', validateIdParam, async (req, res) => {
  try {
    const recipientId = parseInt(req.params.id, 10);
    const { account_number, bank_name, address, account_label, set_as_primary } = req.body;

    if (!account_number) {
      return res.status(400).json({ detail: 'Missing required field: account_number' });
    }

    const { bankAccount, created } = await recipientBankAccountRepository.createOrGet({
      recipientId,
      accountNumber: account_number,
      bankName: bank_name || null,
      address: address || null,
      accountLabel: account_label || null,
      setAsPrimary: !!set_as_primary,
    });

    res.status(created ? 201 : 200).json({ ...bankAccount, links: [] });
  } catch (err) {
    logger.error('Error creating bank account', { error: err.message });
    if (err.message === 'Account number is required') {
      return res.status(400).json({ detail: err.message });
    }
    res.status(500).json({ detail: 'Error creating bank account' });
  }
});

// PATCH /api/recipients/:recipientId/bank-accounts/:accountId - Update a bank account
router.patch('/:id/bank-accounts/:accountId', validateIdParam, async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    if (isNaN(accountId) || accountId < 1) {
      return res.status(400).json({ detail: 'Invalid account ID' });
    }

    const { bank_name, address, account_label } = req.body;
    const updated = await recipientBankAccountRepository.update(accountId, {
      bankName: bank_name,
      address,
      accountLabel: account_label,
    });

    if (!updated) {
      return res.status(404).json({ detail: 'Bank account not found' });
    }
    res.json({ ...updated, links: [] });
  } catch (err) {
    logger.error('Error updating bank account', { error: err.message });
    res.status(500).json({ detail: 'Error updating bank account' });
  }
});

// DELETE /api/recipients/:recipientId/bank-accounts/:accountId - Soft delete a bank account
router.delete('/:id/bank-accounts/:accountId', validateIdParam, async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    if (isNaN(accountId) || accountId < 1) {
      return res.status(400).json({ detail: 'Invalid account ID' });
    }

    const deleted = await recipientBankAccountRepository.softDelete(accountId);
    if (!deleted) {
      return res.status(404).json({ detail: 'Bank account not found' });
    }
    res.json({ message: `Bank account ${accountId} deactivated`, links: [] });
  } catch (err) {
    logger.error('Error deleting bank account', { error: err.message });
    res.status(500).json({ detail: 'Error deleting bank account' });
  }
});

// POST /api/recipients/:recipientId/bank-accounts/:accountId/set-primary
router.post('/:id/bank-accounts/:accountId/set-primary', validateIdParam, async (req, res) => {
  try {
    const recipientId = parseInt(req.params.id, 10);
    const accountId = parseInt(req.params.accountId, 10);
    if (isNaN(accountId) || accountId < 1) {
      return res.status(400).json({ detail: 'Invalid account ID' });
    }

    const success = await recipientBankAccountRepository.setPrimary(accountId, recipientId);
    if (!success) {
      return res.status(404).json({ detail: 'Bank account not found or does not belong to this recipient' });
    }

    const account = await recipientBankAccountRepository.getById(accountId);
    res.json({ ...account, links: [] });
  } catch (err) {
    logger.error('Error setting primary bank account', { error: err.message });
    res.status(500).json({ detail: 'Error setting primary bank account' });
  }
});

export default router;
