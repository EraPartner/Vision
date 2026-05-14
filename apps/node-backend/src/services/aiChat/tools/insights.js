/**
 * Cross-domain insight tools for the AI chat.
 *
 * Bank balances, spending pace, recipient patterns, watchlist, categories.
 * No new SQL — wraps existing repositories.
 */

import { infoRepository } from '../../../repositories/infoRepository.js';
import { watchlistRepository } from '../../../repositories/watchlistRepository.js';
import { categoryRepository } from '../../../repositories/categoryRepository.js';
import { transactionRepository } from '../../../repositories/transactionRepository.js';
import settings from '../../../config/config.js';
import { toDecimal, roundToCents } from '../../../lib/money.js';
import { parseEnum, parsePositiveInt } from './_validate.js';
import { detectRecurringPatterns } from '../../recurringDetectionService.js';

const ASSET_CLASSES = ['stock', 'etf', 'crypto', 'metals', 'real_estate', 'savings', 'bond'];

/**
 * Current bank account balances + total net position.
 */
export const getBankBalances = {
  name: 'getBankBalances',
  description: 'Current balance per bank account and total net position across all accounts. Use for "how much money do I have", "bank balances", "total cash".',
  parameters: {
    type: 'object',
    properties: {},
  },
  async run(_args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const result = await infoRepository.getBankBalances('EUR');

    const accounts = (result.accounts ?? []).map((a) => ({
      account: a.bank_account,
      balance: typeof a.balance === 'number' ? a.balance : roundToCents(toDecimal(a.balance ?? 0)).toNumber(),
      currency: 'EUR',
      transactionCount: a.transaction_count ?? null,
      firstTransaction: a.first_transaction
        ? (a.first_transaction instanceof Date ? a.first_transaction.toISOString().slice(0, 10) : String(a.first_transaction).slice(0, 10))
        : null,
      lastTransaction: a.last_transaction
        ? (a.last_transaction instanceof Date ? a.last_transaction.toISOString().slice(0, 10) : String(a.last_transaction).slice(0, 10))
        : null,
    }));

    return {
      ok: true,
      data: accounts.slice(0, maxRows),
      meta: {
        totalNetPosition: typeof result.total_net_position === 'number'
          ? result.total_net_position
          : roundToCents(toDecimal(result.total_net_position ?? 0)).toNumber(),
        accountCount: accounts.length,
        currency: 'EUR',
        renderAs: 'table',
      },
    };
  },
};

/**
 * Current-month spending pace compared to 6-month average.
 */
export const getSpendingPace = {
  name: 'getSpendingPace',
  description: 'Current-month spending vs 6-month average with projected end-of-month total. Use for "am I spending more than usual", "spending pace this month", "average monthly or yearly spend".',
  parameters: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['monthly', 'yearly'],
        description: 'Normalize averages to monthly (default) or yearly.',
      },
    },
  },
  async run(args, _context = {}) {
    const period = parseEnum(args.period, 'period', ['monthly', 'yearly'], { defaultValue: 'monthly' });
    const mult = period === 'yearly' ? 12 : 1;

    const result = await infoRepository.getAverageVsCurrentSpending('EUR');
    /** @type {any} */
    const p6 = result.past_6_months ?? {};
    /** @type {any} */
    const cm = result.current_month ?? {};
    /** @type {any} */
    const cmp = result.comparison ?? {};

    return {
      ok: true,
      data: [
        { label: 'Avg daily spend (6-month)', value: p6.avg_daily_spending ?? 0 },
        { label: `Avg ${period} spend (6-month)`, value: (p6.avg_monthly_spending ?? 0) * mult },
        { label: 'Current month total', value: cm.total_spending ?? 0 },
        { label: `Projected ${period} total`, value: (cmp.projected_monthly_total ?? 0) * mult },
      ],
      meta: {
        period,
        daysElapsed: cm.days_elapsed ?? null,
        daysInMonth: cm.days_in_month ?? null,
        pace: cmp.pace ?? null,
        variance: cmp.variance ?? null,
        monthsCounted: p6.months_counted ?? null,
        currency: 'EUR',
        renderAs: 'table',
      },
    };
  },
};

/**
 * Recipient frequency, total spend, and last-seen date.
 */
