/**
 * Planned Transaction routes.
 *
 * Mirrors: apps/backend/api/api_routes_planned_transactions.py
 */

import { Router } from 'express';
import plannedTransactionRepository from '../services/plannedTransactionService.js';
import { resolveRecipientIdByName } from '../services/recipientService.js';
import { resolveCategoryIdByName } from '../services/categoryService.js';
import { validateIdParam, assertYmd, validateId } from '../middleware/validation.js';
import { formatDateToYmd } from '../lib/dateFormat.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { generateLoanRepaymentSchedule } from '../services/calculations/loanSchedule.js';
import { isValidPattern } from '../services/calculations/recurrence.js';
import { executePlanned } from '../services/plannedExecutionService.js';
import { getMatchSuggestions } from '../services/plannedMatchService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { toDecimal, toNumber } from '../lib/money.js';
import { parsePagination } from '../lib/pagination.js';

const router = Router();

function parseRouteId(req) {
  return parseInt(req.params.id, 10);
}

function withoutPatchOnlyReadOnlyFields(fields) {
  const {
    links: _links,
    id: _id,
    executions: _executions,
    execution_count: _executionCount,
    executed_transaction_id: _executedTxId,
    ...rest
  } = fields;
  return rest;
}

// The name→id resolvers return the id to use (or undefined to leave the
// column untouched) instead of mutating the fields object — the caller strips
// the *_name keys immutably and applies the resolved ids itself.
// Resolution delegates to the shared service resolvers, which throw
// ValidationError on an unmatched name — this route used to silently drop the
// field instead (a typo'd category_name saved with no category and no error),
// diverging from the live-transaction route's behavior.
async function resolveRecipientIdFromName(fields) {
  if (!fields.recipient_name || fields.recipient_id) return fields.recipient_id;
  return resolveRecipientIdByName(fields.recipient_name);
}

async function resolveCategoryIdFromName(fields) {
  if (!fields.category_name || fields.category_id) return fields.category_id;
  return resolveCategoryIdByName(fields.category_name);
}

function generateLoanScheduleOrThrow(input) {
  try {
    return generateLoanRepaymentSchedule(input);
  } catch (err) {
    throw new ValidationError(`Invalid loan parameters: ${err.message}`);
  }
}

function applyLoanPatchDefaults(fields, existing) {
  let generatedLoanSchedule;

  const loanFieldsChanged = [
    'loan_type', 'loan_principal', 'loan_annual_interest_rate',
    'loan_term_months', 'loan_start_date', 'loan_payment_day',
  ].some((k) => fields[k] !== undefined);
  const resultingIsLoan = fields.is_loan !== undefined ? !!fields.is_loan : !!existing.is_loan;

  if (resultingIsLoan && (loanFieldsChanged || fields.is_loan === true)) {
    generatedLoanSchedule = generateLoanScheduleOrThrow({
      loan_type: fields.loan_type ?? existing.loan_type,
      loan_principal: fields.loan_principal ?? existing.loan_principal,
      loan_annual_interest_rate: fields.loan_annual_interest_rate ?? existing.loan_annual_interest_rate,
      loan_term_months: fields.loan_term_months ?? existing.loan_term_months,
      loan_start_date: fields.loan_start_date ?? existing.loan_start_date,
      loan_payment_day: fields.loan_payment_day ?? existing.loan_payment_day,
    });

    fields.loan_regular_payment_amount = generatedLoanSchedule.regular_payment_amount;
    fields.loan_first_payment_date = generatedLoanSchedule.first_due_date;
    if (fields.amount === undefined) {
      fields.amount = -Math.abs(generatedLoanSchedule.regular_payment_amount);
    }
    if (fields.planned_date === undefined) {
      fields.planned_date = generatedLoanSchedule.first_due_date;
    }
    if (fields.is_recurring === undefined) {
      fields.is_recurring = true;
    }
    if (fields.recurrence_pattern === undefined) {
      fields.recurrence_pattern = 'monthly';
    }
  } else if (fields.is_loan === false && existing.is_loan) {
    fields.loan_type = null;
    fields.loan_principal = null;
    fields.loan_annual_interest_rate = null;
    fields.loan_term_months = null;
    fields.loan_start_date = null;
    fields.loan_payment_day = null;
    fields.loan_regular_payment_amount = null;
    fields.loan_first_payment_date = null;
  }

  return generatedLoanSchedule;
}


