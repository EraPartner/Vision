/**
 * Split routes - transaction splitting and debt tracking.
 */

import { Router } from 'express';
import splitRepository from '../repositories/splitRepository.js';
import { validateIdParam } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
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

async function getTransactionSplitTotalsOrThrow(transactionId) {
  const totals = await splitRepository.getTransactionSplitTotals(transactionId);
  if (!totals) throw new NotFoundError('Transaction not found');
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

router.get('/owed', async (req, res) => {
  const summary = await splitRepository.getOwedSummary();
  res.ok({ items: summary, total: summary.length });
});

router.get('/owed/:id', validateIdParam, async (req, res) => {
  const splits = await splitRepository.getOwedByRecipient(parseRouteId(req));
  res.ok({ items: splits, total: splits.length });
});

router.get('/owed/:id/export/csv', validateIdParam, async (req, res) => {
  const recipientId = parseRouteId(req);
  const rows = await splitRepository.getOwedExportRowsByRecipient(recipientId);
  if (rows.length === 0) throw new NotFoundError('No unsettled owed transactions found for recipient');

  const csv = buildOwedExportCsv(rows);
  const filename = buildOwedExportFilename(recipientId);

  // Binary/text download: envelope (ADR-026) does not apply — client receives
  // the CSV body as-is via Content-Disposition: attachment.
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.send(csv);
});

router.get('/transaction/:id', validateIdParam, async (req, res) => {
  const splits = await splitRepository.getSplitsByTransaction(parseRouteId(req));
  res.ok({ items: splits, total: splits.length });
});

router.post('/', async (req, res) => {
  const { transaction_id, recipient_id, amount, note } = req.body;
  if (!transaction_id || !recipient_id || amount == null) {
    throw new ValidationError('Missing required fields: transaction_id, recipient_id, amount');
  }

  const totals = await getTransactionSplitTotalsOrThrow(transaction_id);
  const allocationCheck = validateSplitAllocation({
    newSplitAmount: Number(amount),
    transactionTotal: totals.transaction_total,
    currentSplitTotal: totals.current_split_total,
  });
  if (!allocationCheck.ok) throw new ValidationError(allocationCheck.error);

  const split = await splitRepository.createSplit({ transaction_id, recipient_id, amount, note });
  await splitRepository.writeAudit({
    split_id: split.id,
    action: 'create',
    actor: resolveActor(req),
    payload: { transaction_id, recipient_id, amount: Number(amount), note: note || null },
  });
  res.status(201);
  res.ok(split);
});

router.post('/batch', async (req, res) => {
  const { transaction_id, splits } = req.body;
  if (!transaction_id || !Array.isArray(splits) || splits.length === 0) {
    throw new ValidationError('Missing required fields: transaction_id, splits[]');
  }

  const totals = await getTransactionSplitTotalsOrThrow(transaction_id);
  const preparedSplits = normalizeBatchSplitInputs(splits);
  const batchCheck = validateBatchSplitAllocation({
    splits: preparedSplits,
    transactionTotal: totals.transaction_total,
    currentSplitTotal: totals.current_split_total,
  });
  if (!batchCheck.ok) throw new ValidationError(batchCheck.error);

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
  res.status(201);
  res.ok({ items: created, total: created.length });
});

router.post('/:id/pay', validateIdParam, async (req, res) => {
  const splitId = parseRouteId(req);
  const { amount, note, paid_at } = req.body;

  const split = await splitRepository.getSplitById(splitId);
  if (!split) throw new NotFoundError('Split not found');

  const alreadyPaid = await splitRepository.getAlreadyPaid(splitId);
  const paymentCheck = validatePaymentAmount({
    paymentAmount: Number(amount),
    splitAmount: split.amount,
    alreadyPaid,
  });
  if (!paymentCheck.ok) throw new ValidationError(paymentCheck.error);

  const payment = await splitRepository.addPayment({
    split_id: splitId,
    amount,
    note,
    paid_at,
    actor: resolveActor(req),
  });
  res.status(201);
  res.ok(payment);
});

router.get('/:id/payments', validateIdParam, async (req, res) => {
  const payments = await splitRepository.getPayments(parseRouteId(req));
  res.ok({ items: payments, total: payments.length });
});

router.post('/:id/settle', validateIdParam, async (req, res) => {
  const splitId = parseRouteId(req);
  const split = await splitRepository.settleSplit(splitId);
  if (!split) throw new NotFoundError('Split not found');

  await splitRepository.writeAudit({
    split_id: splitId,
    action: 'settle',
    actor: resolveActor(req),
    payload: { manual: true },
  });
  res.ok(split);
});

router.post('/owed/:id/settle-all', validateIdParam, async (req, res) => {
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
  res.ok(result);
});

router.delete('/:id', validateIdParam, async (req, res) => {
  const splitId = parseRouteId(req);
  const splitBefore = await splitRepository.getSplitById(splitId);
  if (!splitBefore) throw new NotFoundError('Split not found');

  const deleted = await splitRepository.deleteSplit(splitId);
  if (!deleted) throw new NotFoundError('Split not found');

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
  res.ok({ message: 'Split deleted' });
});

export default router;
