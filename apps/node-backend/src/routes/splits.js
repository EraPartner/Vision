/**
 * Split routes - transaction splitting and debt tracking.
 *
 * Bodies are validated with zod (schema → safeParse → ValidationError), the
 * idiom established in settings.js/reports.js. Schemas are LOOSE and forward
 * raw values (the repos take the coercion decisions); id bridges reuse
 * validateId so accepted shapes keep parseInt coercion exactly as before.
 */

/// <reference path="../types/thirdPartyModules.d.ts" />
import { Router } from 'express';
import { z } from 'zod';
import splitRepository from '../services/splitService.js';
import { validateIdParam, validateId } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { escapeCsvValue } from '../lib/csv.js';
import { listBody, parseOptionalPagination } from '../lib/pagination.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

/**
 * The row shape yielded by splitRepository.getOwedExportRowsByRecipient.
 * @typedef {object} OwedExportRow
 * @property {Date} date
 * @property {string|null} bank_account
 * @property {string|null} recipient_name
 * @property {string|null} memo
 * @property {number} amount
 * @property {string|null} currency
 * @property {string|null} balance
 * @property {string} category_name
 * @property {string|null} comment
 */

const router = Router();

const OWED_EXPORT_HEADER = 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment';

/** @param {ExpressRequest} req */
function parseRouteId(req) {
  return parseInt(req.params.id, 10);
}

/** @param {OwedExportRow} row */
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

/** @param {OwedExportRow[]} rows */
function buildOwedExportCsv(rows) {
  const csvRows = rows.map(buildOwedExportCsvRow);
  return [OWED_EXPORT_HEADER, ...csvRows].join('\n');
}

/** @param {number} recipientId */
function buildOwedExportFilename(recipientId) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `owed_transactions_recipient_${recipientId}_${timestamp}.csv`;
}

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

// Reuses validateId so the accepted id shapes stay identical (parseInt
// coercion: '12abc' → 12; 1..2^31-1 bounds); the coerced integer replaces the
// raw input.
/** @param {string} field */
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

/**
 * @param {z.ZodError} error
 * @param {string} separator
 */
function formatIssues(error, separator) {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join(separator);
}

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
/**
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} body
 * @returns {T}
 */
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
/** @param {unknown[]} splits */
function normalizeBatchSplitInputs(splits) {
  /** @type {z.infer<typeof batchSplitRowSchema>[]} */
  const prepared = [];
  /** @type {string[]} */
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

/** @param {ExpressRequest} req */
function resolveActor(req) {
  // `req.user` is never assigned anywhere in this codebase (grep confirms: no
  // auth middleware sets it) — this `?? req.user?.id` branch is dead code,
  // always falling through to the `x-actor` header or null. Left as-is (zero
  // behavior change); flagged as a backlog finding rather than fixed here.
  return req.get('x-actor') || /** @type {any} */ (req).user?.id || null;
}

// Pagination is opt-in on every list below: without limit/offset the whole
// collection is returned exactly as before, so no existing client is truncated.
//
// The owed summary is derived in JS after the aggregate (see the repository),
// so this one pages the computed array rather than the query; `total` is still
// the full group count.
router.get('/owed', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const summary = await splitRepository.getOwedSummary();
  const items = page ? summary.slice(page.offset, page.offset + page.limit) : summary;
  res.ok(listBody(items, summary.length, page));
});

router.get('/owed/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const recipientId = parseRouteId(req);
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const splits = await splitRepository.getOwedByRecipient(recipientId, page ?? {});
  const total = page
    ? await splitRepository.countOwedByRecipient(recipientId)
    : splits.length;
  res.ok(listBody(splits, total, page));
});

router.get('/owed/:id/export/csv', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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

router.get('/transaction/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const transactionId = parseRouteId(req);
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const splits = await splitRepository.getSplitsByTransaction(transactionId, page ?? {});
  const total = page
    ? await splitRepository.countSplitsByTransaction(transactionId)
    : splits.length;
  res.ok(listBody(splits, total, page));
});

router.post('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { transaction_id, recipient_id, amount, note } = parseSplitsBody(createSplitSchema, req.body);

  // createSplitSchema is `z.looseObject({})` — raw values forwarded unchanged
  // (see module doc); superRefine validates shape/presence but zod's inferred
  // type is still `unknown` per field. The cast documents what's actually
  // been checked by the time this line runs.
  const split = await splitRepository.createSplitAtomic(
    /** @type {{ transaction_id: number, recipient_id: number, amount: number|string, note?: string|null }} */
    ({ transaction_id, recipient_id, amount, note }),
  );
  await splitRepository.writeAudit({
    split_id: split.id,
    action: 'create',
    actor: resolveActor(req),
    payload: { transaction_id, recipient_id, amount: Number(amount), note: note || null },
  });
  res.status(201);
  res.ok(split);
});

router.post('/batch', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { transaction_id, splits } = parseSplitsBody(batchSplitsSchema, req.body);

  // Throws on any malformed row, so nothing is written unless every row is
  // valid; a batch whose rows ALL fail is covered by the same 400 (it can
  // never reach the repository as an empty `splits`, since the body schema
  // already rejects an empty array).
  const preparedSplits = normalizeBatchSplitInputs(/** @type {unknown[]} */ (splits));
  // batchSplitsSchema is `z.looseObject({})` — transaction_id is validated by
  // superRefine but zod's inferred type is still `unknown`; preparedSplits'
  // per-row shape traces back through a zod .transform() chain whose output
  // type doesn't narrow past `any`/`unknown` here either. Both are cast to
  // what's actually been validated by the time this line runs.
  const created = await splitRepository.createSplitsBatchAtomic(
    /** @type {{ transaction_id: number, splits: Array<{ recipient_id: number, amount: number, note?: string }> }} */
    ({ transaction_id, splits: preparedSplits }),
  );
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

router.post('/:id/pay', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const splitId = parseRouteId(req);
  const { amount, note, paid_at } = parseSplitsBody(payBodySchema, req.body);
  // payBodySchema is `z.looseObject({})` — amount is validated by superRefine
  // but zod's inferred type is still `unknown` (raw values forwarded
  // unchanged, see module doc). Cast documents what's actually been checked.
  // Repo serializes existence + overpayment check + insert under
  // SELECT … FOR UPDATE; routes no longer precheck (race window).
  const payment = await splitRepository.addPayment(
    /** @type {{ split_id: number, amount: number, note?: string|null, paid_at?: string|null, actor?: string|null }} */
    ({
      split_id: splitId,
      amount,
      note,
      paid_at,
      actor: resolveActor(req),
    }),
  );
  res.status(201);
  res.ok(payment);
});

router.get('/:id/payments', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const splitId = parseRouteId(req);
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const payments = await splitRepository.getPayments(splitId, page ?? {});
  const total = page ? await splitRepository.countPayments(splitId) : payments.length;
  res.ok(listBody(payments, total, page));
});

router.post('/:id/settle', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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

router.post('/owed/:id/settle-all', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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

router.delete('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

export default router;
