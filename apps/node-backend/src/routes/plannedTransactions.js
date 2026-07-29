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

/// <reference path="../types/thirdPartyModules.d.ts" />
import { Router } from 'express';
import { z } from 'zod';
import plannedTransactionRepository from '../services/plannedTransactionService.js';
import { resolveRecipientIdByName } from '../services/recipientService.js';
import { resolveCategoryIdByName } from '../services/categoryService.js';
import { validateIdParam, assertYmd, validateId, assertCurrency } from '../middleware/validation.js';
import { formatDateToYmd } from '../lib/dateFormat.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { generateLoanRepaymentSchedule } from '../services/calculations/loanSchedule.js';
import { isValidPattern } from '../lib/calculations/recurrence.js';
import { executePlanned } from '../services/plannedExecutionService.js';
import { getMatchSuggestions } from '../services/plannedMatchService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { toDecimal, toNumber } from '../lib/money.js';
import { parsePagination } from '../lib/pagination.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 * @typedef {import('../types/rows.js').HydratedPlannedTransactionRow} HydratedPlannedTransactionRow
 * @typedef {import('../types/rows.js').PlannedTransactionListRow} PlannedTransactionListRow
 */

/**
 * formatPlannedTransaction's actual input across its call sites: the fully
 * hydrated row from getAll/getById/create/update/updateWithLoanSchedule, OR
 * the un-hydrated `getDueSoon` projection which lacks the join/sub-collection
 * fields — formatPlannedTransaction's own `row.x || fallback` reads below are
 * written defensively for exactly that gap. Modeled as one flat type with the
 * hydration-only fields optional (see the noImplicitAny discriminated-union
 * narrowing quirk noted in middleware/validation.js) rather than a union of
 * the two row typedefs.
 * @typedef {PlannedTransactionListRow & Partial<Pick<HydratedPlannedTransactionRow,
 *   'executions'|'execution_count'|'executed_transaction_id'|'loan_schedule'|'tags'
 * >>} FormattablePlannedTransactionRow
 */

const router = Router();

// Matches the 12-integer-digit ceiling of the money columns (NUMERIC).
const MAX_PLANNED_AMOUNT = 1e12;

/** @param {ExpressRequest} req */
function parseRouteId(req) {
  return parseInt(req.params.id, 10);
}

/** @param {any} fields */
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
/** @param {any} fields */
async function resolveRecipientIdFromName(fields) {
  if (!fields.recipient_name || fields.recipient_id) return fields.recipient_id;
  return resolveRecipientIdByName(fields.recipient_name);
}

/** @param {any} fields */
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

// Normalise/validate currency (ISO-4217) so free text never reaches the
// VARCHAR(3) column + 0046 CHECK as a raw 500 (create uppercases before
// insert, so "euro" became "EURO" → CHECK violation; PATCH forwarded the raw
// value). Mirrors transactions.js: POST maps absent/''/null to undefined (the
// repository defaults to 'EUR'), PATCH rejects a cleared value (the column is
// NOT NULL).
const currencyField = ({ rejectEmpty = false } = {}) => z.unknown().transform((value, ctx) => {
  if (rejectEmpty && (value == null || value === '')) {
    ctx.addIssue({ code: 'custom', message: 'currency cannot be cleared' });
    return z.NEVER;
  }
  try {
    return assertCurrency(value);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: /** @type {Error} */ (err).message });
    return z.NEVER;
  }
}).optional();

// POST body. The is_loan-conditional rules live in superRefine because the
// loan branch in the handler overrides amount/planned_date/recurrence from the
// generated schedule and DELETES truthy recurrence bounds — so only values
// that survive that branch are validated, exactly like the pre-zod checks
// that ran after it.
const createPlannedSchema = z.looseObject({
  tags: tagsField,
  reminder_days_before: reminderDaysBeforeField,
  currency: currencyField(),
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
  currency: currencyField({ rejectEmpty: true }),
  // amount is a NOT NULL money column; POST already rejects zero/non-finite/
  // absurd values but PATCH forwarded the raw value to the SET builder, so
  // `amount: 1e15` overflowed NUMERIC(15,2) → 500, `"Infinity"`/null 500'd at
  // the cast, and 0 stored a meaningless never-auto-matching row. Loan PATCHes
  // that regenerate the schedule overwrite this value afterwards, exactly as
  // before (their installment amount is always derived, never client-sent).
  amount: z.unknown().transform((value, ctx) => {
    const amountNum = Number(value);
    if (value == null || value === '' || !Number.isFinite(amountNum)
        || amountNum === 0 || Math.abs(amountNum) > MAX_PLANNED_AMOUNT) {
      ctx.addIssue({ code: 'custom', message: 'amount must be a non-zero finite number within range' });
      return z.NEVER;
    }
    return amountNum;
  }).optional(),
  recurrence_pattern: z.unknown().transform((value, ctx) => {
    if (value && !isValidPattern(/** @type {string} */ (value))) {
      ctx.addIssue({ code: 'custom', message: `Invalid recurrence_pattern: ${value}` });
      return z.NEVER;
    }
    return value;
  }).optional(),
});

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
/**
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} body
 * @returns {T}
 */
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

