/**
 * Split routes - transaction splitting and debt tracking.
 */

import { Router } from 'express';
import splitRepository from '../repositories/splitRepository.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';

const router = Router();

// GET /api/splits/owed - Summary of who owes what
router.get('/owed', async (req, res) => {
  try {
    const summary = await splitRepository.getOwedSummary();
    res.json({ items: summary });
  } catch (err) {
    logger.error('Error getting owed summary', { error: err.message });
    res.status(500).json({ detail: 'Error getting owed summary' });
  }
});

// GET /api/splits/owed/:recipientId - Detailed splits owed by a recipient
router.get('/owed/:id', validateIdParam, async (req, res) => {
  try {
    const splits = await splitRepository.getOwedByRecipient(parseInt(req.params.id, 10));
    res.json({ items: splits });
  } catch (err) {
    logger.error('Error getting owed by recipient', { error: err.message });
    res.status(500).json({ detail: 'Error getting owed by recipient' });
  }
});

// GET /api/splits/transaction/:transactionId - Splits for a transaction
router.get('/transaction/:id', validateIdParam, async (req, res) => {
  try {
    const splits = await splitRepository.getSplitsByTransaction(parseInt(req.params.id, 10));
    res.json({ items: splits });
  } catch (err) {
    logger.error('Error getting splits for transaction', { error: err.message });
    res.status(500).json({ detail: 'Error getting splits' });
  }
});

// POST /api/splits - Create a split
router.post('/', async (req, res) => {
  try {
    const { transaction_id, recipient_id, amount, note } = req.body;
    if (!transaction_id || !recipient_id || amount == null) {
      return res.status(400).json({ detail: 'Missing required fields: transaction_id, recipient_id, amount' });
    }
    const split = await splitRepository.createSplit({ transaction_id, recipient_id, amount, note });
    res.status(201).json(split);
  } catch (err) {
    logger.error('Error creating split', { error: err.message });
    res.status(500).json({ detail: 'Error creating split' });
  }
});

// POST /api/splits/batch - Create multiple splits for a transaction at once
router.post('/batch', async (req, res) => {
  try {
    const { transaction_id, splits } = req.body;
    if (!transaction_id || !Array.isArray(splits) || splits.length === 0) {
      return res.status(400).json({ detail: 'Missing required fields: transaction_id, splits[]' });
    }
    const created = [];
    for (const s of splits) {
      if (!s.recipient_id || s.amount == null) continue;
      const split = await splitRepository.createSplit({
        transaction_id,
        recipient_id: s.recipient_id,
        amount: s.amount,
        note: s.note,
      });
      created.push(split);
    }
    res.status(201).json({ items: created });
  } catch (err) {
    logger.error('Error creating batch splits', { error: err.message });
    res.status(500).json({ detail: 'Error creating splits' });
  }
});

// POST /api/splits/:id/pay - Record a payment
router.post('/:id/pay', validateIdParam, async (req, res) => {
  try {
    const splitId = parseInt(req.params.id, 10);
    const { amount, note, paid_at } = req.body;
    if (amount == null || amount <= 0) {
      return res.status(400).json({ detail: 'Amount must be a positive number' });
    }
    const payment = await splitRepository.addPayment({ split_id: splitId, amount, note, paid_at });
    res.status(201).json(payment);
  } catch (err) {
    logger.error('Error recording payment', { error: err.message });
    res.status(500).json({ detail: 'Error recording payment' });
  }
});

// GET /api/splits/:id/payments - Get payments for a split
router.get('/:id/payments', validateIdParam, async (req, res) => {
  try {
    const payments = await splitRepository.getPayments(parseInt(req.params.id, 10));
    res.json({ items: payments });
  } catch (err) {
    logger.error('Error getting payments', { error: err.message });
    res.status(500).json({ detail: 'Error getting payments' });
  }
});

// POST /api/splits/:id/settle - Mark a split as settled
router.post('/:id/settle', validateIdParam, async (req, res) => {
  try {
    const split = await splitRepository.settleSplit(parseInt(req.params.id, 10));
    if (!split) {
      return res.status(404).json({ detail: 'Split not found' });
    }
    res.json(split);
  } catch (err) {
    logger.error('Error settling split', { error: err.message });
    res.status(500).json({ detail: 'Error settling split' });
  }
});

// DELETE /api/splits/:id - Delete a split
router.delete('/:id', validateIdParam, async (req, res) => {
  try {
    const deleted = await splitRepository.deleteSplit(parseInt(req.params.id, 10));
    if (!deleted) {
      return res.status(404).json({ detail: 'Split not found' });
    }
    res.json({ message: 'Split deleted' });
  } catch (err) {
    logger.error('Error deleting split', { error: err.message });
    res.status(500).json({ detail: 'Error deleting split' });
  }
});

export default router;
