/**
 * Split routes - transaction splitting and debt tracking.
 */

import { Router } from 'express';
import splitRepository from '../repositories/splitRepository.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';
import {
  validateSplitAllocation,
  validateBatchSplitAllocation,
  validatePaymentAmount,
} from '../services/calculations/splits.js';

const router = Router();

const OWED_EXPORT_HEADER = 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment';

function parseRouteId(req) {
  return parseInt(req.params.id, 10);
}

function escapeCsvValue(value) {
  if (value == null) return '';
  const stringValue = String(value);
  return stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}

function buildOwedExportCsvRow(row) {
  return [
    row.date,
    row.bank_account,
    row.recipient_name,
    row.memo,
    row.amount,
    row.currency,
    row.balance,
    row.category_name,
    row.comment,
  ].map(escapeCsvValue).join(',');
}

function buildOwedExportCsv(rows) {
  const csvRows = rows.map(buildOwedExportCsvRow);
  return [OWED_EXPORT_HEADER, ...csvRows].join('\n');
}

function buildOwedExportFilename(recipientId) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `owed_transactions_recipient_${recipientId}_${timestamp}.csv`;
}

async function getTransactionSplitTotalsOr404(transactionId, res) {
  const totals = await splitRepository.getTransactionSplitTotals(transactionId);
  if (!totals) {
    res.status(404).json({ detail: 'Transaction not found' });
    return undefined;
  }
  return totals;
}

function normalizeBatchSplitInputs(splits) {
  return splits
    .filter((split) => split?.recipient_id && split?.amount != null)
    .map((split) => ({
      recipient_id: split.recipient_id,
      amount: Number(split.amount),
      note: split.note,
    }));
}

function resolveActor(req) {
  return req.get('x-actor') || req.user?.id || null;
}

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
    const splits = await splitRepository.getOwedByRecipient(parseRouteId(req));
    res.json({ items: splits });
  } catch (err) {
    logger.error('Error getting owed by recipient', { error: err.message });
    res.status(500).json({ detail: 'Error getting owed by recipient' });
  }
});

// GET /api/splits/owed/:id/export/csv - Export unsettled owed transactions for recipient
router.get('/owed/:id/export/csv', validateIdParam, async (req, res) => {
  try {
    const recipientId = parseRouteId(req);
    const rows = await splitRepository.getOwedExportRowsByRecipient(recipientId);

    if (rows.length === 0) {
      return res.status(404).json({ detail: 'No unsettled owed transactions found for recipient' });
    }

    const csv = buildOwedExportCsv(rows);
    const filename = buildOwedExportFilename(recipientId);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(csv);
  } catch (err) {
    logger.error('Error exporting owed transactions csv', { error: err.message });
    res.status(500).json({ detail: 'Error exporting owed transactions' });
  }
});

