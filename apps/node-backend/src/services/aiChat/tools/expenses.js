/**
 * Expense-domain AI-chat tools.
 *
 * Thin aggregators over transactionRepository. No new SQL. All numeric
 * results are ground-truth from the DB — never fabricated by the LLM.
 */

import { transactionRepository } from '../../../repositories/transactionRepository.js';
import { memoizeAsync } from '../toolCache.js';
import settings from '../../../config/config.js';
import { toDecimal, roundToCents } from '../../../lib/money.js';
import { toYmd } from '../../../utils/portfolioMath.js';
import { todayAppDateString, firstOfMonthYmd } from '../../../lib/timezone.js';
import {
  requireDate,
  parsePositiveInt,
  parseEnum,
  assertDateOrder,
  ToolValidationError,
} from './_validate.js';

const UNCATEGORISED_LABEL = 'Uncategorised';
const UNKNOWN_RECIPIENT_LABEL = 'Unknown';
const MAX_ROWS = 50_000;

/**
 * Fetch active transactions for a range, routed through the per-turn tool cache
 * (see ../toolCache.js). Several expense tools scan the same [from, to] window in
 * one chat turn; keying on the full param set lets identical fetches share a
 * single DB read (up to 50k rows) instead of rescanning per tool. When `cache`
 * is absent (standalone/unit calls) the read runs directly, unchanged.
 *
 * @param {Map|undefined} cache
 * @param {{ from?: string, to?: string, limit?: number, categoryId?: number|null, recipientId?: number|null }} params
 */
function fetchTransactionsInRange(cache, { from, to, limit = MAX_ROWS, categoryId = null, recipientId = null }) {
  const key = `expenses:txn:${from ?? ''}:${to ?? ''}:${limit}:${categoryId ?? '*'}:${recipientId ?? '*'}`;
  return memoizeAsync(cache, key, () => transactionRepository.getAll({
    startDate: from,
    endDate: to,
    limit,
    offset: 0,
    active: true,
    categoryId,
    recipientId,
  }));
}

function categoryLabel(row) {
  if (row.category_name) return row.category_name;
  return UNCATEGORISED_LABEL;
}

/**
 * Time-bucket key for a YYYY-MM-DD string.
 *
 * `month` (default) → "YYYY-MM"; `quarter` → "YYYY-Qn". Callers pass an
 * already-normalised ymd (typically `toYmd(row.date)`) so the same
 * local-midnight handling applies at every site.
 */
function bucketKey(ymd, groupBy = 'month') {
  const y = ymd.slice(0, 4);
  const m = Number(ymd.slice(5, 7)); // 1-indexed
  if (groupBy === 'quarter') {
    return `${y}-Q${Math.ceil(m / 3)}`;
  }
  return `${y}-${ymd.slice(5, 7)}`;
}

/**
 * Standard transaction-row shape for list/table payloads.
 */
function shapeTxnRow(row) {
  return {
    id: row.id,
    date: toYmd(row.date),
    amount: roundToCents(toDecimal(row.amount)).toNumber(),
    recipient: row.recipient_name || UNKNOWN_RECIPIENT_LABEL,
    category: row.category_name || UNCATEGORISED_LABEL,
    memo: row.memo || '',
  };
}

/**
 * Spend breakdown by category for a date window.
 *
 * "Spend" = sum of negative transaction amounts (outflows). Income rows
 * are ignored.
 */
