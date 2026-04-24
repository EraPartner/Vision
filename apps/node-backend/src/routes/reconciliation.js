/**
 * Bank reconciliation routes.
 *
 * GET    /api/reconciliation/statements              — list statements
 * POST   /api/reconciliation/statements              — create statement
 * GET    /api/reconciliation/statements/:id          — get statement (with entry summary)
 * PATCH  /api/reconciliation/statements/:id          — update statement header
 * DELETE /api/reconciliation/statements/:id          — delete statement + entries
 *
 * GET    /api/reconciliation/statements/:id/entries  — list entries
 * POST   /api/reconciliation/statements/:id/entries  — add entries (single or bulk)
 * DELETE /api/reconciliation/statements/:id/entries/:entryId — delete entry
 *
 * GET    /api/reconciliation/statements/:id/entries/:entryId/candidates — auto-match candidates
 * POST   /api/reconciliation/statements/:id/entries/:entryId/match      — set match
 * DELETE /api/reconciliation/statements/:id/entries/:entryId/match      — clear match
 */

import { Router } from 'express';
import reconciliationRepository from '../repositories/reconciliationRepository.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

const router = Router();

const VALID_STATUSES = ['unmatched', 'auto', 'confirmed', 'manual', 'ignored'];

function parseId(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new ValidationError('Invalid id');
  return n;
}

function requireField(body, field) {
  if (body[field] === undefined || body[field] === null || body[field] === '') {
    throw new ValidationError(`Missing required field: ${field}`);
  }
  return body[field];
}

function validateDateString(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new ValidationError(`${fieldName} must be YYYY-MM-DD`);
  }
}

// ── Statements ─────────────────────────────────────────────────────────────────

router.get('/statements', async (req, res) => {
  const bankAccount = req.query.bank_account ?? null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = await reconciliationRepository.listStatements({ bankAccount, limit, offset });
  res.ok(rows, { total: rows.length });
});

router.post('/statements', async (req, res) => {
  const body = req.body ?? {};
  const bankAccount = String(requireField(body, 'bank_account')).trim().toUpperCase();
  const periodStart = String(requireField(body, 'period_start'));
  const periodEnd = String(requireField(body, 'period_end'));
  validateDateString(periodStart, 'period_start');
  validateDateString(periodEnd, 'period_end');
  if (periodStart > periodEnd) {
    throw new ValidationError('period_start must be on or before period_end');
  }

  const currency = body.currency ? String(body.currency).toUpperCase() : 'EUR';
  if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError('currency must be a 3-letter ISO code');

  const statement = await reconciliationRepository.createStatement({
    bank_account: bankAccount,
    currency,
    period_start: periodStart,
    period_end: periodEnd,
    opening_balance: body.opening_balance != null ? parseFloat(body.opening_balance) : null,
    closing_balance: body.closing_balance != null ? parseFloat(body.closing_balance) : null,
    notes: body.notes ?? null,
  });
  res.status(201).json({ ok: true, data: statement });
});

router.get('/statements/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const statement = await reconciliationRepository.getStatement(id);
  if (!statement) throw new NotFoundError(`Statement ${id} not found`);
  res.ok(statement);
});

router.patch('/statements/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body ?? {};

  if (body.period_start) validateDateString(body.period_start, 'period_start');
  if (body.period_end) validateDateString(body.period_end, 'period_end');
  if (body.currency && !/^[A-Z]{3}$/.test(String(body.currency).toUpperCase())) {
    throw new ValidationError('currency must be a 3-letter ISO code');
  }

  const updated = await reconciliationRepository.updateStatement(id, body);
  if (!updated) throw new NotFoundError(`Statement ${id} not found`);
  res.ok(updated);
});

router.delete('/statements/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const deleted = await reconciliationRepository.deleteStatement(id);
  if (!deleted) throw new NotFoundError(`Statement ${id} not found`);
  res.ok({ deleted: true });
});

// ── Entries ────────────────────────────────────────────────────────────────────

