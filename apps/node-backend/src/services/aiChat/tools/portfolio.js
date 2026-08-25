/**
 * Portfolio-domain AI-chat tools.
 *
 * Aggregates holdings + returns from investmentRepository +
 * portfolioTransactionRepository. No new SQL paths.
 */

import { ASSET_CLASSES } from '@vision/types/assetClasses';
import settings from '../../../config/config.js';
import { toDecimal, roundToCents } from '../../../lib/money.js';
import { loadActiveInvestments, loadTransactionsForInvestments } from './_portfolioFetch.js';
import {
  parseEnum,
  parsePositiveInt,
  requireDate,
  assertDateOrder,
} from './_validate.js';

/** @typedef {import('../../../types/rows.js').PortfolioTransactionRow} PortfolioTransactionRow */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Start-of-day UTC epoch ms for a YYYY-MM-DD string.
 * @param {string} ymd
 */
function startOfDayMs(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getTime();
}

/**
 * Inclusive end-of-day UTC epoch ms for a YYYY-MM-DD string. A `to` date
 * parsed as plain UTC midnight would otherwise exclude same-day transactions
 * carrying a non-midnight timestamp (tax.js already does it this way).
 * @param {string} ymd
 */
function endOfDayMs(ymd) {
  return startOfDayMs(ymd) + (MS_PER_DAY - 1);
}

// Only these transaction types move the unit count.
const UNIT_CREDIT_TYPES = new Set(['buy', 'gift']);
const UNIT_DEBIT_TYPES = new Set(['sell']);

/**
 * Group transaction rows by their `investment_id`, preserving order.
 * @param {PortfolioTransactionRow[]} txns
 * @returns {Map<number, PortfolioTransactionRow[]>}
 */
function groupTxnsByInvestment(txns) {
  /** @type {Map<number, PortfolioTransactionRow[]>} */
  const byInvestment = new Map();
  for (const t of txns) {
    const list = byInvestment.get(t.investment_id) || [];
    list.push(t);
    byInvestment.set(t.investment_id, list);
  }
  return byInvestment;
}

/**
 * Cash-flow aggregation per investment over a date range.
 *
 * Income = dividend/interest/rent_income/appreciation amounts. Costs =
 * fee/tax amounts plus every row's fees and taxes. Rows outside
 * [from, to] (inclusive, end-of-day) are skipped. Returns a Map of
 * investment_id → `{ income, costs, count }` (Decimals + count).
 * @param {PortfolioTransactionRow[]} txns
 * @param {{ from: string, to: string }} range
 * @returns {Map<number, { income: import('decimal.js').default, costs: import('decimal.js').default, count: number }>}
 */
function aggregateFlows(txns, { from, to }) {
  const fromMs = startOfDayMs(from);
  const toMs = endOfDayMs(to);

  /** @type {Map<number, { income: import('decimal.js').default, costs: import('decimal.js').default, count: number }>} */
  const byInvestment = new Map();
  for (const t of txns) {
    // t.date is typed as a string ('YYYY-MM-DD', see PortfolioTransactionRow),
    // but this guards defensively in case a caller ever hands back a raw Date.
    const rawDate = /** @type {string|Date} */ (t.date);
    const d = rawDate instanceof Date ? rawDate : new Date(rawDate);
    const ms = d.getTime();
    if (ms < fromMs || ms > toMs) continue;

    const entry = byInvestment.get(t.investment_id) || {
      income: toDecimal(0),
      costs: toDecimal(0),
      count: 0,
    };

    const amount = toDecimal(t.amount ?? 0).abs();
    const fees = toDecimal(t.fees ?? 0).abs();
    const taxes = toDecimal(t.taxes ?? 0).abs();

    if (t.type === 'dividend' || t.type === 'interest' || t.type === 'rent_income' || t.type === 'appreciation') {
      entry.income = entry.income.plus(amount);
    } else if (t.type === 'fee' || t.type === 'tax') {
      entry.costs = entry.costs.plus(amount);
    }

    entry.costs = entry.costs.plus(fees).plus(taxes);
    entry.count += 1;
    byInvestment.set(t.investment_id, entry);
  }
  return byInvestment;
}