export const getSpendByCategory = {
  name: 'getSpendByCategory',
  description: 'Total outgoing spend grouped by category within a date range. Use for "biggest category", "what did I spend on groceries", etc.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      to: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      topN: { type: 'integer', description: 'Limit to top N categories. Default 10.', minimum: 1, maximum: 100 },
    },
    required: ['from', 'to'],
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const from = requireDate(args.from, 'from');
    const to = requireDate(args.to, 'to');
    assertDateOrder(from, to);
    const topN = parsePositiveInt(args.topN, 'topN', { min: 1, max: 100, defaultValue: 10 });

    const rows = await fetchTransactionsInRange(cache, { from, to });

    const byCategory = new Map();
    for (const row of rows) {
      const amount = toDecimal(row.amount);
      if (amount.gte(0)) continue; // income row, skip

      const label = categoryLabel(row);
      const entry = byCategory.get(label) || { category: label, total: toDecimal(0), count: 0 };
      entry.total = entry.total.plus(amount.abs());
      entry.count += 1;
      byCategory.set(label, entry);
    }

    const sorted = Array.from(byCategory.values())
      .map((e) => ({ category: e.category, total: roundToCents(e.total).toNumber(), count: e.count }))
      .sort((a, b) => b.total - a.total)
      .slice(0, topN);

    return {
      ok: true,
      data: sorted.slice(0, maxRows),
      meta: {
        from,
        to,
        rowsScanned: rows.length,
        categoryCount: byCategory.size,
        currency: 'EUR',
        renderAs: 'bar',
        xField: 'category',
        yField: 'total',
      },
    };
  },
};

/**
 * Time-bucketed income/spend/net.
 */
export const getMonthlySpend = {
  name: 'getMonthlySpend',
  description: 'Income, spend and net totals bucketed by month or quarter. Use for trend questions like "how did my spending change this year".',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO date, inclusive' },
      to: { type: 'string', description: 'ISO date, inclusive' },
      groupBy: { type: 'string', enum: ['month', 'quarter'], description: 'Bucket size. Default month.' },
    },
    required: ['from', 'to'],
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const from = requireDate(args.from, 'from');
    const to = requireDate(args.to, 'to');
    assertDateOrder(from, to);
    const groupBy = parseEnum(args.groupBy, 'groupBy', ['month', 'quarter'], { defaultValue: 'month' });

    const rows = await fetchTransactionsInRange(cache, { from, to });

    const buckets = new Map();
    for (const row of rows) {
      // toYmd uses local getters for pg's local-midnight Dates — getUTC* here
      // shifted 1st-of-month rows into the previous bucket in UTC+ zones.
      const key = bucketKey(toYmd(row.date), groupBy);
      const amount = toDecimal(row.amount);
      const entry = buckets.get(key) || {
        bucket: key,
        income: toDecimal(0),
        spend: toDecimal(0),
        count: 0,
      };
      if (amount.gte(0)) {
        entry.income = entry.income.plus(amount);
      } else {
        entry.spend = entry.spend.plus(amount.abs());
      }
      entry.count += 1;
      buckets.set(key, entry);
    }

    const series = Array.from(buckets.values())
      .map((b) => ({
        bucket: b.bucket,
        income: roundToCents(b.income).toNumber(),
        spend: roundToCents(b.spend).toNumber(),
        net: roundToCents(b.income.minus(b.spend)).toNumber(),
        count: b.count,
      }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));

    return {
      ok: true,
      data: series.slice(0, maxRows),
      meta: {
        from,
        to,
        groupBy,
        currency: 'EUR',
        renderAs: 'line',
        xField: 'bucket',
        yFields: ['income', 'spend', 'net'],
      },
    };
  },
};

/**
 * Top recipients by total outflow in a date window.
 */
export const getTopRecipients = {
  name: 'getTopRecipients',
  description: 'Recipients ranked by total outgoing spend within a date range. Use for "who do I pay the most", "top merchants", etc.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      to: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      topN: { type: 'integer', description: 'Limit to top N recipients. Default 10.', minimum: 1, maximum: 100 },
    },
    required: ['from', 'to'],
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const from = requireDate(args.from, 'from');
    const to = requireDate(args.to, 'to');
    assertDateOrder(from, to);
    const topN = parsePositiveInt(args.topN, 'topN', { min: 1, max: 100, defaultValue: 10 });

    const rows = await fetchTransactionsInRange(cache, { from, to });

    const byRecipient = new Map();
    for (const row of rows) {
      const amount = toDecimal(row.amount);
      if (amount.gte(0)) continue;

      const label = row.recipient_name || UNKNOWN_RECIPIENT_LABEL;
      const entry = byRecipient.get(label) || { recipient: label, total: toDecimal(0), count: 0 };
      entry.total = entry.total.plus(amount.abs());
      entry.count += 1;
      byRecipient.set(label, entry);
    }

    const sorted = Array.from(byRecipient.values())
      .map((e) => ({ recipient: e.recipient, total: roundToCents(e.total).toNumber(), count: e.count }))
      .sort((a, b) => b.total - a.total)
      .slice(0, topN);

    return {
      ok: true,
      data: sorted.slice(0, maxRows),
      meta: {
        from,
        to,
        rowsScanned: rows.length,
        recipientCount: byRecipient.size,
        currency: 'EUR',
        renderAs: 'bar',
        xField: 'recipient',
        yField: 'total',
      },
    };
  },
};

