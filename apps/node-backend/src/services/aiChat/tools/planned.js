/**
 * Planned-transaction AI-chat tools.
 *
 * Reuses plannedTransactionRepository. No new SQL.
 */

import { plannedTransactionRepository } from '../../../repositories/plannedTransactionRepository.js';
import { infoRepository } from '../../../repositories/infoRepository.js';
import settings from '../../../config/config.js';
import { toDecimal, roundToCents } from '../../../lib/money.js';
import { expandOccurrences } from '../../../lib/calculations/recurrence.js';
import { toYmd } from '../../../utils/portfolioMath.js';
import { todayAppDateString, addDaysYmd } from '../../../lib/timezone.js';
import {
  parseEnum,
  parsePositiveInt,
} from './_validate.js';

const RECURRENCE_TO_MONTHLY = Object.freeze({
  daily: 30,
  weekly: 30 / 7,
  biweekly: 30 / 14,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
});

/** @param {unknown} value */
function toIsoDate(value) {
  if (!value) return null;
  // pg-read DATE values are local midnight — UTC extraction (toISOString)
  // rendered planned dates a day early east of UTC, and the recurrence
  // expansion base with them. Strings that already carry a Y-M-D prefix are
  // sliced as-is (parsing them via new Date() would be a UTC-midnight parse).
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : toYmd(value);
  }
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toYmd(d);
}

/**
 * Upcoming planned transactions within a horizon (default 30 days).
 */
export const getUpcomingPlanned = {
  name: 'getUpcomingPlanned',
  description: 'List planned / recurring transactions due within the next N days. Use for "what bills are coming up", "upcoming payments".',
  parameters: {
    type: 'object',
    properties: {
      horizonDays: {
        type: 'integer',
        description: 'Days ahead to include. Default 30, max 365.',
        minimum: 1,
        maximum: 365,
      },
    },
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const horizonDays = parsePositiveInt(args.horizonDays, 'horizonDays', { min: 1, max: 365, defaultValue: 30 });

    // App-timezone today (ADR-009) — the UTC window started a day early /
    // ended a day short between local midnight and 01:00/02:00 Brussels.
    const fromDate = todayAppDateString();
    const toDate = addDaysYmd(fromDate, horizonDays);

    const { items } = await plannedTransactionRepository.getAll({
      limit: 1000,
      offset: 0,
      startDate: fromDate,
      endDate: toDate,
      isExecuted: false,
      active: true,
    });

    const rows = items.map((row) => ({
      id: row.id,
      date: toIsoDate(row.planned_date),
      amount: roundToCents(toDecimal(row.amount ?? 0)).toNumber(),
      recipient: row.recipient_name || null,
      category: row.category_name || null,
      memo: row.memo || '',
      isRecurring: Boolean(row.is_recurring),
      recurrencePattern: row.recurrence_pattern || null,
      isLoan: Boolean(row.is_loan),
    }));

    rows.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        horizonDays,
        fromDate,
        toDate,
        count: rows.length,
        currency: 'EUR',
        renderAs: 'table',
      },
    };
  },
};

/**
 * Total recurring spend (subscriptions) normalized to a period.
 *
 * Treats all *active* recurring planned transactions with negative amounts
 * as subscriptions. Amount is normalized via RECURRENCE_TO_MONTHLY then
 * multiplied by 12 for yearly.
 */
export const getSubscriptionTotal = {
  name: 'getSubscriptionTotal',
  description: 'Total recurring outflow (subscriptions) normalized to monthly or yearly. Use for "what are my subscriptions costing me".',
  parameters: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['monthly', 'yearly'],
        description: 'Period to normalize to. Default monthly.',
      },
    },
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const period = parseEnum(args.period, 'period', ['monthly', 'yearly'], { defaultValue: 'monthly' });

    const { items } = await plannedTransactionRepository.getAll({
      limit: 1000,
      offset: 0,
      isRecurring: true,
      active: true,
    });

    const rows = [];
    let total = toDecimal(0);

    for (const row of items) {
      const amount = toDecimal(row.amount ?? 0);
      if (amount.gte(0)) continue;

      const multiplier = RECURRENCE_TO_MONTHLY[/** @type {keyof typeof RECURRENCE_TO_MONTHLY} */ (row.recurrence_pattern)];
      if (multiplier == null) continue;

      let normalized = amount.abs().times(multiplier);
      if (period === 'yearly') normalized = normalized.times(12);

      const normalizedNum = roundToCents(normalized).toNumber();
      total = total.plus(normalized);

      rows.push({
        id: row.id,
        recipient: row.recipient_name || null,
        category: row.category_name || null,
        memo: row.memo || '',
        rawAmount: roundToCents(amount.abs()).toNumber(),
        recurrencePattern: row.recurrence_pattern,
        normalizedAmount: normalizedNum,
      });
    }

    rows.sort((a, b) => b.normalizedAmount - a.normalizedAmount);

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        period,
        total: roundToCents(total).toNumber(),
        count: rows.length,
        currency: 'EUR',
        renderAs: 'bar',
        xField: 'recipient',
        yField: 'normalizedAmount',
      },
    };
  },
};

/**
 * Loan amortization schedule for a single planned transaction.
 */