/** @param {PortfolioTransactionRow[]} txns */
function computeNetUnits(txns) {
  let net = toDecimal(0);
  // Rows arrive date-ordered from the repository query.
  for (const t of txns) {
    const units = toDecimal(t.units ?? 0);
    if (UNIT_CREDIT_TYPES.has(t.type)) net = net.plus(units);
    else if (UNIT_DEBIT_TYPES.has(t.type)) net = net.minus(units);
    // A 'split' row carries `units` = the new TOTAL post-split (the established
    // convention in portfolioMath.calculateCostBasis / snapshotBuilder). Skipping
    // it left the chat reporting pre-split units at post-split prices — roughly
    // half the real value after a 2:1 split.
    else if (t.type === 'split' && units.gt(0) && net.gt(0)) net = units;
  }
  return net;
}

/**
 * Snapshot of current holdings with market value per investment.
 *
 * Market value = net units * current_price, in the investment's
 * native currency. No FX conversion in v1 — meta reports currency
 * per row so the UI can show the mix.
 */
export const getPortfolioHoldings = {
  name: 'getPortfolioHoldings',
  description: 'Current portfolio holdings with market value per investment. Use for "what do I own", "biggest position", "portfolio breakdown".',
  parameters: {
    type: 'object',
    properties: {
      assetClass: {
        type: 'string',
        enum: ASSET_CLASSES,
        description: 'Optional filter by asset class.',
      },
    },
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const assetClass = parseEnum(args.assetClass, 'assetClass', ASSET_CLASSES, { defaultValue: null });

    const investments = await loadActiveInvestments(cache, assetClass);

    const ids = investments.map((inv) => inv.id);
    const txns = await loadTransactionsForInvestments(cache, assetClass, ids);

    const txnsByInvestment = groupTxnsByInvestment(txns);

    const holdings = [];
    for (const inv of investments) {
      const netUnits = computeNetUnits(txnsByInvestment.get(inv.id) || []);
      if (netUnits.lte(0)) continue; // closed or never opened position

      const price = toDecimal(inv.current_price ?? 0);
      const marketValue = netUnits.times(price);

      holdings.push({
        id: inv.id,
        name: inv.name,
        symbol: inv.symbol || null,
        assetClass: inv.asset_class,
        currency: inv.currency || 'EUR',
        units: netUnits.toNumber(),
        currentPrice: roundToCents(price).toNumber(),
        marketValue: roundToCents(marketValue).toNumber(),
      });
    }

    holdings.sort((a, b) => b.marketValue - a.marketValue);

    return {
      ok: true,
      data: holdings.slice(0, maxRows),
      meta: {
        assetClass: assetClass || 'all',
        totalPositions: holdings.length,
        renderAs: 'pie',
        labelField: 'name',
        valueField: 'marketValue',
      },
    };
  },
};

/**
 * Cash-flow-based returns per investment in a date range.
 *
 * "Return" here = sum of positive inflows (dividend, interest, rent_income,
 * appreciation) minus outflows (fees, taxes) from portfolio transactions
 * dated within [from, to]. This is not mark-to-market PnL — we don't have
 * historical price snapshots — but it is exact from the ledger.
 */
export const getReturnsForRange = {
  name: 'getReturnsForRange',
  description: 'Per-investment cash flow returns (income minus costs) from portfolio transactions in a date range. Use for "best performing position", "which investments earned money".',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      to: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      assetClass: { type: 'string', enum: ASSET_CLASSES, description: 'Optional filter by asset class.' },
    },
    required: ['from', 'to'],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const from = requireDate(args.from, 'from');
    const to = requireDate(args.to, 'to');
    assertDateOrder(from, to);
    const assetClass = parseEnum(args.assetClass, 'assetClass', ASSET_CLASSES, { defaultValue: null });

    const investments = await loadActiveInvestments(cache, assetClass);

    const ids = investments.map((inv) => inv.id);
    const txns = await loadTransactionsForInvestments(cache, assetClass, ids);

    const byInvestment = aggregateFlows(txns, { from, to });

    const rows = [];
    for (const inv of investments) {
      const entry = byInvestment.get(inv.id);
      if (!entry || entry.count === 0) continue;

      const net = entry.income.minus(entry.costs);
      rows.push({
        id: inv.id,
        name: inv.name,
        symbol: inv.symbol || null,
        assetClass: inv.asset_class,
        currency: inv.currency || 'EUR',
        income: roundToCents(entry.income).toNumber(),
        costs: roundToCents(entry.costs).toNumber(),
        net: roundToCents(net).toNumber(),
        transactionCount: entry.count,
      });
    }

    rows.sort((a, b) => b.net - a.net);

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        from,
        to,
        assetClass: assetClass || 'all',
        positionsWithFlows: rows.length,
        renderAs: 'bar',
        xField: 'name',
        yField: 'net',
      },
    };
  },
};

