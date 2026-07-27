/**
 * Split routes - transaction splitting and debt tracking.
 *
 * Bodies are validated with zod (schema → safeParse → ValidationError), the
 * idiom established in settings.js/reports.js. Schemas are LOOSE and forward
 * raw values (the repos take the coercion decisions); id bridges reuse
 * validateId so accepted shapes keep parseInt coercion exactly as before.
 */

import { Router } from 'express';
import { z } from 'zod';
import splitRepository from '../services/splitService.js';
import { validateIdParam, validateId } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { escapeCsvValue } from '../lib/csv.js';

const router = Router();

const OWED_EXPORT_HEADER = 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment';

function parseRouteId(req) {
  return parseInt(req.params.id, 10);
}

function buildOwedExportCsvRow(row) {
  return [
    escapeCsvValue(row.date),
    escapeCsvValue(row.bank_account),
    escapeCsvValue(row.recipient_name),
    escapeCsvValue(row.memo),
    escapeCsvValue(row.amount),
    escapeCsvValue(row.currency),
    escapeCsvValue(row.balance),
    escapeCsvValue(row.category_name),
    escapeCsvValue(row.comment),
  ].join(',');
}

function buildOwedExportCsv(rows) {
  const csvRows = rows.map(buildOwedExportCsvRow);
  return [OWED_EXPORT_HEADER, ...csvRows].join('\n');
}

function buildOwedExportFilename(recipientId) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `owed_transactions_recipient_${recipientId}_${timestamp}.csv`;
}

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

// Reuses validateId so the accepted id shapes stay identical (parseInt
// coercion: '12abc' → 12; 1..2^31-1 bounds); the coerced integer replaces the
// raw input.
const validatedIdField = (field) => z.unknown().transform((value, ctx) => {
  const result = validateId(value, field);
  if (!result.valid) {
    ctx.addIssue({ code: 'custom', message: result.error });
    return z.NEVER;
  }
  return result.value;
});

// One /batch row. A row that fails this schema rejects the WHOLE request with
// a 400 naming the offending index — bulk writes are all-or-nothing, matching
// the transactions.js bulk-tag/bulk-update pattern (validate everything up
// front, then write). Finite non-positive amounts still parse here (the repo
// rejects them), so valid batches normalize exactly as before.
const batchSplitRowSchema = z.object({
  recipient_id: validatedIdField('recipient_id'),
  amount: z.unknown().transform((value, ctx) => {
    const num = Number(value);
    if (value == null || !Number.isFinite(num)) {
      ctx.addIssue({ code: 'custom', message: 'amount must be a finite number' });
      return z.NEVER;
    }
    return num;
  }),
  note: z.unknown().optional(),
});

// POST body: raw values are forwarded to the repository unchanged (only the
// audit payload coerces amount), so the checks refine without transforming.
const createSplitSchema = z.looseObject({}).superRefine((data, ctx) => {
  if (!data.transaction_id || !data.recipient_id || data.amount == null) {
    ctx.addIssue({ code: 'custom', message: 'Missing required fields: transaction_id, recipient_id, amount' });
    return;
  }
  // FK ids were only truthiness-checked before, so a non-integer (e.g. "abc")
  // reached Postgres as an FK/type error and surfaced as a raw 500.
  const txIdCheck = validateId(data.transaction_id, 'transaction_id');
  if (!txIdCheck.valid) ctx.addIssue({ code: 'custom', message: txIdCheck.error });
  const recIdCheck = validateId(data.recipient_id, 'recipient_id');
  if (!recIdCheck.valid) ctx.addIssue({ code: 'custom', message: recIdCheck.error });
  if (!Number.isFinite(Number(data.amount))) {
    ctx.addIssue({ code: 'custom', message: 'amount must be a finite number' });
  }
});

const batchSplitsSchema = z.looseObject({}).superRefine((data, ctx) => {
  if (!data.transaction_id || !Array.isArray(data.splits) || data.splits.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Missing required fields: transaction_id, splits[]' });
    return;
  }
  const txIdCheck = validateId(data.transaction_id, 'transaction_id');
  if (!txIdCheck.valid) ctx.addIssue({ code: 'custom', message: txIdCheck.error });
});

const payBodySchema = z.looseObject({}).superRefine((data, ctx) => {
  if (data.amount == null || !Number.isFinite(Number(data.amount)) || Number(data.amount) <= 0) {
    ctx.addIssue({ code: 'custom', message: 'Payment amount must be a positive number' });
  }
});

function formatIssues(error, separator) {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join(separator);
}

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
function parseSplitsBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(formatIssues(result.error, '; '));
  }
  return result.data;
}

// All-or-nothing: every row must parse. A malformed row used to be silently
// dropped and the rest committed, so a client could not tell that part of its
// batch never landed; now any bad row aborts the request before a single write.
// Every offending row is collected first so the 400 names them all — one
// round-trip to fix the whole payload, rather than one per bad row.
function normalizeBatchSplitInputs(splits) {
  const prepared = [];
  const rejected = [];

  splits.forEach((split, index) => {
    const result = batchSplitRowSchema.safeParse(split);
    if (result.success) prepared.push(result.data);
    else rejected.push(`splits[${index}] (${formatIssues(result.error, ', ')})`);
  });

  if (rejected.length > 0) {
    throw new ValidationError(`Invalid splits, no splits were created: ${rejected.join('; ')}`);
  }
  return prepared;
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
  const { transaction_id, recipient_id, amount, note } = parseSplitsBody(createSplitSchema, req.body);

  const split = await splitRepository.createSplitAtomic({ transaction_id, recipient_id, amount, note });
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
  const { transaction_id, splits } = parseSplitsBody(batchSplitsSchema, req.body);

  // Throws on any malformed row, so nothing is written unless every row is
  // valid; a batch whose rows ALL fail is covered by the same 400 (it can
  // never reach the repository as an empty `splits`, since the body schema
  // already rejects an empty array).
  const preparedSplits = normalizeBatchSplitInputs(/** @type {unknown[]} */ (splits));
  const created = await splitRepository.createSplitsBatchAtomic({
    transaction_id,
    splits: preparedSplits,
  });
  const actor = resolveActor(req);
  // Independent rows — write audits in parallel.
  await Promise.all(created.map((split) => splitRepository.writeAudit({
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
  })));
  res.status(201);
  res.ok({ items: created, total: created.length });
});

router.post('/:id/pay', validateIdParam, async (req, res) => {
  const splitId = parseRouteId(req);
  const { amount, note, paid_at } = parseSplitsBody(payBodySchema, req.body);
  // Repo serializes existence + overpayment check + insert under
  // SELECT … FOR UPDATE; routes no longer precheck (race window).
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