router.get('/statements/:id/entries', async (req, res) => {
  const id = parseId(req.params.id);
  const statement = await reconciliationRepository.getStatement(id);
  if (!statement) throw new NotFoundError(`Statement ${id} not found`);

  const matchStatus = req.query.match_status
    ? String(req.query.match_status)
    : null;
  if (matchStatus && !VALID_STATUSES.includes(matchStatus)) {
    throw new ValidationError(`match_status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const entries = await reconciliationRepository.listEntries(id, { matchStatus });
  res.ok(entries, { total: entries.length });
});

router.post('/statements/:id/entries', async (req, res) => {
  const statementId = parseId(req.params.id);
  const statement = await reconciliationRepository.getStatement(statementId);
  if (!statement) throw new NotFoundError(`Statement ${statementId} not found`);

  const body = req.body ?? {};

  // Accept either a single entry object or an array for bulk import
  const isBulk = Array.isArray(body);
  const rawEntries = isBulk ? body : [body];

  if (rawEntries.length === 0) throw new ValidationError('No entries provided');
  if (rawEntries.length > 500) throw new ValidationError('Maximum 500 entries per request');

  const validated = rawEntries.map((e, idx) => {
    const prefix = isBulk ? `entries[${idx}]` : '';
    const entryDate = String(e.entry_date ?? '');
    if (!entryDate) throw new ValidationError(`${prefix}entry_date is required`);
    validateDateString(entryDate, `${prefix}entry_date`);
    const amount = parseFloat(e.amount);
    if (!Number.isFinite(amount)) throw new ValidationError(`${prefix}amount must be a number`);
    return {
      entry_date: entryDate,
      description: e.description ?? null,
      amount,
      currency: e.currency ? String(e.currency).toUpperCase() : statement.currency,
    };
  });

  if (isBulk || validated.length > 1) {
    const entries = await reconciliationRepository.bulkCreateEntries(statementId, validated);
    res.status(201).json({ ok: true, data: entries, meta: { created: entries.length } });
  } else {
    const entry = await reconciliationRepository.createEntry({ bank_statement_id: statementId, ...validated[0] });
    res.status(201).json({ ok: true, data: entry });
  }
});

router.delete('/statements/:id/entries/:entryId', async (req, res) => {
  parseId(req.params.id); // validate statement id param shape
  const entryId = parseId(req.params.entryId);
  const deleted = await reconciliationRepository.deleteEntry(entryId);
  if (!deleted) throw new NotFoundError(`Entry ${entryId} not found`);
  res.ok({ deleted: true });
});

// ── Matching ───────────────────────────────────────────────────────────────────

router.get('/statements/:id/entries/:entryId/candidates', async (req, res) => {
  const statementId = parseId(req.params.id);
  const entryId = parseId(req.params.entryId);

  const statement = await reconciliationRepository.getStatement(statementId);
  if (!statement) throw new NotFoundError(`Statement ${statementId} not found`);

  const entries = await reconciliationRepository.listEntries(statementId);
  const entry = entries.find((e) => Number(e.id) === entryId);
  if (!entry) throw new NotFoundError(`Entry ${entryId} not found in statement ${statementId}`);

  const candidates = await reconciliationRepository.findMatchCandidates({
    statementBankAccount: statement.bank_account,
    entryDate: entry.entry_date,
    amount: parseFloat(entry.amount),
    description: entry.description,
    limit: 10,
  });

  res.ok(candidates, { entry_id: entryId, total: candidates.length });
});

router.post('/statements/:id/entries/:entryId/match', async (req, res) => {
  const statementId = parseId(req.params.id);
  const entryId = parseId(req.params.entryId);
  const body = req.body ?? {};

  const matchStatus = body.match_status ?? 'manual';
  if (!VALID_STATUSES.includes(matchStatus)) {
    throw new ValidationError(`match_status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  let transactionId = null;
  if (body.transaction_id !== undefined && body.transaction_id !== null) {
    transactionId = parseInt(body.transaction_id, 10);
    if (!Number.isFinite(transactionId) || transactionId <= 0) {
      throw new ValidationError('transaction_id must be a positive integer');
    }
  }

  if (matchStatus !== 'unmatched' && matchStatus !== 'ignored' && transactionId === null) {
    throw new ValidationError('transaction_id required for match_status: confirmed, manual, auto');
  }

  const updated = await reconciliationRepository.updateEntryMatch(entryId, {
    transaction_id: transactionId,
    match_status: matchStatus,
    match_score: body.match_score != null ? parseFloat(body.match_score) : null,
  });
  if (!updated) throw new NotFoundError(`Entry ${entryId} not found`);
  res.ok(updated);
});

router.delete('/statements/:id/entries/:entryId/match', async (req, res) => {
  parseId(req.params.id);
  const entryId = parseId(req.params.entryId);
  const updated = await reconciliationRepository.updateEntryMatch(entryId, {
    transaction_id: null,
    match_status: 'unmatched',
    match_score: null,
  });
  if (!updated) throw new NotFoundError(`Entry ${entryId} not found`);
  res.ok(updated);
});

export default router;