/**
 * Total dividend income in a date range, grouped by investment.
 */
export const getDividendIncome = {
  name: 'getDividendIncome',
  description: 'Dividend income received in a date range, grouped by investment. Use for "how much did I earn in dividends".',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      to: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
    },
    required: ['from', 'to'],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const from = requireDate(args.from, 'from');
    const to = requireDate(args.to, 'to');
    assertDateOrder(from, to);

    const investments = await loadActiveInvestments(cache);

    const ids = investments.map((inv) => inv.id);
    const txns = await loadTransactionsForInvestments(cache, null, ids, { type: 'dividend' });

    const fromMs = startOfDayMs(from);
    const toMs = endOfDayMs(to);

    const byInvestment = new Map();
    let grandTotal = toDecimal(0);

    for (const t of txns) {
      // t.date is typed as a string ('YYYY-MM-DD', see PortfolioTransactionRow),
      // but this guards defensively in case a caller ever hands back a raw Date.
      const rawDate = /** @type {string|Date} */ (t.date);
      const d = rawDate instanceof Date ? rawDate : new Date(rawDate);
      const ms = d.getTime();
      if (ms < fromMs || ms > toMs) continue;

      const amount = toDecimal(t.amount ?? 0).abs();
      const entry = byInvestment.get(t.investment_id) || { total: toDecimal(0), count: 0 };
      entry.total = entry.total.plus(amount);
      entry.count += 1;
      byInvestment.set(t.investment_id, entry);
      grandTotal = grandTotal.plus(amount);
    }

    const rows = [];
    for (const inv of investments) {
      const entry = byInvestment.get(inv.id);
      if (!entry || entry.count === 0) continue;
      rows.push({
        id: inv.id,
        name: inv.name,
        symbol: inv.symbol || null,
        assetClass: inv.asset_class,
        currency: inv.currency || 'EUR',
        total: roundToCents(entry.total).toNumber(),
        payments: entry.count,
      });
    }

    rows.sort((a, b) => b.total - a.total);

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        from,
        to,
        grandTotal: roundToCents(grandTotal).toNumber(),
        payingPositions: rows.length,
        currency: 'EUR',
        renderAs: 'bar',
        xField: 'name',
        yField: 'total',
      },
    };
  },
};

/**
 * Asset allocation across all active investments, grouped by asset class.
 */
