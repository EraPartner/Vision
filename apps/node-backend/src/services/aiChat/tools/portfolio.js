/**
 * Portfolio-domain AI-chat tools.
 *
 * Adapts the canonical portfolio-summary calculation into read-only tool
 * results. Dated tools subtract cumulative snapshots after full-history replay.
 */

import { ASSET_CLASSES } from "@vision/types/assetClasses";
import settings from "../../../config/config.js";
import { toDecimal, roundToCents } from "../../../lib/money.js";
import { loadCanonicalPortfolioSummary } from "./_financialMetrics.js";
import {
  parseEnum,
  parsePositiveInt,
  requireDate,
  assertDateOrder,
} from "./_validate.js";

/** @param {string} ymd */
function previousDay(ymd) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** @param {Array<Record<string, any>>} summaries */
function indexSummaries(summaries) {
  return new Map(summaries.map((summary) => [summary.id, summary]));
}

/** @param {Record<string, any>|undefined} current @param {Record<string, any>|undefined} previous @param {string} field */
function metricDelta(current, previous, field) {
  return toDecimal(current?.[field] ?? 0).minus(previous?.[field] ?? 0);
}

/**
 * Canonical per-investment metric deltas for an inclusive range. Full history
 * is replayed at both boundaries, so partial sales keep their correct basis.
 */
async function loadRangeDeltas(cache, from, to) {
  const [throughTo, beforeFrom] = await Promise.all([
    loadCanonicalPortfolioSummary(cache, {
      throughDate: to,
      activeInvestmentsOnly: false,
    }),
    loadCanonicalPortfolioSummary(cache, {
      throughDate: previousDay(from),
      activeInvestmentsOnly: false,
    }),
  ]);
  const beforeById = indexSummaries(beforeFrom.summaries);
  return {
    currency: throughTo.currency,
    rows: throughTo.summaries.map((current) => ({
      current,
      previous: beforeById.get(current.id),
    })),
  };
}

/**
 * Snapshot of current holdings with market value per investment.
 *
 * Values come from the same reporting-currency summary as the portfolio UI.
 */
export const getPortfolioHoldings = {
  name: "getPortfolioHoldings",
  description:
    'Current portfolio holdings with market value per investment. Use for "what do I own", "biggest position", "portfolio breakdown".',
  parameters: {
    type: "object",
    properties: {
      assetClass: {
        type: "string",
        enum: ASSET_CLASSES,
        description: "Optional filter by asset class.",
      },
    },
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(
    args,
    {
      maxRows = settings.aiChat.maxToolRows,
      cache = undefined,
      scope = {},
    } = {},
  ) {
    const assetClass = parseEnum(args.assetClass, "assetClass", ASSET_CLASSES, {
      defaultValue: null,
    });

    const summary = await loadCanonicalPortfolioSummary(cache);
    const allowedInvestmentIds = new Set(scope.investmentIds || []);
    const holdings = summary.summaries
      .filter(
        (item) =>
          allowedInvestmentIds.size === 0 ||
          allowedInvestmentIds.has(Number(item.id)),
      )
      .filter((item) => !assetClass || item.asset_class === assetClass)
      .filter((item) => toDecimal(item.currentValue).gt(0))
      .map((item) => ({
        id: item.id,
        name: item.name,
        symbol: item.symbol || null,
        assetClass: item.asset_class,
        currency: summary.currency,
        originalCurrency: item.originalCurrency,
        units: item.totalUnits,
        currentPrice: item.currentPrice,
        marketValue: item.currentValue,
      }));

    holdings.sort((a, b) => b.marketValue - a.marketValue);

    return {
      ok: true,
      data: holdings.slice(0, maxRows),
      meta: {
        assetClass: assetClass || "all",
        totalPositions: holdings.length,
        scopedInvestmentIds: [...allowedInvestmentIds],
        currency: summary.currency,
        renderAs: "pie",
        labelField: "name",
        valueField: "marketValue",
      },
    };
  },
};

/**
 * Compatibility-named tool for investment income in a date range. This is
 * explicitly not investment return or price performance.
 */
export const getReturnsForRange = {
  name: "getReturnsForRange",
  description:
    "Per-investment income minus recorded fees and taxes in a date range. This is income, not investment return or price performance.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "ISO date, inclusive (YYYY-MM-DD)" },
      to: { type: "string", description: "ISO date, inclusive (YYYY-MM-DD)" },
      assetClass: {
        type: "string",
        enum: ASSET_CLASSES,
        description: "Optional filter by asset class.",
      },
    },
    required: ["from", "to"],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(
    args,
    {
      maxRows = settings.aiChat.maxToolRows,
      cache = undefined,
      scope = {},
    } = {},
  ) {
    const from = requireDate(args.from, "from");
    const to = requireDate(args.to, "to");
    assertDateOrder(from, to);
    const assetClass = parseEnum(args.assetClass, "assetClass", ASSET_CLASSES, {
      defaultValue: null,
    });

    const range = await loadRangeDeltas(cache, from, to);
    const allowedInvestmentIds = new Set(scope.investmentIds || []);
    const rows = range.rows
      .filter(
        ({ current }) =>
          allowedInvestmentIds.size === 0 ||
          allowedInvestmentIds.has(Number(current.id)),
      )
      .filter(
        ({ current }) => !assetClass || current.asset_class === assetClass,
      )
      .map(({ current, previous }) => {
        const income = metricDelta(current, previous, "totalIncome");
        const fees = metricDelta(current, previous, "totalFees");
        const taxes = metricDelta(current, previous, "totalTaxes");
        const costs = fees.plus(taxes);
        return {
          id: current.id,
          name: current.name,
          symbol: current.symbol || null,
          assetClass: current.asset_class,
          currency: range.currency,
          income: roundToCents(income).toNumber(),
          costs: roundToCents(costs).toNumber(),
          netIncome: roundToCents(income.minus(costs)).toNumber(),
        };
      })
      .filter((row) => row.income !== 0 || row.costs !== 0)
      .sort((a, b) => b.netIncome - a.netIncome);

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        from,
        to,
        assetClass: assetClass || "all",
        positionsWithFlows: rows.length,
        scopedInvestmentIds: [...allowedInvestmentIds],
        metric: "netIncome",
        currency: range.currency,
        renderAs: "bar",
        xField: "name",
        yField: "netIncome",
      },
    };
  },
};

