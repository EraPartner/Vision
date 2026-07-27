/**
 * Planned Transaction routes.
 *
 * Leaf field validation (required fields, amount bounds, reminder lead time,
 * recurrence bounds/pattern) is zod (schema → safeParse → ValidationError),
 * the idiom established in settings.js/reports.js. The schemas are LOOSE:
 * unvalidated fields pass through untouched and the repository allow-list
 * decides what is written. The loan-schedule computation is side-effectful and
 * stays imperative, running on the parsed body exactly as before.
 */

import { Router } from 'express';
import { z } from 'zod';
import plannedTransactionRepository from '../services/plannedTransactionService.js';
import { resolveRecipientIdByName } from '../services/recipientService.js';
import { resolveCategoryIdByName } from '../services/categoryService.js';
import { validateIdParam, assertYmd, validateId } from '../middleware/validation.js';
import { formatDateToYmd } from '../lib/dateFormat.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { generateLoanRepaymentSchedule } from '../services/calculations/loanSchedule.js';
import { isValidPattern } from '../lib/calculations/recurrence.js';
import { executePlanned } from '../services/plannedExecutionService.js';
import { getMatchSuggestions } from '../services/plannedMatchService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { toDecimal, toNumber } from '../lib/money.js';
import { parsePagination } from '../lib/pagination.js';

const router = Router();

// Matches the 12-integer-digit ceiling of the money columns (NUMERIC).
const MAX_PLANNED_AMOUNT = 1e12;

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

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

const tagsField = z.array(z.unknown(), { error: 'tags must be an array of strings' }).optional();

// reminder_days_before is a small non-negative integer lead time (bill-reminder
// widgets). Validate it up front so a string/negative/fractional value 400s
// instead of reaching the smallint column as a raw cast/overflow 500; the
// coerced integer replaces the raw input. null passes through (clears).
const reminderDaysBeforeField = z.unknown().transform((value, ctx) => {
  if (value == null) return value;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 365) {
    ctx.addIssue({ code: 'custom', message: 'reminder_days_before must be an integer between 0 and 365' });
    return z.NEVER;
  }
  return n;
}).optional();

// Recurrence bounds (nullable): a Y-M-D end date and/or a positive occurrence
// cap. plannedExecutionService completes the series when either is reached —
// these used to be silently dropped and recur forever. Explicit null clears.
const recurrenceEndDateField = z.unknown().transform((value, ctx) => {
  if (value == null) return value;
  try {
    assertYmd(value, 'recurrence_end_date');
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: /** @type {Error} */ (err).message });
    return z.NEVER;
  }
  return value;
}).optional();

const maxOccurrencesField = z.unknown().transform((value, ctx) => {
  if (value == null) return value;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    ctx.addIssue({ code: 'custom', message: 'max_occurrences must be a positive integer' });
    return z.NEVER;
  }
  return n;
}).optional();