/**
 * Raw transactions in range, optionally filtered by category/recipient.
 *
 * Returned as a table payload so the UI can render a simple list view.
 */
export const getTransactionsInRange = {
  name: 'getTransactionsInRange',
  description: 'List raw transactions in a date range, optionally filtered by category or recipient. Use when user asks to see individual transactions, not an aggregate.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      to: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      categoryId: { type: 'integer', description: 'Optional category filter.' },
      recipientId: { type: 'integer', description: 'Optional recipient filter.' },
      limit: { type: 'integer', description: 'Max rows to return. Default 100, max 500.', minimum: 1, maximum: 500 },
    },
    required: ['from', 'to'],
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const from = requireDate(args.from, 'from');
    const to = requireDate(args.to, 'to');
    assertDateOrder(from, to);
    const limit = parsePositiveInt(args.limit, 'limit', { min: 1, max: 500, defaultValue: 100 });
    const categoryId = args.categoryId != null
      ? parsePositiveInt(args.categoryId, 'categoryId', { min: 1, max: Number.MAX_SAFE_INTEGER })
      : null;
    const recipientId = args.recipientId != null
      ? parsePositiveInt(args.recipientId, 'recipientId', { min: 1, max: Number.MAX_SAFE_INTEGER })
      : null;

    const rows = await fetchTransactionsInRange(cache, { from, to, limit, categoryId, recipientId });

    const shaped = rows.slice(0, limit).map(shapeTxnRow);

    return {
      ok: true,
      data: shaped.slice(0, maxRows),
      meta: {
        from,
        to,
        categoryId,
        recipientId,
        totalFetched: rows.length,
        truncated: rows.length > limit,
        currency: 'EUR',
        renderAs: 'table',
      },
    };
  },
};

/**
 * Aggregate expense rows by month and category, then keep top N per month.
 *
 * @param {Array<{ date: Date|string, amount: number|string|null, category_name?: string }>} rows
 * @param {{ topN: number }} options
 * @returns {Array<{ month: string, category: string, total: number, count: number }>}
 */
function aggregateByMonthCategory(rows, { topN }) {
  const byMonth = new Map();
  for (const row of rows) {
    const amount = toDecimal(row.amount);
    if (amount.gte(0)) continue;

    // pg returns DATE columns as a local-midnight Date; getUTC* then reported
    // the previous day in a UTC+ zone, landing the 1st of a month in the prior
    // month's bucket. toYmd uses local getters for Dates and slices strings.
    const month = bucketKey(toYmd(row.date));
    const category = categoryLabel(row);

    const monthMap = byMonth.get(month) || new Map();
    const entry = monthMap.get(category) || { total: toDecimal(0), count: 0 };
    entry.total = entry.total.plus(amount.abs());
    entry.count += 1;
    monthMap.set(category, entry);
    byMonth.set(month, monthMap);
  }

  const result = [];
  const sortedMonths = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [month, categoryMap] of sortedMonths) {
    const topCategories = Array.from(categoryMap.entries())
      .map(([category, e]) => ({
        month,
        category,
        total: roundToCents(e.total).toNumber(),
        count: e.count,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, topN);
    result.push(...topCategories);
  }
  return result;
}

/**
 * Top spending categories broken down by month.
 */
export const getMonthlyCategoryBreakdown = {
  name: 'getMonthlyCategoryBreakdown',
  description: 'Top spending categories for each month in a date range. Use for "what did I spend the most on each month", "category breakdown per month".',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      to: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      topN: { type: 'integer', description: 'Top N categories per month. Default 5, max 20.', minimum: 1, maximum: 20 },
    },
    required: ['from', 'to'],
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const from = requireDate(args.from, 'from');
    const to = requireDate(args.to, 'to');
    assertDateOrder(from, to);
    const topN = parsePositiveInt(args.topN, 'topN', { min: 1, max: 20, defaultValue: 5 });

    const rows = await fetchTransactionsInRange(cache, { from, to });
    const result = aggregateByMonthCategory(rows, { topN });

    return {
      ok: true,
      data: result.slice(0, maxRows),
      meta: { from, to, topN, currency: 'EUR', renderAs: 'table' },
    };
  },
};