/** @param {import('../services/calculations/loanSchedule.js').LoanConfig} input */
function generateLoanScheduleOrThrow(input) {
  try {
    return generateLoanRepaymentSchedule(input);
  } catch (err) {
    throw new ValidationError(`Invalid loan parameters: ${err.message}`);
  }
}

/**
 * Mutates `fields` (the in-flight PATCH payload) in place with loan-derived
 * defaults — `fields` is typed `any` because it is a loose, dynamically-keyed
 * write target (zod-parsed body + resolver-applied ids), not a fixed row shape.
 * @param {any} fields
 * @param {HydratedPlannedTransactionRow} existing
 */
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
    // The schedule was just regenerated, so the installment amount is ALWAYS
    // re-derived from it — a defined client `amount` is ignored, exactly like
    // POST. Keeping a stale client value here desynced `amount` from
    // `loan_regular_payment_amount` whenever principal/rate/term changed (or
    // on convert-to-loan via PATCH).
    fields.amount = -Math.abs(generatedLoanSchedule.regular_payment_amount);
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
 * @param {ReturnType<typeof generateLoanRepaymentSchedule>|undefined} generatedLoanSchedule
 * @param {any} fields Loose PATCH payload — see applyLoanPatchDefaults.
 * @param {HydratedPlannedTransactionRow} existing
 */
function resolveLoanScheduleDirective(generatedLoanSchedule, fields, existing) {
  if (generatedLoanSchedule) return generatedLoanSchedule.schedule;
  if (fields.is_loan === false && existing.is_loan) return []; // loan turned off → clear
  return undefined;
}

router.get('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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

router.post('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const data = parsePlannedBody(createPlannedSchema, req.body);

  if (data.is_loan) {
    // createPlannedSchema is `z.looseObject({})` — raw values are forwarded
    // unchanged (see module doc), so zod's inferred type carries no loan_*
    // fields; LoanConfig's own fields are all `unknown` too (validateLoanConfig
    // coerces), so this cast changes nothing about what's actually validated.
    const generated = generateLoanScheduleOrThrow(/** @type {import('../services/calculations/loanSchedule.js').LoanConfig} */ (data));
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

  // Same loose-schema-vs-typed-repository gap as generateLoanScheduleOrThrow
  // above: the superRefine checks above this block (and, for the non-loan
  // path, the schema's own superRefine at its definition) already enforce
  // planned_date/amount are present by the time this line runs.
  const created = await plannedTransactionRepository.create(
    /** @type {Record<string, any> & { planned_date: string, amount: number|string, is_loan?: boolean, loan_schedule?: Array<Record<string, any>>, tags?: string[]|null }} */ (data),
  );
  res.status(201);
  res.ok(formatPlannedTransaction(created));
});

/**
 * GET /api/planned-transactions/due-soon?days=7
 *
 * Returns active, unexecuted planned transactions whose planned_date falls
 * within the next N days (default 7, max 365).  Used by bill-reminder widgets.
 */
router.get('/due-soon', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const raw = parseInt(req.query.days, 10);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365) : 7;
  const rows = await plannedTransactionRepository.getDueSoon(days);
  const items = rows.map(formatPlannedTransaction);
  // Canonical collection shape `{items, total}` in the data body (never counts
  // in meta); `days` echoes the effective window alongside.
  res.ok({ items, total: items.length, days });
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
router.get('/match-suggestions', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const suggestions = await getMatchSuggestions();
  // Canonical collection shape `{items, total}` in the data body.
  res.ok({ items: suggestions, total: suggestions.length });
});

router.get('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseRouteId(req);
  const pt = await plannedTransactionRepository.getById(id);
  if (!pt) throw new NotFoundError(`Planned transaction ${req.params.id} not found`);
  res.ok(formatPlannedTransaction(pt));
});