export const getRecipientInsights = {
  name: 'getRecipientInsights',
  description: 'Recipients by frequency, total spend, average amount, and last payment date. With recipientId: detailed view for one recipient. Without: top recipients ranked by frequency. Use for "most frequent payee", "how much do I pay [name]", "when did I last pay [name]".',
  parameters: {
    type: 'object',
    properties: {
      recipientId: { type: 'integer', description: 'Filter to a single recipient by ID for a per-recipient view.', minimum: 1 },
      limit: { type: 'integer', description: 'Max recipients when listing all (ignored when recipientId set). Default 20, max 100.', minimum: 1, maximum: 100 },
    },
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const limit = parsePositiveInt(args.limit, 'limit', { min: 1, max: 100, defaultValue: 20 });
    const recipientId = args.recipientId != null
      ? parsePositiveInt(args.recipientId, 'recipientId', { min: 1, max: Number.MAX_SAFE_INTEGER })
      : null;

    const SCAN_LIMIT = 50_000;
    const allRows = await transactionRepository.getAll({
      limit: SCAN_LIMIT,
      offset: 0,
      active: true,
      ...(recipientId != null ? { recipientId } : {}),
    });

    const rows = allRows;
    // The scan is capped at SCAN_LIMIT rows with no ordering guarantee that the
    // newest are kept — for a high-volume recipient the aggregates below are a
    // partial view. Surface that so the model can caveat its answer.
    const truncated = rows.length >= SCAN_LIMIT;

    const byRecipient = new Map();
    for (const row of rows) {
      const name = row.recipient_name || null;
      if (!name) continue;

      const amount = toDecimal(row.amount);
      const entry = byRecipient.get(name) || {
        recipient: name,
        recipientId: row.recipient_id || null,
        count: 0,
        totalSpend: toDecimal(0),
        totalIncome: toDecimal(0),
        lastDate: null,
      };

      entry.count += 1;
      if (amount.lt(0)) entry.totalSpend = entry.totalSpend.plus(amount.abs());
      else entry.totalIncome = entry.totalIncome.plus(amount);

      const dateStr = row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date).slice(0, 10);
      if (!entry.lastDate || dateStr > entry.lastDate) entry.lastDate = dateStr;

      byRecipient.set(name, entry);
    }

    const resultLimit = recipientId != null ? byRecipient.size : limit;
    const shaped = Array.from(byRecipient.values())
      .map((e) => ({
        recipient: e.recipient,
        recipientId: e.recipientId,
        count: e.count,
        totalSpend: roundToCents(e.totalSpend).toNumber(),
        totalIncome: roundToCents(e.totalIncome).toNumber(),
        avgSpend: e.count > 0 ? roundToCents(e.totalSpend.dividedBy(e.count)).toNumber() : 0,
        lastDate: e.lastDate,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, resultLimit);

    return {
      ok: true,
      data: shaped.slice(0, maxRows),
      meta: { recipientCount: byRecipient.size, currency: 'EUR', renderAs: 'table', truncated },
    };
  },
};

/**
 * Investments on the watchlist.
 */
export const getWatchlist = {
  name: 'getWatchlist',
  description: 'Investments on the watchlist (tracked but not necessarily owned). Use for "what am I watching", "watchlist".',
  parameters: {
    type: 'object',
    properties: {
      assetClass: { type: 'string', enum: ASSET_CLASSES, description: 'Optional filter by asset class.' },
    },
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const assetClass = parseEnum(args.assetClass, 'assetClass', ASSET_CLASSES, { defaultValue: null });

    const { rows, total } = await watchlistRepository.getAllWithCount({
      limit: 500,
      offset: 0,
      assetClass,
    });

    const shaped = rows.map((item) => ({
      id: item.id,
      name: item.name,
      symbol: item.symbol || null,
      assetClass: item.asset_class,
      currentPrice: item.current_price != null
        ? roundToCents(toDecimal(item.current_price)).toNumber()
        : null,
      currency: item.currency || 'EUR',
      notes: item.notes || null,
    }));

    return {
      ok: true,
      data: shaped.slice(0, maxRows),
      meta: { total, assetClass: assetClass || 'all', renderAs: 'table' },
    };
  },
};

/**
 * All categories with IDs — lets the LLM resolve a name to an ID.
 */
export const getCategories = {
  name: 'getCategories',
  description: 'List all transaction categories with their IDs, general group, and detail name. Call this first when the user mentions a category by name and you need its ID for another tool like getSpendTrendForCategory.',
  parameters: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Optional text filter on category name.' },
    },
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const rows = await categoryRepository.getAll({
      limit: 500,
      offset: 0,
      active: true,
      search: args.search ? String(args.search).trim() : undefined,
    });

    const shaped = rows.map((row) => ({
      id: row.id,
      general: row.general || null,
      detail: row.detail || null,
      name: row.detail || row.general || `Category ${row.id}`,
    }));

    return {
      ok: true,
      data: shaped.slice(0, maxRows),
      meta: { count: shaped.length, renderAs: 'table' },
    };
  },
};

/**
 * Auto-detected recurring transactions from transaction history analysis.
 * Different from planned transactions (user-created); these are inferred patterns.
 */
export const getRecurringDetected = {
  name: 'getRecurringDetected',
  description: 'Auto-detected recurring payments inferred from transaction history (subscriptions, bills). Different from planned transactions — these are discovered patterns. Use for "what subscriptions am I missing", "what recurring payments haven\'t I tracked", "auto-detect my subscriptions".',
  parameters: {
    type: 'object',
    properties: {
      minOccurrences: {
        type: 'integer',
        description: 'Minimum times a pattern must repeat to be included. Default 3, max 20.',
        minimum: 2,
        maximum: 20,
      },
    },
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const minOccurrences = parsePositiveInt(args.minOccurrences, 'minOccurrences', { min: 2, max: 20, defaultValue: 3 });

    const { patterns } = await detectRecurringPatterns();
    const filtered = patterns.filter((p) => p.occurrences >= minOccurrences);

    const shaped = filtered.map((p) => ({
      recipient: p.recipientName,
      pattern: p.detectedPattern,
      intervalDays: p.intervalDays,
      consistency: p.consistency,
      occurrences: p.occurrences,
      averageAmount: p.averageAmount,
      latestAmount: p.latestAmount,
      currency: p.currency,
      category: p.categoryName || null,
      predictedNext: p.predictedNext,
      lastSeen: p.lastSeen,
      confidence: p.confidence,
      isAlreadyPlanned: p.isAlreadyPlanned,
    }));

    return {
      ok: true,
      data: shaped.slice(0, maxRows),
      meta: {
        minOccurrences,
        count: shaped.length,
        currency: 'EUR',
        renderAs: 'table',
      },
    };
  },
};