/**
 * Full-text search across transactions.
 */
export const searchTransactions = {
  name: 'searchTransactions',
  description: 'Search transactions by text matching recipient name, memo, or category. Use when the user mentions a specific name, merchant, or keyword.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search text to match against recipient, memo, or category.' },
      from: { type: 'string', description: 'Optional ISO date filter start (YYYY-MM-DD).' },
      to: { type: 'string', description: 'Optional ISO date filter end (YYYY-MM-DD).' },
      limit: { type: 'integer', description: 'Max results. Default 50, max 200.', minimum: 1, maximum: 200 },
    },
    required: ['query'],
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    if (!args.query || !String(args.query).trim()) {
      throw new ToolValidationError('query is required and must be non-empty', 'query');
    }
    const searchQuery = String(args.query).trim();
    const limit = parsePositiveInt(args.limit, 'limit', { min: 1, max: 200, defaultValue: 50 });
    const from = args.from ? requireDate(args.from, 'from') : undefined;
    const to = args.to ? requireDate(args.to, 'to') : undefined;
    if (from && to) assertDateOrder(from, to);

    const rows = await transactionRepository.getAll({
      search: searchQuery,
      startDate: from,
      endDate: to,
      limit,
      offset: 0,
      active: true,
    });

    const shaped = rows.slice(0, limit).map(shapeTxnRow);

    return {
      ok: true,
      data: shaped.slice(0, maxRows),
      meta: { query: searchQuery, from: from || null, to: to || null, count: shaped.length, currency: 'EUR', renderAs: 'table' },
    };
  },
};

/**
 * Largest individual transactions by absolute amount.
 */
export const getLargestTransactions = {
  name: 'getLargestTransactions',
  description: 'Largest individual transactions in a date range by absolute amount. Use for "biggest purchases", "largest payments", "biggest expenses".',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      to: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      topN: { type: 'integer', description: 'Number of transactions to return. Default 10, max 100.', minimum: 1, maximum: 100 },
      direction: { type: 'string', enum: ['expense', 'income', 'both'], description: 'Filter to expenses (negative), income (positive), or both. Default expense.' },
    },
    required: ['from', 'to'],
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const from = requireDate(args.from, 'from');
    const to = requireDate(args.to, 'to');
    assertDateOrder(from, to);
    const topN = parsePositiveInt(args.topN, 'topN', { min: 1, max: 100, defaultValue: 10 });
    const direction = parseEnum(args.direction, 'direction', ['expense', 'income', 'both'], { defaultValue: 'expense' });

    const rows = await fetchTransactionsInRange(cache, { from, to, limit: MAX_ROWS });

    const withAbs = rows
      .filter((row) => {
        const amount = toDecimal(row.amount);
        if (direction === 'expense') return amount.lt(0);
        if (direction === 'income') return amount.gt(0);
        return true;
      })
      .map((row) => ({
        ...shapeTxnRow(row),
        absAmount: toDecimal(row.amount).abs().toNumber(),
      }))
      .sort((a, b) => b.absAmount - a.absAmount)
      .slice(0, topN);

    const shaped = withAbs.map(({ absAmount: _a, ...rest }) => rest);

    return {
      ok: true,
      data: shaped.slice(0, maxRows),
      meta: { from, to, direction, currency: 'EUR', renderAs: 'table' },
    };
  },
};

/**
 * Monthly spend trend for a single category.
 */