export const getAssetAllocation = {
  name: 'getAssetAllocation',
  description: 'Current portfolio allocation grouped by asset class (stock, etf, crypto, …). Use for "my asset mix", "how diversified am I".',
  parameters: {
    type: 'object',
    properties: {},
  },
  /**
   * @param {Record<string, unknown>} _args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(_args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const investments = await loadActiveInvestments(cache);

    const ids = investments.map((inv) => inv.id);
    const txns = await loadTransactionsForInvestments(cache, null, ids);

    const txnsByInvestment = groupTxnsByInvestment(txns);

    const byClass = new Map();
    let grandTotal = toDecimal(0);

    for (const inv of investments) {
      const netUnits = computeNetUnits(txnsByInvestment.get(inv.id) || []);
      if (netUnits.lte(0)) continue;

      const price = toDecimal(inv.current_price ?? 0);
      const marketValue = netUnits.times(price);

      const cls = inv.asset_class || 'unknown';
      const entry = byClass.get(cls) || { assetClass: cls, marketValue: toDecimal(0), positions: 0 };
      entry.marketValue = entry.marketValue.plus(marketValue);
      entry.positions += 1;
      byClass.set(cls, entry);
      grandTotal = grandTotal.plus(marketValue);
    }

    const totalNum = roundToCents(grandTotal).toNumber();
    const rows = Array.from(byClass.values())
      .map((e) => {
        const valueNum = roundToCents(e.marketValue).toNumber();
        return {
          assetClass: e.assetClass,
          marketValue: valueNum,
          positions: e.positions,
          percent: totalNum > 0 ? Math.round((valueNum / totalNum) * 10000) / 100 : 0,
        };
      })
      .sort((a, b) => b.marketValue - a.marketValue);

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        grandTotal: totalNum,
        classCount: rows.length,
        renderAs: 'pie',
        labelField: 'assetClass',
        valueField: 'marketValue',
      },
    };
  },
};

/**
 * Unrealized gain/loss per investment: cost basis vs current market value.
 */
export const getUnrealizedGains = {
  name: 'getUnrealizedGains',
  description: 'Unrealized gain or loss per investment: cost basis from buy transactions vs current market value. Use for "paper gains", "unrealized profit", "which positions are up or down".',
  parameters: {
    type: 'object',
    properties: {
      assetClass: { type: 'string', enum: ASSET_CLASSES, description: 'Optional filter by asset class.' },
    },
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const assetClass = parseEnum(args.assetClass, 'assetClass', ASSET_CLASSES, { defaultValue: null });

    const investments = await loadActiveInvestments(cache, assetClass);

    const ids = investments.map((inv) => inv.id);
    const txns = await loadTransactionsForInvestments(cache, assetClass, ids);

    const txnsByInvestment = groupTxnsByInvestment(txns);

    const rows = [];
    for (const inv of investments) {
      const invTxns = txnsByInvestment.get(inv.id) || [];
      const netUnits = computeNetUnits(invTxns);
      if (netUnits.lte(0)) continue;

      let costBasis = toDecimal(0);
      for (const t of invTxns) {
        if (t.type !== 'buy') continue;
        const units = toDecimal(t.units ?? 0);
        const pricePerUnit = toDecimal(t.price_per_unit ?? 0);
        costBasis = costBasis.plus(units.times(pricePerUnit));
      }

      const currentPrice = toDecimal(inv.current_price ?? 0);
      const marketValue = netUnits.times(currentPrice);
      const unrealizedGain = marketValue.minus(costBasis);

      rows.push({
        id: inv.id,
        name: inv.name,
        symbol: inv.symbol || null,
        assetClass: inv.asset_class,
        currency: inv.currency || 'EUR',
        units: netUnits.toNumber(),
        costBasis: roundToCents(costBasis).toNumber(),
        marketValue: roundToCents(marketValue).toNumber(),
        unrealizedGain: roundToCents(unrealizedGain).toNumber(),
        gainPercent: costBasis.gt(0)
          ? Math.round(unrealizedGain.dividedBy(costBasis).times(10000).toNumber()) / 100
          : null,
      });
    }

    rows.sort((a, b) => b.unrealizedGain - a.unrealizedGain);

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        assetClass: assetClass || 'all',
        positionsCount: rows.length,
        renderAs: 'bar',
        xField: 'name',
        yField: 'unrealizedGain',
      },
    };
  },
};

/**
 * Top and bottom performing investments by cash-flow returns in a date range.
 */
export const getBestWorstPerformers = {
  name: 'getBestWorstPerformers',
  description: 'Best and worst performing investments by cash-flow returns (dividends, income minus fees) in a date range. Use for "best performing", "worst performing", "winners and losers".',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      to: { type: 'string', description: 'ISO date, inclusive (YYYY-MM-DD)' },
      topN: { type: 'integer', description: 'Number of best and worst to return each. Default 5, max 20.', minimum: 1, maximum: 20 },
      assetClass: { type: 'string', enum: ASSET_CLASSES, description: 'Optional filter by asset class.' },
    },
    required: ['from', 'to'],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const from = requireDate(args.from, 'from');
    const to = requireDate(args.to, 'to');
    assertDateOrder(from, to);
    const topN = parsePositiveInt(args.topN, 'topN', { min: 1, max: 20, defaultValue: 5 });
    const assetClass = parseEnum(args.assetClass, 'assetClass', ASSET_CLASSES, { defaultValue: null });

    const investments = await loadActiveInvestments(cache, assetClass);

    const ids = investments.map((inv) => inv.id);
    const txns = await loadTransactionsForInvestments(cache, assetClass, ids);

    const byInvestment = aggregateFlows(txns, { from, to });

    const all = [];
    for (const inv of investments) {
      const entry = byInvestment.get(inv.id);
      if (!entry || entry.count === 0) continue;
      const net = entry.income.minus(entry.costs);
      all.push({ id: inv.id, name: inv.name, symbol: inv.symbol || null, assetClass: inv.asset_class, net: roundToCents(net).toNumber() });
    }

    all.sort((a, b) => b.net - a.net);

    const best = all.slice(0, topN);
    const bestIds = new Set(best.map((r) => r.id));
    const worst = all.slice(-topN).reverse().filter((r) => !bestIds.has(r.id));

    return {
      ok: true,
      data: [
        ...best.map((r) => ({ ...r, rank: 'best' })),
        ...worst.map((r) => ({ ...r, rank: 'worst' })),
      ].slice(0, maxRows),
      meta: { from, to, topN, assetClass: assetClass || 'all', renderAs: 'table' },
    };
  },
};