/**
 * Total dividend income in a date range, grouped by investment.
 */
export const getDividendIncome = {
  name: "getDividendIncome",
  description:
    'Dividend income received in a date range, grouped by investment. Use for "how much did I earn in dividends".',
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "ISO date, inclusive (YYYY-MM-DD)" },
      to: { type: "string", description: "ISO date, inclusive (YYYY-MM-DD)" },
    },
    required: ["from", "to"],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(
    args,
    { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {},
  ) {
    const from = requireDate(args.from, "from");
    const to = requireDate(args.to, "to");
    assertDateOrder(from, to);

    const range = await loadRangeDeltas(cache, from, to);
    const rows = range.rows
      .map(({ current, previous }) => ({
        id: current.id,
        name: current.name,
        symbol: current.symbol || null,
        assetClass: current.asset_class,
        currency: range.currency,
        total: roundToCents(
          metricDelta(current, previous, "totalDividends"),
        ).toNumber(),
      }))
      .filter((row) => row.total !== 0)
      .sort((a, b) => b.total - a.total);
    const grandTotal = rows.reduce(
      (sum, row) => sum.plus(row.total),
      toDecimal(0),
    );

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        from,
        to,
        grandTotal: roundToCents(grandTotal).toNumber(),
        payingPositions: rows.length,
        currency: range.currency,
        renderAs: "bar",
        xField: "name",
        yField: "total",
      },
    };
  },
};

/**
 * Asset allocation across all active investments, grouped by asset class.
 */
