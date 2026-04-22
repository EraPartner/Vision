/**
 * Planned Transaction routes.
 *
 * Mirrors: apps/backend/api/api_routes_planned_transactions.py
 */

import { Router } from 'express';
import { query as dbQuery } from '../database/connection.js';
import plannedTransactionRepository from '../repositories/plannedTransactionRepository.js';
import { validateIdParam } from '../middleware/validation.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { generateLoanRepaymentSchedule } from '../services/loanRepaymentService.js';
import { calculateNextDate } from '../services/recurrenceService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

const router = Router();

function parseRouteId(req) {
  return parseInt(req.params.id, 10);
}

function removePatchOnlyReadOnlyFields(fields) {
  delete fields.links;
  delete fields.id;
  delete fields.executions;
  delete fields.execution_count;
  delete fields.executed_transaction_id;
}

async function resolveRecipientIdFromName(fields) {
  if (!fields.recipient_name || fields.recipient_id) {
    delete fields.recipient_name;
    return;
  }

  const normalized = fields.recipient_name.toUpperCase().trim();
  const recipientResult = await dbQuery(
    `SELECT id FROM recipients WHERE UPPER(name) = $1 LIMIT 1`,
    [normalized]
  );
  if (recipientResult.rows.length > 0) {
    fields.recipient_id = recipientResult.rows[0].id;
  }

  delete fields.recipient_name;
}

async function resolveCategoryIdFromName(fields) {
  if (!fields.category_name || fields.category_id) {
    delete fields.category_name;
    return;
  }

  const normalized = fields.category_name.toUpperCase().trim();
  const parts = normalized.split(':');
  if (parts.length === 2) {
    const catResult = await dbQuery(
      `SELECT id FROM categories WHERE general = $1 AND detail = $2 LIMIT 1`,
      [parts[0].trim(), parts[1].trim()]
    );
    if (catResult.rows.length > 0) {
      fields.category_id = catResult.rows[0].id;
    }
  }

  delete fields.category_name;
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

function getCurrentDateString() {
  return new Date().toISOString().split('T')[0];
}

async function updateLoanScheduleForPatch(id, generatedLoanSchedule, fields, existing) {
  if (generatedLoanSchedule) {
    await plannedTransactionRepository.replaceLoanSchedule(id, generatedLoanSchedule.schedule);
    return true;
  } else if (fields.is_loan === false && existing.is_loan) {
    await plannedTransactionRepository.replaceLoanSchedule(id, []);
    return true;
  }

  return false;
}

router.get('/', async (req, res) => {
  const {
    limit = 50, offset = 0,
    start_date, end_date, bank_account,
    category_id, recipient_id,
    is_recurring, is_executed, active = 'true', search,
  } = req.query;

  const opts = {
    limit: Math.min(parseInt(limit, 10) || 50, 5000),
    offset: parseInt(offset, 10) || 0,
    startDate: start_date || null,
    endDate: end_date || null,
    bankAccount: bank_account || null,
    categoryId: category_id ? parseInt(category_id, 10) : null,
    recipientId: recipient_id ? parseInt(recipient_id, 10) : null,
    isRecurring: is_recurring != null ? is_recurring === 'true' : null,
    isExecuted: is_executed != null ? is_executed === 'true' : null,
    search: search ? String(search).slice(0, 200) : null,
    active: active !== 'false',
  };

  const { items, total } = await plannedTransactionRepository.getAll(opts);
  res.ok(
    items.map(formatPlannedTransaction),
    { pagination: { total, limit: opts.limit, offset: opts.offset } },
  );
});

router.post('/', async (req, res) => {
  const data = { ...req.body };
  if (!data.bank_account) throw new ValidationError('Missing required field: bank_account');

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
    if (data.recurrence_pattern) delete data.recurrence_pattern;
    if (data.frequency) delete data.frequency;
    if (data.custom_interval_days) delete data.custom_interval_days;
    if (data.end_date) delete data.end_date;
    if (data.max_occurrences) delete data.max_occurrences;
  }

  const created = await plannedTransactionRepository.create(data);
  res.status(201);
  res.ok(formatPlannedTransaction(created));
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

    const fields = { ...req.body };
    removePatchOnlyReadOnlyFields(fields);
    await Promise.all([
      resolveRecipientIdFromName(fields),
      resolveCategoryIdFromName(fields),
    ]);

    const generatedLoanSchedule = applyLoanPatchDefaults(fields, existing);

    const updated = await plannedTransactionRepository.update(id, fields);

    const loanScheduleChanged = await updateLoanScheduleForPatch(id, generatedLoanSchedule, fields, existing);

    if (loanScheduleChanged) {
      const withSchedule = await plannedTransactionRepository.getById(id);
      res.ok(formatPlannedTransaction(withSchedule || updated));
      return;
    }

    res.ok(formatPlannedTransaction(updated));
  },
);