export const getLoanSchedule = {
  name: 'getLoanSchedule',
  description: 'Amortization schedule (installment by installment) for a loan planned transaction. Use when user asks about a specific loan payoff or remaining balance.',
  parameters: {
    type: 'object',
    properties: {
      plannedId: {
        type: 'integer',
        description: 'ID of the planned transaction (must be a loan).',
        minimum: 1,
      },
    },
    required: ['plannedId'],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const plannedId = parsePositiveInt(args.plannedId, 'plannedId', { min: 1, max: Number.MAX_SAFE_INTEGER });

    const row = await plannedTransactionRepository.getById(plannedId);
    if (!row) {
      return {
        ok: false,
        error: `Planned transaction ${plannedId} not found`,
        data: /** @type {never[]} */ ([]),
        meta: {},
      };
    }
    if (!row.is_loan) {
      return {
        ok: false,
        error: `Planned transaction ${plannedId} is not a loan`,
        data: /** @type {never[]} */ ([]),
        meta: {},
      };
    }

    const schedule = Array.isArray(row.loan_schedule) ? row.loan_schedule : [];
    const shaped = schedule.map((s) => ({
      installment: s.installment_number,
      dueDate: toIsoDate(s.due_date),
      payment: roundToCents(toDecimal(s.payment_amount ?? 0)).toNumber(),
      principal: roundToCents(toDecimal(s.principal_amount ?? 0)).toNumber(),
      interest: roundToCents(toDecimal(s.interest_amount ?? 0)).toNumber(),
      remainingPrincipal: roundToCents(toDecimal(s.remaining_principal ?? 0)).toNumber(),
    }));

    return {
      ok: true,
      data: shaped.slice(0, maxRows),
      meta: {
        plannedId,
        loanType: row.loan_type || null,
        principal: row.loan_principal != null ? roundToCents(toDecimal(row.loan_principal)).toNumber() : null,
        annualInterestRate: row.loan_annual_interest_rate ?? null,
        termMonths: row.loan_term_months ?? null,
        installmentCount: shaped.length,
        currency: 'EUR',
        renderAs: 'table',
      },
    };
  },
};

/**
 * Projected bank balance after accounting for upcoming planned transactions.
 */
export const getProjectedBalance = {
  name: 'getProjectedBalance',
  description: 'Projected bank balance N days from now, accounting for upcoming planned transactions (bills, subscriptions, loans). Use for "how much will I have next month", "projected balance", "cash flow forecast".',
  parameters: {
    type: 'object',
    properties: {
      horizonDays: {
        type: 'integer',
        description: 'Days ahead to project. Default 30, max 365.',
        minimum: 1,
        maximum: 365,
      },
    },
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [_context]
   */
  async run(args, _context = {}) {
    const horizonDays = parsePositiveInt(args.horizonDays, 'horizonDays', { min: 1, max: 365, defaultValue: 30 });

    // App-timezone today (ADR-009) — same edge-hour window fix as above.
    const fromDate = todayAppDateString();
    const endStr = addDaysYmd(fromDate, horizonDays);

    const [bankResult, { items }] = await Promise.all([
      infoRepository.getBankBalances('EUR'),
      plannedTransactionRepository.getAll({
        limit: 1000,
        offset: 0,
        startDate: fromDate,
        endDate: endStr,
        isExecuted: false,
        active: true,
      }),
    ]);

    const currentBalance = typeof bankResult.total_net_position === 'number'
      ? bankResult.total_net_position
      : roundToCents(toDecimal(bankResult.total_net_position ?? 0)).toNumber();

    let plannedNet = toDecimal(0);
    const plannedRows = items.map((row) => {
      const amount = toDecimal(row.amount ?? 0);
      plannedNet = plannedNet.plus(amount);
      return {
        date: toIsoDate(row.planned_date),
        amount: roundToCents(amount).toNumber(),
        recipient: row.recipient_name || null,
        category: row.category_name || null,
        memo: row.memo || '',
        isRecurring: Boolean(row.is_recurring),
      };
    });

    // Expand recurring transactions: the DB row holds only the next stored
    // occurrence, already added once in the map above. Generate the subsequent
    // firings within the horizon via the shared app-tz-correct expander (the
    // first element is the base occurrence, so skip it). This replaces the old
    // UTC-slice loop, which shifted occurrence days east of UTC.
    for (const row of items) {
      if (!row.is_recurring || !row.recurrence_pattern) continue;
      const occurrences = expandOccurrences(row, endStr);
      for (const ymd of occurrences.slice(1)) {
        const amount = toDecimal(row.amount ?? 0);
        plannedNet = plannedNet.plus(amount);
        plannedRows.push({
          date: ymd,
          amount: roundToCents(amount).toNumber(),
          recipient: row.recipient_name || null,
          category: row.category_name || null,
          memo: row.memo || '',
          isRecurring: true,
        });
      }
    }

    plannedRows.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    const projectedBalance = roundToCents(toDecimal(currentBalance).plus(plannedNet)).toNumber();

    return {
      ok: true,
      data: plannedRows,
      meta: {
        currentBalance,
        plannedNetChange: roundToCents(plannedNet).toNumber(),
        projectedBalance,
        horizonDays,
        fromDate,
        toDate: endStr,
        currency: 'EUR',
        renderAs: 'table',
      },
    };
  },
};