export const getSpendTrendForCategory = {
  name: 'getSpendTrendForCategory',
  description: 'Monthly spending trend for a specific category over the past N months. Use for "how has my groceries spending changed", "trend for a category".',
  parameters: {
    type: 'object',
    properties: {
      categoryId: { type: 'integer', description: 'ID of the category to analyse. Use getCategories first if you only have the name.', minimum: 1 },
      months: { type: 'integer', description: 'Number of past months to cover. Default 12, max 36.', minimum: 1, maximum: 36 },
    },
    required: ['categoryId'],
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const categoryId = parsePositiveInt(args.categoryId, 'categoryId', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const months = parsePositiveInt(args.months, 'months', { min: 1, max: 36, defaultValue: 12 });

    // App-timezone today (ADR-009) — the UTC day excluded today's transactions
    // from trend queries between local midnight and 01:00/02:00 Brussels.
    const to = todayAppDateString();
    const from = firstOfMonthYmd(to, -(months - 1));

    const rows = await fetchTransactionsInRange(cache, { from, to, categoryId });

    const byMonth = new Map();
    for (const row of rows) {
      const amount = toDecimal(row.amount);
      if (amount.gte(0)) continue;

      // toYmd uses local getters for pg's local-midnight Date (getUTC* shifted
      // a UTC+ zone's 1st-of-month into the previous month) and slices strings.
      const key = bucketKey(toYmd(row.date));
      const entry = byMonth.get(key) || { bucket: key, total: toDecimal(0), count: 0 };
      entry.total = entry.total.plus(amount.abs());
      entry.count += 1;
      byMonth.set(key, entry);
    }

    const series = Array.from(byMonth.values())
      .map((b) => ({ bucket: b.bucket, total: roundToCents(b.total).toNumber(), count: b.count }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));

    return {
      ok: true,
      data: series.slice(0, maxRows),
      meta: { categoryId, from, to, months, currency: 'EUR', renderAs: 'line', xField: 'bucket', yField: 'total' },
    };
  },
};

/**
 * Year-over-year spend comparison by category.
 */
export const getYearOverYearComparison = {
  name: 'getYearOverYearComparison',
  description: 'Compare spending by category between two calendar years. Use for "how did 2025 compare to 2024", "year over year spending".',
  parameters: {
    type: 'object',
    properties: {
      year: { type: 'integer', description: 'Primary year (e.g. 2025).', minimum: 2000, maximum: 2100 },
      prevYear: { type: 'integer', description: 'Comparison year. Defaults to year - 1.', minimum: 2000, maximum: 2100 },
    },
    required: ['year'],
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const year = parsePositiveInt(args.year, 'year', { min: 2000, max: 2100 });
    const prevYear = args.prevYear != null
      ? parsePositiveInt(args.prevYear, 'prevYear', { min: 2000, max: 2100 })
      : year - 1;

    const [currRows, prevRows] = await Promise.all([
      fetchTransactionsInRange(cache, { from: `${year}-01-01`, to: `${year}-12-31` }),
      fetchTransactionsInRange(cache, { from: `${prevYear}-01-01`, to: `${prevYear}-12-31` }),
    ]);

    function sumByCategory(txns) {
      const map = new Map();
      for (const row of txns) {
        const amount = toDecimal(row.amount);
        if (amount.gte(0)) continue;
        const label = categoryLabel(row);
        const entry = map.get(label) || { total: toDecimal(0) };
        entry.total = entry.total.plus(amount.abs());
        map.set(label, entry);
      }
      return map;
    }

    const currMap = sumByCategory(currRows);
    const prevMap = sumByCategory(prevRows);
    const zero = toDecimal(0);

    const allCategories = new Set([...currMap.keys(), ...prevMap.keys()]);
    const comparison = Array.from(allCategories)
      .map((category) => {
        const curr = roundToCents(currMap.get(category)?.total ?? zero).toNumber();
        const prev = roundToCents(prevMap.get(category)?.total ?? zero).toNumber();
        const delta = Math.round((curr - prev) * 100) / 100;
        const pctChange = prev > 0 ? Math.round((delta / prev) * 10000) / 100 : null;
        return { category, [String(year)]: curr, [String(prevYear)]: prev, delta, pctChange };
      })
      .sort((a, b) => b[String(year)] - a[String(year)]);

    return {
      ok: true,
      data: comparison.slice(0, maxRows),
      meta: { year, prevYear, currency: 'EUR', renderAs: 'table' },
    };
  },
};

/**
 * Transactions without a category assigned.
 */
export const getUncategorisedTransactions = {
  name: 'getUncategorisedTransactions',
  description: 'List transactions that have no category assigned. Use for "what transactions are uncategorised", "what needs categorising".',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'Max rows. Default 50, max 200.', minimum: 1, maximum: 200 },
    },
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const limit = parsePositiveInt(args.limit, 'limit', { min: 1, max: 200, defaultValue: 50 });

    const rows = await transactionRepository.getUncategorised({ limit, offset: 0 });

    const shaped = rows.map((row) => ({
      id: row.id,
      date: toYmd(row.date),
      amount: roundToCents(toDecimal(row.amount)).toNumber(),
      recipient: row.recipient_name || UNKNOWN_RECIPIENT_LABEL,
      memo: row.memo || '',
    }));

    return {
      ok: true,
      data: shaped.slice(0, maxRows),
      meta: { count: shaped.length, currency: 'EUR', renderAs: 'table' },
    };
  },
};