/**
 * Decide whether this PATCH must rewrite the loan schedule, and to what.
 * Returns the installment array to write, [] to clear it, or undefined to leave
 * the existing schedule untouched.
 */
function resolveLoanScheduleDirective(generatedLoanSchedule, fields, existing) {
  if (generatedLoanSchedule) return generatedLoanSchedule.schedule;
  if (fields.is_loan === false && existing.is_loan) return []; // loan turned off → clear
  return undefined;
}

router.get('/', async (req, res) => {
  const {
    start_date, end_date, bank_account,
    category_id, recipient_id,
    is_recurring, is_executed, active = 'true', search,
  } = req.query;

  const { limit, offset } = parsePagination(req.query, { maxLimit: 5000 });
  const opts = {
    limit,
    offset,
    startDate: assertYmd(start_date, 'start_date'),
    endDate: assertYmd(end_date, 'end_date'),
    bankAccount: bank_account || null,
    categoryId: category_id ? parseInt(category_id, 10) : null,
    recipientId: recipient_id ? parseInt(recipient_id, 10) : null,
    isRecurring: is_recurring != null ? is_recurring === 'true' : null,
    isExecuted: is_executed != null ? is_executed === 'true' : null,
    search: search ? String(search).slice(0, 200) : null,
    active: active !== 'false',
  };

  const { items, total } = await plannedTransactionRepository.getAll(opts);
  res.ok({
    items: items.map(formatPlannedTransaction),
    total,
    limit: opts.limit,
    offset: opts.offset,
    links: [],
  });
});

router.post('/', async (req, res) => {
  const data = { ...req.body };
  if (!data.bank_account) throw new ValidationError('Missing required field: bank_account');
  if (data.tags !== undefined && !Array.isArray(data.tags)) throw new ValidationError('tags must be an array of strings');

  if (!data.is_loan && (!data.planned_date || data.amount == null)) {
    throw new ValidationError('Missing required fields: planned_date, amount');
  }

  if (data.is_loan) {
    if (data.loan_term_months && (data.loan_term_months < 1 || data.loan_term_months > 600)) {
      throw new ValidationError('loan_term_months must be between 1 and 600 months');
    }

    const generated = generateLoanScheduleOrThrow(data);
    data.loan_regular_payment_amount = generated.regular_payment_amount;
    data.loan_first_payment_date = generated.first_due_date;
    data.loan_schedule = generated.schedule;
    data.amount = -Math.abs(generated.regular_payment_amount);
    data.planned_date = generated.first_due_date;

    data.is_recurring = true;
    // Loans advance monthly (see plannedTransactionRepository.create). Set it
    // explicitly so the created row + /execute advance are consistent and the
    // recurrence_pattern validation below sees a valid pattern.
    data.recurrence_pattern = 'monthly';
    if (data.frequency) delete data.frequency;
    if (data.custom_interval_days) delete data.custom_interval_days;
    if (data.end_date) delete data.end_date;
    // A loan's horizon is its generated schedule — recurrence bounds don't apply.
    if (data.recurrence_end_date) delete data.recurrence_end_date;
    if (data.max_occurrences) delete data.max_occurrences;
  }

  // Recurrence bounds (nullable): a Y-M-D end date and/or a positive
  // occurrence cap. plannedExecutionService completes the series when either
  // is reached — these used to be silently dropped and recur forever.
  if (data.recurrence_end_date != null) {
    assertYmd(data.recurrence_end_date, 'recurrence_end_date');
  }
  if (data.max_occurrences != null) {
    const n = Number(data.max_occurrences);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError('max_occurrences must be a positive integer');
    data.max_occurrences = n;
  }

  // A recurring planned tx needs a recurrence_pattern calculateNextDate can
  // advance. An absent pattern (is_recurring:true with none) or one it can't
  // advance (e.g. "fortnightly") stores fine but on /execute leaves the row
  // stuck as perpetually-due. Loans set recurrence_pattern='monthly' above, so
  // this never trips loan creation.
  if (data.is_recurring && !isValidPattern(data.recurrence_pattern)) {
    throw new ValidationError(`Invalid or missing recurrence_pattern: ${data.recurrence_pattern}`);
  }

  const created = await plannedTransactionRepository.create(data);
  res.status(201);
  res.ok(formatPlannedTransaction(created));
});