// POST body. The is_loan-conditional rules live in superRefine because the
// loan branch in the handler overrides amount/planned_date/recurrence from the
// generated schedule and DELETES truthy recurrence bounds — so only values
// that survive that branch are validated, exactly like the pre-zod checks
// that ran after it.
const createPlannedSchema = z.looseObject({
  tags: tagsField,
  reminder_days_before: reminderDaysBeforeField,
}).superRefine((data, ctx) => {
  if (!data.bank_account) {
    ctx.addIssue({ code: 'custom', message: 'Missing required field: bank_account' });
  }

  if (!data.is_loan) {
    if (!data.planned_date || data.amount == null) {
      ctx.addIssue({ code: 'custom', message: 'Missing required fields: planned_date, amount' });
    } else {
      // A non-loan planned payment's amount must be a real, non-zero figure —
      // a 0 (meaningless, excluded from auto-match) or a non-finite value used
      // to store end-to-end. Loans set their own amount from the generated
      // schedule, so they skip this. Magnitude is bounded like the money
      // columns (NUMERIC 12-integer-digit ceiling) — an absurd 1e15 otherwise
      // reached the column as an overflow 500.
      const amt = Number(data.amount);
      if (!Number.isFinite(amt) || amt === 0) {
        ctx.addIssue({ code: 'custom', message: 'amount must be a non-zero finite number' });
      } else if (Math.abs(amt) > MAX_PLANNED_AMOUNT) {
        ctx.addIssue({ code: 'custom', message: `amount must be between -${MAX_PLANNED_AMOUNT} and ${MAX_PLANNED_AMOUNT}` });
      }
    }
  } else {
    const termMonths = /** @type {number} */ (data.loan_term_months);
    if (termMonths && (termMonths < 1 || termMonths > 600)) {
      ctx.addIssue({ code: 'custom', message: 'loan_term_months must be between 1 and 600 months' });
    }
  }

  // Only bounds that survive the loan branch's deletion (truthy value on a
  // loan → deleted) are validated. A falsy-but-present value on a loan is NOT
  // deleted and still validates (and always fails), matching the old order.
  if (!(data.is_loan && data.recurrence_end_date) && data.recurrence_end_date != null) {
    try {
      assertYmd(data.recurrence_end_date, 'recurrence_end_date');
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: /** @type {Error} */ (err).message });
    }
  }
  if (!(data.is_loan && data.max_occurrences) && data.max_occurrences != null) {
    const n = Number(data.max_occurrences);
    if (!Number.isInteger(n) || n < 1) {
      ctx.addIssue({ code: 'custom', message: 'max_occurrences must be a positive integer' });
    }
  }

  // A recurring planned tx needs a recurrence_pattern calculateNextDate can
  // advance. An absent pattern (is_recurring:true with none) or one it can't
  // advance (e.g. "fortnightly") stores fine but on /execute leaves the row
  // stuck as perpetually-due. The loan branch sets recurrence_pattern=
  // 'monthly', so this never trips loan creation.
  if (!data.is_loan && data.is_recurring && !isValidPattern(/** @type {string} */ (data.recurrence_pattern))) {
    ctx.addIssue({ code: 'custom', message: `Invalid or missing recurrence_pattern: ${data.recurrence_pattern}` });
  }
}).transform((data) => {
  // Coercions the old code applied in place; loan values are left raw because
  // the loan branch overwrites/deletes them from the generated schedule.
  const out = { ...data };
  if (!out.is_loan && out.amount != null) out.amount = Number(out.amount);
  if (!out.is_loan && out.max_occurrences != null) out.max_occurrences = Number(out.max_occurrences);
  return out;
});

// PATCH body: same leaf rules as POST but unconditional — the PATCH handler
// validated these before applying loan defaults. The pattern guard mirrors the
// old post-defaults check: loan defaults only fill an *absent* pattern (always
// 'monthly'), so an explicit invalid value rejects identically either way.
const patchPlannedSchema = z.looseObject({
  tags: tagsField,
  reminder_days_before: reminderDaysBeforeField,
  recurrence_end_date: recurrenceEndDateField,
  max_occurrences: maxOccurrencesField,
  recurrence_pattern: z.unknown().transform((value, ctx) => {
    if (value && !isValidPattern(/** @type {string} */ (value))) {
      ctx.addIssue({ code: 'custom', message: `Invalid recurrence_pattern: ${value}` });
      return z.NEVER;
    }
    return value;
  }).optional(),
});

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
function parsePlannedBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    throw new ValidationError(msg);
  }
  return result.data;
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
  const data = parsePlannedBody(createPlannedSchema, req.body);

  if (data.is_loan) {
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

    // Validate/coerce the typed leaf fields before any lookups run; loose
    // passthrough keeps the rest untouched for the repository allow-list.
    const rawFields = parsePlannedBody(patchPlannedSchema, withoutPatchOnlyReadOnlyFields(req.body));
    // Independent lookups — run in parallel, then apply immutably.
    const [recipientId, categoryId] = await Promise.all([
      resolveRecipientIdFromName(rawFields),
      resolveCategoryIdFromName(rawFields),
    ]);
    const { recipient_name: _recipientName, category_name: _categoryName, ...fields } = rawFields;
    if (recipientId !== undefined) fields.recipient_id = recipientId;
    if (categoryId !== undefined) fields.category_id = categoryId;

    const generatedLoanSchedule = applyLoanPatchDefaults(fields, existing);
    const loanScheduleDirective = resolveLoanScheduleDirective(generatedLoanSchedule, fields, existing);

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
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
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