router.post('/:id/execute', validateIdParam, async (req, res) => {
  const id = parseRouteId(req);
  const { executed_transaction_id, execution_date } = req.body;

  if (!executed_transaction_id) {
    throw new ValidationError('Missing required field: executed_transaction_id');
  }

  const existing = await plannedTransactionRepository.getById(id);
  if (!existing) throw new NotFoundError(`Planned transaction ${id} not found`);

  const execDate = execution_date || getCurrentDateString();
  const updateFields = {
    is_executed: !existing.is_recurring,
    last_executed_date: execDate,
  };

  if (existing.is_recurring && existing.recurrence_pattern) {
    const baseDate = new Date(existing.planned_date);
    const nextDate = calculateNextDate(baseDate, existing.recurrence_pattern);
    if (nextDate) {
      updateFields.planned_date = nextDate.toISOString().split('T')[0];
      updateFields.is_executed = false;
    }
  }

  const { duplicate } = await plannedTransactionRepository.executeAndAdvance(
    id,
    executed_transaction_id,
    execDate,
    updateFields
  );

  const current = await plannedTransactionRepository.getById(id);
  if (duplicate) res.set('Idempotent-Replay', 'true');
  res.ok(formatPlannedTransaction(current));
});

router.delete('/:id', validateIdParam, async (req, res) => {
  const id = parseRouteId(req);
  const deleted = await plannedTransactionRepository.hardDelete(id);
  if (!deleted) throw new NotFoundError(`Planned transaction ${id} not found`);
  res.ok({ message: `Planned transaction ${id} deleted permanently`, links: [] });
});

function formatPlannedTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    planned_date: row.planned_date,
    bank_account: row.bank_account,
    recipient_id: row.recipient_id,
    recipient_name: row.recipient_name || null,
    memo: row.memo,
    amount: parseFloat(row.amount),
    currency: row.currency,
    category_id: row.category_id,
    category_name: row.category_name || null,
    comment: row.comment,
    url: row.url || null,
    is_recurring: row.is_recurring,
    recurrence_pattern: row.recurrence_pattern,
    is_executed: row.is_executed,
    last_executed_date: row.last_executed_date,
    is_loan: row.is_loan || false,
    loan_type: row.loan_type || null,
    loan_principal: row.loan_principal != null ? parseFloat(row.loan_principal) : null,
    loan_annual_interest_rate: row.loan_annual_interest_rate != null ? parseFloat(row.loan_annual_interest_rate) : null,
    loan_term_months: row.loan_term_months != null ? parseInt(row.loan_term_months, 10) : null,
    loan_start_date: row.loan_start_date || null,
    loan_payment_day: row.loan_payment_day != null ? parseInt(row.loan_payment_day, 10) : null,
    loan_regular_payment_amount: row.loan_regular_payment_amount != null ? parseFloat(row.loan_regular_payment_amount) : null,
    loan_first_payment_date: row.loan_first_payment_date || null,
    loan_schedule: (row.loan_schedule || []).map((entry) => ({
      installment_number: parseInt(entry.installment_number, 10),
      due_date: entry.due_date,
      payment_amount: parseFloat(entry.payment_amount),
      principal_amount: parseFloat(entry.principal_amount),
      interest_amount: parseFloat(entry.interest_amount),
      remaining_principal: parseFloat(entry.remaining_principal),
    })),
    executed_transaction_id: row.executed_transaction_id || null,
    execution_count: row.execution_count || 0,
    executions: (row.executions || []).map(e => ({
      id: e.id,
      executed_transaction_id: e.executed_transaction_id,
      execution_date: e.execution_date,
      created_at: e.created_at,
    })),
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    links: [],
  };
}

export default router;