/**
 * GET /api/planned-transactions/due-soon?days=7
 *
 * Returns active, unexecuted planned transactions whose planned_date falls
 * within the next N days (default 7, max 365).  Used by bill-reminder widgets.
 */
router.get('/due-soon', async (req, res) => {
  const raw = parseInt(req.query.days, 10);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365) : 7;
  const rows = await plannedTransactionRepository.getDueSoon(days);
  const items = rows.map(formatPlannedTransaction);
  res.ok(items, { days, total: items.length });
});

/**
 * GET /api/planned-transactions/match-suggestions
 *
 * Active, unexecuted planned payments that have one or more recent unlinked
 * transactions within match tolerance but were not auto-cleared (ambiguous
 * matches, or auto-clear disabled). Each entry carries its candidate
 * transactions for the user to confirm. Registered before /:id so the literal
 * segment is not captured by the id param.
 */
router.get('/match-suggestions', async (req, res) => {
  const suggestions = await getMatchSuggestions();
  res.ok(suggestions, { total: suggestions.length });
});

router.get('/:id', validateIdParam, async (req, res) => {
  const id = parseRouteId(req);
  const pt = await plannedTransactionRepository.getById(id);
  if (!pt) throw new NotFoundError(`Planned transaction ${req.params.id} not found`);
  res.ok(formatPlannedTransaction(pt));
});

router.patch(
  '/:id',
  validateIdParam,
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'planned-transactions-patch' }),
  async (req, res) => {
    const id = parseRouteId(req);
    const existing = await plannedTransactionRepository.getById(id);
    if (!existing) throw new NotFoundError(`Planned transaction ${id} not found`);

    const rawFields = withoutPatchOnlyReadOnlyFields(req.body);
    if (rawFields.tags !== undefined && !Array.isArray(rawFields.tags)) throw new ValidationError('tags must be an array of strings');
    // Independent lookups — run in parallel, then apply immutably.
    const [recipientId, categoryId] = await Promise.all([
      resolveRecipientIdFromName(rawFields),
      resolveCategoryIdFromName(rawFields),
    ]);
    const { recipient_name: _recipientName, category_name: _categoryName, ...fields } = rawFields;
    if (recipientId !== undefined) fields.recipient_id = recipientId;
    if (categoryId !== undefined) fields.category_id = categoryId;

    // Recurrence bounds: same validation as POST; explicit null clears a bound.
    if (fields.recurrence_end_date != null) {
      assertYmd(fields.recurrence_end_date, 'recurrence_end_date');
    }
    if (fields.max_occurrences != null) {
      const n = Number(fields.max_occurrences);
      if (!Number.isInteger(n) || n < 1) throw new ValidationError('max_occurrences must be a positive integer');
      fields.max_occurrences = n;
    }

    const generatedLoanSchedule = applyLoanPatchDefaults(fields, existing);
    const loanScheduleDirective = resolveLoanScheduleDirective(generatedLoanSchedule, fields, existing);

    // Same guard as POST: a recurrence_pattern calculateNextDate can't advance
    // leaves the row perpetually due. applyLoanPatchDefaults already set a valid
    // 'monthly' for loans by here, so this only rejects genuine typos.
    if (fields.recurrence_pattern && !isValidPattern(fields.recurrence_pattern)) {
      throw new ValidationError(`Invalid recurrence_pattern: ${fields.recurrence_pattern}`);
    }

    // When the loan schedule must change, the field update and the schedule
    // rewrite MUST happen in one transaction — otherwise a crash between them
    // leaves the planned row's loan params disagreeing with the installment rows.
    const updated = loanScheduleDirective !== undefined
      ? await plannedTransactionRepository.updateWithLoanSchedule(id, fields, loanScheduleDirective)
      : await plannedTransactionRepository.update(id, fields);

    if (!updated) throw new NotFoundError(`Planned transaction ${id} not found`);

    res.ok(formatPlannedTransaction(updated));
  },
);