export const getAssetAllocation = {
  name: "getAssetAllocation",
  description:
    'Current portfolio allocation grouped by asset class (stock, etf, crypto, …). Use for "my asset mix", "how diversified am I".',
  parameters: {
    type: "object",
    properties: {},
  },
  /**
   * @param {Record<string, unknown>} _args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(
    _args,
    { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {},
  ) {
    const summary = await loadCanonicalPortfolioSummary(cache);
    const byClass = new Map();
    for (const item of summary.summaries) {
      const marketValue = toDecimal(item.currentValue);
      if (marketValue.lte(0)) continue;
      const cls = item.asset_class || "unknown";
      const entry = byClass.get(cls) || {
        assetClass: cls,
        marketValue: toDecimal(0),
        positions: 0,
      };
      entry.marketValue = entry.marketValue.plus(marketValue);
      entry.positions += 1;
      byClass.set(cls, entry);
    }

    const totalNum = summary.totals.totalPortfolioValue;
    const rows = Array.from(byClass.values())
      .map((e) => {
        const valueNum = roundToCents(e.marketValue).toNumber();
        return {
          assetClass: e.assetClass,
          marketValue: valueNum,
          positions: e.positions,
          percent:
            totalNum > 0 ? Math.round((valueNum / totalNum) * 10000) / 100 : 0,
        };
      })
      .sort((a, b) => b.marketValue - a.marketValue);

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        grandTotal: totalNum,
        classCount: rows.length,
        currency: summary.currency,
        renderAs: "pie",
        labelField: "assetClass",
        valueField: "marketValue",
      },
    };
  },
};

/**
 * Unrealized gain/loss per investment: cost basis vs current market value.
 */
export const getUnrealizedGains = {
  name: "getUnrealizedGains",
  description:
    'Unrealized gain or loss per investment: cost basis from buy transactions vs current market value. Use for "paper gains", "unrealized profit", "which positions are up or down".',
  parameters: {
    type: "object",
    properties: {
      assetClass: {
        type: "string",
        enum: ASSET_CLASSES,
        description: "Optional filter by asset class.",
      },
    },
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(
    args,
    { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {},
  ) {
    const assetClass = parseEnum(args.assetClass, "assetClass", ASSET_CLASSES, {
      defaultValue: null,
    });

    const summary = await loadCanonicalPortfolioSummary(cache);
    const rows = summary.summaries
      .filter((item) => !assetClass || item.asset_class === assetClass)
      .filter((item) => toDecimal(item.currentValue).gt(0))
      .map((item) => {
        const costBasis = toDecimal(item.currentValue).minus(
          item.unrealizedGain,
        );
        const unrealizedGain = toDecimal(item.unrealizedGain);
        return {
          id: item.id,
          name: item.name,
          symbol: item.symbol || null,
          assetClass: item.asset_class,
          currency: summary.currency,
          originalCurrency: item.originalCurrency,
          units: item.totalUnits,
          costBasis: roundToCents(costBasis).toNumber(),
          marketValue: item.currentValue,
          unrealizedGain: item.unrealizedGain,
          gainPercent: costBasis.gt(0)
            ? Math.round(
                unrealizedGain.dividedBy(costBasis).times(10000).toNumber(),
              ) / 100
            : null,
        };
      });

    rows.sort((a, b) => b.unrealizedGain - a.unrealizedGain);

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        assetClass: assetClass || "all",
        positionsCount: rows.length,
        currency: summary.currency,
        renderAs: "bar",
        xField: "name",
        yField: "unrealizedGain",
      },
    };
  },
};

/**
 * Compatibility-named ranking of net investment income in a date range.
 */
export const getBestWorstPerformers = {
  name: "getBestWorstPerformers",
  description:
    "Highest and lowest net investment income in a date range. This ranks income minus recorded fees and taxes, not price performance or total return.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "ISO date, inclusive (YYYY-MM-DD)" },
      to: { type: "string", description: "ISO date, inclusive (YYYY-MM-DD)" },
      topN: {
        type: "integer",
        description:
          "Number of best and worst to return each. Default 5, max 20.",
        minimum: 1,
        maximum: 20,
      },
      assetClass: {
        type: "string",
        enum: ASSET_CLASSES,
        description: "Optional filter by asset class.",
      },
    },
    required: ["from", "to"],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(
    args,
    { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {},
  ) {
    const from = requireDate(args.from, "from");
    const to = requireDate(args.to, "to");
    assertDateOrder(from, to);
    const topN = parsePositiveInt(args.topN, "topN", {
      min: 1,
      max: 20,
      defaultValue: 5,
    });
    const assetClass = parseEnum(args.assetClass, "assetClass", ASSET_CLASSES, {
      defaultValue: null,
    });

    const range = await loadRangeDeltas(cache, from, to);
    const all = range.rows
      .filter(
        ({ current }) => !assetClass || current.asset_class === assetClass,
      )
      .map(({ current, previous }) => {
        const income = metricDelta(current, previous, "totalIncome");
        const costs = metricDelta(current, previous, "totalFees").plus(
          metricDelta(current, previous, "totalTaxes"),
        );
        return {
          id: current.id,
          name: current.name,
          symbol: current.symbol || null,
          assetClass: current.asset_class,
          currency: range.currency,
          netIncome: roundToCents(income.minus(costs)).toNumber(),
        };
      })
      .filter((row) => row.netIncome !== 0)
      .sort((a, b) => b.netIncome - a.netIncome);

    const best = all.slice(0, topN);
    const bestIds = new Set(best.map((r) => r.id));
    const worst = all
      .slice(-topN)
      .reverse()
      .filter((r) => !bestIds.has(r.id));

    return {
      ok: true,
      data: [
        ...best.map((r) => ({ ...r, rank: "best" })),
        ...worst.map((r) => ({ ...r, rank: "worst" })),
      ].slice(0, maxRows),
      meta: {
        from,
        to,
        topN,
        assetClass: assetClass || "all",
        metric: "netIncome",
        currency: range.currency,
        renderAs: "table",
      },
    };
  },
};
