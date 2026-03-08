/**
 * Transaction routes.
 *
 * Mirrors: apps/backend/api/api_routes_transactions.py
 */

import { Router } from 'express';
import transactionRepository from '../repositories/transactionRepository.js';
import { logger } from '../config/logger.js';

const router = Router();

// GET /api/transactions
router.get('/', async (req, res) => {
  try {
    const {
      limit = 50, offset = 0,
      start_date, end_date, bank_account,
      category_id, recipient_id, recipient_name,
      uncategorised, active = 'true',
    } = req.query;

    const opts = {
      limit: Math.min(parseInt(limit, 10) || 50, 5000),
      offset: parseInt(offset, 10) || 0,
      startDate: start_date || null,
      endDate: end_date || null,
      bankAccount: bank_account || null,
      categoryId: category_id ? parseInt(category_id, 10) : null,
      recipientId: recipient_id ? parseInt(recipient_id, 10) : null,
      recipientName: recipient_name || null,
      active: active !== 'false',
    };

    let items;
    if (uncategorised === 'true') {
      items = await transactionRepository.getUncategorised(opts);
    } else {
      items = await transactionRepository.getAll(opts);
    }

    const total = await transactionRepository.getCount(opts);

    // Map date field to transaction_date for frontend compatibility
    const mappedItems = items.map(formatTransaction);

    res.json({
      items: mappedItems,
      total,
      limit: opts.limit,
      offset: opts.offset,
      links: [],
    });
  } catch (err) {
    logger.error('Error retrieving transactions', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving transactions' });
  }
});

// GET /api/transactions/:id
router.get('/:id', async (req, res) => {
  try {
    const transaction = await transactionRepository.getById(parseInt(req.params.id, 10));
    if (!transaction) {
      return res.status(404).json({ detail: `Transaction with ID ${req.params.id} not found` });
    }
    res.json(formatTransaction(transaction));
  } catch (err) {
    logger.error('Error retrieving transaction', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving transaction' });
  }
});

// POST /api/transactions
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    // Support alias "date" -> "transaction_date"
    const txDate = data.transaction_date || data.date;
    if (!txDate || !data.bank_account || !data.recipient_id || data.amount == null) {
      return res.status(400).json({ detail: 'Missing required fields: date, bank_account, recipient_id, amount' });
    }

    const transaction = await transactionRepository.create({
      transaction_date: txDate,
      bank_account: data.bank_account,
      recipient_id: data.recipient_id,
      amount: data.amount,
      memo: data.memo,
      currency: data.currency,
      balance: data.balance,
      category_id: data.category_id,
      comment: data.comment,
    });

    logger.info('Transaction created', { id: transaction.id });
    res.status(201).json(formatTransaction(transaction));
  } catch (err) {
    logger.error('Error creating transaction', { error: err.message });
    res.status(500).json({ detail: 'Error creating transaction' });
  }
});

// PATCH /api/transactions/:id
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const fields = { ...req.body };

    // Handle date alias
    if (fields.date) {
      fields.transaction_date = fields.date;
      delete fields.date;
    }

    // Remove fields that shouldn't be set directly
    delete fields.links;
    delete fields.id;
    delete fields.created_at;

    const updated = await transactionRepository.update(id, fields);
    if (!updated) {
      return res.status(404).json({ detail: `Transaction with ID ${id} not found` });
    }

    res.json(formatTransaction(updated));
  } catch (err) {
    logger.error('Error updating transaction', { error: err.message });
    res.status(500).json({ detail: `Error updating transaction: ${err.message}` });
  }
});

// DELETE /api/transactions/:id
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const deleted = await transactionRepository.hardDelete(id);
    if (!deleted) {
      return res.status(404).json({ detail: `Transaction with ID ${id} not found` });
    }
    res.json({ message: 'Transaction deleted permanently', details: { method: 'hard delete' }, links: [] });
  } catch (err) {
    logger.error('Error deleting transaction', { error: err.message });
    res.status(500).json({ detail: 'Error deleting transaction' });
  }
});

/**
 * Format a transaction row for API response.
 * Maps the DB "date" column to "transaction_date" and adds empty links array.
 */
function formatTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    transaction_date: row.date,
    date: row.date, // alias for backend compatibility
    bank_account: row.bank_account,
    recipient_id: row.recipient_id,
    recipient_name: row.recipient_name || null,
    memo: row.memo,
    amount: parseFloat(row.amount),
    currency: row.currency,
    balance: row.balance != null ? parseFloat(row.balance) : null,
    category_id: row.category_id,
    category_name: row.category_name || null,
    comment: row.comment,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    links: [],
  };
}

export default router;