router.patch(
  '/:id',
  validateIdParam,
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'planned-transactions-patch' }),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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

    // Same guard as POST, on the merged state: a recurring planned tx needs a
    // pattern calculateNextDate can advance, or /execute leaves it perpetually
    // due. Only enforced when this PATCH touches the recurrence fields, so an
    // unrelated edit to a legacy broken row is not blocked. Loan PATCHes that
    // regenerate the schedule have already defaulted pattern='monthly' above.
    if (fields.is_recurring !== undefined || fields.recurrence_pattern !== undefined) {
      const resultingIsLoan = fields.is_loan !== undefined ? !!fields.is_loan : !!existing.is_loan;
      const resultingIsRecurring = fields.is_recurring !== undefined ? !!fields.is_recurring : !!existing.is_recurring;
      const resultingPattern = fields.recurrence_pattern !== undefined
        ? fields.recurrence_pattern
        : existing.recurrence_pattern;
      if (!resultingIsLoan && resultingIsRecurring && !isValidPattern(/** @type {string} */ (resultingPattern))) {
        throw new ValidationError(`Invalid or missing recurrence_pattern: ${resultingPattern}`);
      }
    }

    // When the loan schedule must change, the field update and the schedule
    // rewrite MUST happen in one transaction — otherwise a crash between them
    // leaves the planned row's loan params disagreeing with the installment rows.
    // patchPlannedSchema's tagsField only validates "is an array" (item type
    // unchecked, matching pre-zod behavior); the repository types `tags` as
    // `string[]` since that's what it writes to the junction table — same
    // "loose zod passthrough vs. typed repository param" gap as transactions.js.
    const typedFields = /** @type {Record<string, any> & { tags?: string[] }} */ (fields);
    const updated = loanScheduleDirective !== undefined
      ? await plannedTransactionRepository.updateWithLoanSchedule(id, typedFields, loanScheduleDirective)
      : await plannedTransactionRepository.update(id, typedFields);

    if (!updated) throw new NotFoundError(`Planned transaction ${id} not found`);

    res.ok(formatPlannedTransaction(updated));
  },
);

router.post('/:id/execute', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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
  // executePlanned's own @returns widens `current` to `object` at the service
  // seam, but it's a pass-through of plannedTransactionRepository.getById()'s
  // HydratedPlannedTransactionRow|null.
  res.ok(formatPlannedTransaction(/** @type {HydratedPlannedTransactionRow|null} */ (current)));
});

router.delete('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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
/** @param {Date|string|null|undefined} v */
const ymd = (v) => (v instanceof Date ? formatDateToYmd(v) : v);

/** @param {FormattablePlannedTransactionRow|null} row */
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
    max_occurrences: row.max_occurrences != null ? parseInt(String(row.max_occurrences), 10) : null,
    reminder_days_before: row.reminder_days_before != null ? parseInt(String(row.reminder_days_before), 10) : null,
    is_executed: row.is_executed,
    last_executed_date: ymd(row.last_executed_date),
    is_loan: row.is_loan || false,
    loan_type: row.loan_type || null,
    loan_principal: row.loan_principal != null ? toNumber(toDecimal(row.loan_principal)) : null,
    loan_annual_interest_rate: row.loan_annual_interest_rate != null ? toNumber(toDecimal(row.loan_annual_interest_rate)) : null,
    loan_term_months: row.loan_term_months != null ? parseInt(String(row.loan_term_months), 10) : null,
    loan_start_date: ymd(row.loan_start_date) || null,
    loan_payment_day: row.loan_payment_day != null ? parseInt(String(row.loan_payment_day), 10) : null,
    loan_regular_payment_amount: row.loan_regular_payment_amount != null ? toNumber(toDecimal(row.loan_regular_payment_amount)) : null,
    loan_first_payment_date: ymd(row.loan_first_payment_date) || null,
    loan_schedule: (row.loan_schedule || []).map((/** @type {import('../types/rows.js').LoanScheduleRow} */ entry) => ({
      installment_number: parseInt(String(entry.installment_number), 10),
      due_date: ymd(entry.due_date),
      payment_amount: toNumber(toDecimal(entry.payment_amount)),
      principal_amount: toNumber(toDecimal(entry.principal_amount)),
      interest_amount: toNumber(toDecimal(entry.interest_amount)),
      remaining_principal: toNumber(toDecimal(entry.remaining_principal)),
    })),
    executed_transaction_id: row.executed_transaction_id || null,
    execution_count: row.execution_count || 0,
    executions: (row.executions || []).map((/** @type {import('../types/rows.js').PlannedExecutionRow} */ e) => ({
      id: e.id,
      executed_transaction_id: e.executed_transaction_id,
      execution_date: ymd(e.execution_date),
      created_at: e.created_at,
    })),
    tags: row.tags ?? [],
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    /** @type {any[]} */
    links: [],
  };
}

export default router;