// GET /api/splits/transaction/:transactionId - Splits for a transaction
router.get('/transaction/:id', validateIdParam, async (req, res) => {
  try {
    const splits = await splitRepository.getSplitsByTransaction(parseRouteId(req));
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

    const totals = await getTransactionSplitTotalsOr404(transaction_id, res);
    if (!totals) return;

    const allocationCheck = validateSplitAllocation({
      newSplitAmount: Number(amount),
      transactionTotal: totals.transaction_total,
      currentSplitTotal: totals.current_split_total,
    });
    if (!allocationCheck.ok) {
      return res.status(400).json({ detail: allocationCheck.error });
    }

    const split = await splitRepository.createSplit({ transaction_id, recipient_id, amount, note });
    await splitRepository.writeAudit({
      split_id: split.id,
      action: 'create',
      actor: resolveActor(req),
      payload: { transaction_id, recipient_id, amount: Number(amount), note: note || null },
    });
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

    const totals = await getTransactionSplitTotalsOr404(transaction_id, res);
    if (!totals) return;

    const preparedSplits = normalizeBatchSplitInputs(splits);
    const batchCheck = validateBatchSplitAllocation({
      splits: preparedSplits,
      transactionTotal: totals.transaction_total,
      currentSplitTotal: totals.current_split_total,
    });
    if (!batchCheck.ok) {
      return res.status(400).json({ detail: batchCheck.error });
    }

    const created = await splitRepository.createSplitsBatch({
      transaction_id,
      splits: preparedSplits,
    });
    const actor = resolveActor(req);
    for (const split of created) {
      await splitRepository.writeAudit({
        split_id: split.id,
        action: 'create',
        actor,
        payload: {
          transaction_id,
          recipient_id: split.recipient_id,
          amount: Number(split.amount),
          note: split.note || null,
          batch: true,
        },
      });
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
    const splitId = parseRouteId(req);
    const { amount, note, paid_at } = req.body;

    const split = await splitRepository.getSplitById(splitId);
    if (!split) {
      return res.status(404).json({ detail: 'Split not found' });
    }
    const alreadyPaid = await splitRepository.getAlreadyPaid(splitId);
    const paymentCheck = validatePaymentAmount({
      paymentAmount: Number(amount),
      splitAmount: split.amount,
      alreadyPaid,
    });
    if (!paymentCheck.ok) {
      return res.status(400).json({ detail: paymentCheck.error });
    }

    const payment = await splitRepository.addPayment({
      split_id: splitId,
      amount,
      note,
      paid_at,
      actor: resolveActor(req),
    });
    res.status(201).json(payment);
  } catch (err) {
    logger.error('Error recording payment', { error: err.message });
    res.status(500).json({ detail: 'Error recording payment' });
  }
});

// GET /api/splits/:id/payments - Get payments for a split
router.get('/:id/payments', validateIdParam, async (req, res) => {
  try {
    const payments = await splitRepository.getPayments(parseRouteId(req));
    res.json({ items: payments });
  } catch (err) {
    logger.error('Error getting payments', { error: err.message });
    res.status(500).json({ detail: 'Error getting payments' });
  }
});

// POST /api/splits/:id/settle - Mark a split as settled
router.post('/:id/settle', validateIdParam, async (req, res) => {
  try {
    const splitId = parseRouteId(req);
    const split = await splitRepository.settleSplit(splitId);
    if (!split) {
      return res.status(404).json({ detail: 'Split not found' });
    }
    await splitRepository.writeAudit({
      split_id: splitId,
      action: 'settle',
      actor: resolveActor(req),
      payload: { manual: true },
    });
    res.json(split);
  } catch (err) {
    logger.error('Error settling split', { error: err.message });
    res.status(500).json({ detail: 'Error settling split' });
  }
});

// POST /api/splits/owed/:id/settle-all - Mark all unsettled splits for a recipient as settled
router.post('/owed/:id/settle-all', validateIdParam, async (req, res) => {
  try {
    const recipientId = parseRouteId(req);
    const result = await splitRepository.settleAllByRecipient(recipientId);
    if (result.settled_count > 0) {
      await splitRepository.writeAudit({
        split_id: null,
        action: 'settle_all',
        actor: resolveActor(req),
        payload: { recipient_id: recipientId, settled_count: result.settled_count },
      });
    }
    res.json(result);
  } catch (err) {
    logger.error('Error settling all splits for recipient', { error: err.message });
    res.status(500).json({ detail: 'Error settling all splits for recipient' });
  }
});

// DELETE /api/splits/:id - Delete a split
router.delete('/:id', validateIdParam, async (req, res) => {
  try {
    const splitId = parseRouteId(req);
    const splitBefore = await splitRepository.getSplitById(splitId);
    if (!splitBefore) {
      return res.status(404).json({ detail: 'Split not found' });
    }
    const deleted = await splitRepository.deleteSplit(splitId);
    if (!deleted) {
      return res.status(404).json({ detail: 'Split not found' });
    }
    await splitRepository.writeAudit({
      split_id: null,
      action: 'delete',
      actor: resolveActor(req),
      payload: {
        split_id: splitId,
        transaction_id: splitBefore.transaction_id,
        recipient_id: splitBefore.recipient_id,
        amount: splitBefore.amount,
      },
    });
    res.json({ message: 'Split deleted' });
  } catch (err) {
    logger.error('Error deleting split', { error: err.message });
    res.status(500).json({ detail: 'Error deleting split' });
  }
});

export default router;