router.post('/:id/execute', validateIdParam, async (req, res) => {
  const id = parseRouteId(req);
  const { executed_transaction_id, execution_date } = req.body;

  if (!executed_transaction_id) {
    throw new ValidationError('Missing required field: executed_transaction_id');
  }
  // Validate body inputs up front: malformed values otherwise surface as
  // Postgres cast errors → 500 instead of a 400.
  const idCheck = validateId(executed_transaction_id, 'executed_transaction_id');
  if (!idCheck.valid) throw new ValidationError(idCheck.error);
  assertYmd(execution_date, 'execution_date');

  const { current, duplicate } = await executePlanned({
    id,
    executedTransactionId: executed_transaction_id,
    executionDate: execution_date,
  });

  if (duplicate) res.set('Idempotent-Replay', 'true');
  res.ok(formatPlannedTransaction(current));
});

router.delete('/:id', validateIdParam, async (req, res) => {
  const id = parseRouteId(req);
  const deleted = await plannedTransactionRepository.hardDelete(id);
  if (!deleted) throw new NotFoundError(`Planned transaction ${id} not found`);
  res.ok({ message: `Planned transaction ${id} deleted permanently`, links: [] });
});

// DATE columns arrive from pg as local-midnight Date objects; JSON-serialized
// raw they become an ISO timestamp of the PREVIOUS day east of UTC, which the
// frontend T-splits and writes back on the next save (date-1 per edit).
// Emit calendar-day strings; timestamps (created_at/updated_at) stay ISO.
const ymd = (v) => (v instanceof Date ? formatDateToYmd(v) : v);

function formatPlannedTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    planned_date: ymd(row.planned_date),
    bank_account: row.bank_account,
    recipient_id: row.recipient_id,
    recipient_name: row.recipient_name || null,
    memo: row.memo,
    amount: toNumber(toDecimal(row.amount)),
    currency: row.currency,
    category_id: row.category_id,
    category_name: row.category_name || null,
    comment: row.comment,
    url: row.url || null,
    is_recurring: row.is_recurring,
    recurrence_pattern: row.recurrence_pattern,
    recurrence_end_date: ymd(row.recurrence_end_date),
    max_occurrences: row.max_occurrences != null ? parseInt(row.max_occurrences, 10) : null,
    reminder_days_before: row.reminder_days_before != null ? parseInt(row.reminder_days_before, 10) : null,
    is_executed: row.is_executed,
    last_executed_date: ymd(row.last_executed_date),
    is_loan: row.is_loan || false,
    loan_type: row.loan_type || null,
    loan_principal: row.loan_principal != null ? toNumber(toDecimal(row.loan_principal)) : null,
    loan_annual_interest_rate: row.loan_annual_interest_rate != null ? toNumber(toDecimal(row.loan_annual_interest_rate)) : null,
    loan_term_months: row.loan_term_months != null ? parseInt(row.loan_term_months, 10) : null,
    loan_start_date: ymd(row.loan_start_date) || null,
    loan_payment_day: row.loan_payment_day != null ? parseInt(row.loan_payment_day, 10) : null,
    loan_regular_payment_amount: row.loan_regular_payment_amount != null ? toNumber(toDecimal(row.loan_regular_payment_amount)) : null,
    loan_first_payment_date: ymd(row.loan_first_payment_date) || null,
    loan_schedule: (row.loan_schedule || []).map((entry) => ({
      installment_number: parseInt(entry.installment_number, 10),
      due_date: ymd(entry.due_date),
      payment_amount: toNumber(toDecimal(entry.payment_amount)),
      principal_amount: toNumber(toDecimal(entry.principal_amount)),
      interest_amount: toNumber(toDecimal(entry.interest_amount)),
      remaining_principal: toNumber(toDecimal(entry.remaining_principal)),
    })),
    executed_transaction_id: row.executed_transaction_id || null,
    execution_count: row.execution_count || 0,
    executions: (row.executions || []).map(e => ({
      id: e.id,
      executed_transaction_id: e.executed_transaction_id,
      execution_date: ymd(e.execution_date),
      created_at: e.created_at,
    })),
    tags: row.tags ?? [],
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    links: [],
  };
}

export default router;