/**
 * Net cashflow (income − expenses) grouped by month or quarter.
 */
export const getNetCashflow = {
  name: 'getNetCashflow',
  description: 'Net cashflow (income minus expenses) grouped by month or quarter. Use for "am I net positive this quarter", "how much money came in vs went out", "cashflow trend".',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start date ISO 8601 (YYYY-MM-DD).', format: 'date' },
      to: { type: 'string', description: 'End date ISO 8601 (YYYY-MM-DD).', format: 'date' },
      groupBy: {
        type: 'string',
        enum: ['month', 'quarter'],
        description: 'Period granularity. Default month.',
      },
    },
    required: ['from', 'to'],
  },
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const from = requireDate(args.from, 'from');
    const to = requireDate(args.to, 'to');
    assertDateOrder(from, to);
    const groupBy = parseEnum(args.groupBy, 'groupBy', ['month', 'quarter'], { defaultValue: 'month' });

    const rows = await transactionRepository.getAll({
      limit: 100_000,
      offset: 0,
      startDate: from,
      endDate: to,
      active: true,
    });

    const buckets = new Map();

    for (const row of rows) {
      // toYmd uses local getters for pg's local-midnight Dates — getUTC* here
      // shifted 1st-of-month rows into the previous bucket in UTC+ zones.
      const key = bucketKey(toYmd(row.date), groupBy);

      const amount = toDecimal(row.amount ?? 0);
      const bucket = buckets.get(key) || { period: key, income: toDecimal(0), expenses: toDecimal(0) };

      if (amount.gt(0)) bucket.income = bucket.income.plus(amount);
      else bucket.expenses = bucket.expenses.plus(amount.abs());

      buckets.set(key, bucket);
    }

    const shaped = Array.from(buckets.values())
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((b) => ({
        period: b.period,
        income: roundToCents(b.income).toNumber(),
        expenses: roundToCents(b.expenses).toNumber(),
        net: roundToCents(b.income.minus(b.expenses)).toNumber(),
      }));

    const totalIncome = shaped.reduce((s, r) => s + r.income, 0);
    const totalExpenses = shaped.reduce((s, r) => s + r.expenses, 0);

    return {
      ok: true,
      data: shaped.slice(0, maxRows),
      meta: {
        from,
        to,
        groupBy,
        totalIncome: roundToCents(toDecimal(totalIncome)).toNumber(),
        totalExpenses: roundToCents(toDecimal(totalExpenses)).toNumber(),
        totalNet: roundToCents(toDecimal(totalIncome - totalExpenses)).toNumber(),
        currency: 'EUR',
        renderAs: 'bar',
        xField: 'period',
        yField: 'net',
      },
    };
  },
};
