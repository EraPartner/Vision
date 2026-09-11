/**
 * Tax-domain AI-chat tools.
 *
 * Vision has no dedicated tax schema (no tax table, no `is_tax_deductible`
 * column). These tools compose pragmatic approximations from the canonical
 * ledger and portfolio calculations. Every result carries a `disclaimer` in
 * meta so the LLM is forced to communicate the approximation honestly.
 */

import infoRepository from "../../../repositories/infoRepository.js";
import { UNIT_BASED_ASSET_CLASSES } from "@vision/types/assetClasses";
import settings from "../../../config/config.js";
import {
  toDecimal,
  roundToCents,
  addAll,
  roundMoney,
} from "../../../lib/money.js";
import { DEDUCTION_TYPES } from "../../tax/deductionClassifier.js";
import { computeDeductionCandidates } from "../../tax/deductionCandidatesService.js";
import {
  getAiDisplayCurrency,
  loadCanonicalPortfolioSummary,
} from "./_financialMetrics.js";
import { parsePositiveInt } from "./_validate.js";

const MIN_YEAR = 1970;
const MAX_YEAR = 3000;
const UNIT_BASED_CLASSES = new Set(UNIT_BASED_ASSET_CLASSES);

const DISCLAIMER_APPROX =
  "Approximation only. Vision does not apply Belgian tax rules, withholdings, or exemptions. Figures are derived from ledger data — verify with your accountant.";

/** @param {number} year */
function yearRange(year) {
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  };
}

/** @param {unknown} value */
function parseYear(value) {
  return parsePositiveInt(value, "year", { min: MIN_YEAR, max: MAX_YEAR });
}

/**
 * Gross taxable-income summary: positive ledger inflows plus portfolio income.
 */
export const getTaxableIncomeSummary = {
  name: "getTaxableIncomeSummary",
  description:
    "Approximate gross inflows for a given year, split into positive bank transactions, dividends, interest, and rent. Positive bank transactions can include refunds and other non-taxable inflows. Does NOT compute tax owed.",
  parameters: {
    type: "object",
    properties: {
      year: {
        type: "integer",
        description: `Calendar year (${MIN_YEAR}-${MAX_YEAR}).`,
        minimum: MIN_YEAR,
        maximum: MAX_YEAR,
      },
    },
    required: ["year"],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(
    args,
    { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {},
  ) {
    const year = parseYear(args.year);
    const { from, to } = yearRange(year);

    const currency = await getAiDisplayCurrency(cache);
    const [monthly, throughYear, beforeYear] = await Promise.all([
      infoRepository.getMonthlyFinancialSummary(
        [],
        currency,
        [],
        false,
        from,
        to,
      ),
      loadCanonicalPortfolioSummary(cache, {
        throughDate: to,
        activeInvestmentsOnly: false,
      }),
      loadCanonicalPortfolioSummary(cache, {
        throughDate: `${year - 1}-12-31`,
        activeInvestmentsOnly: false,
      }),
    ]);
    const monthlyRows = Array.isArray(monthly) ? monthly : monthly.months;
    let transactionIncome = toDecimal(0);
    for (const month of monthlyRows) {
      transactionIncome = transactionIncome.plus(month.total_income ?? 0);
    }

    const dividends = toDecimal(throughYear.totals.totalDividends ?? 0).minus(
      beforeYear.totals.totalDividends ?? 0,
    );
    const portfolioIncome = toDecimal(
      throughYear.totals.totalIncome ?? 0,
    ).minus(beforeYear.totals.totalIncome ?? 0);
    const interestAndRent = portfolioIncome.minus(dividends);

    const rows = [
      {
        source: "Positive bank transactions (includes refunds)",
        amount: roundToCents(transactionIncome).toNumber(),
      },
      {
        source: "Dividends",
        amount: roundToCents(dividends).toNumber(),
      },
      {
        source: "Interest and rent income",
        amount: roundToCents(interestAndRent).toNumber(),
      },
    ];

    const grossTotal = addAll(rows.map((r) => r.amount));

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        year,
        from,
        to,
        grossTotal: roundMoney(grossTotal),
        currency,
        disclaimer: DISCLAIMER_APPROX,
        renderAs: "bar",
        xField: "source",
        yField: "amount",
      },
    };
  },
};

/**
 * Realized capital activity from the canonical full-history cost-basis replay.
 */
export const getCapitalGainsForYear = {
  name: "getCapitalGainsForYear",
  description:
    "Gross sale proceeds per investment for a calendar year, with canonical realized gain for unit-based assets. Non-unit assets are returned with realizedGain null because Vision has no canonical realized-gain calculation for them.",
  parameters: {
    type: "object",
    properties: {
      year: {
        type: "integer",
        description: `Calendar year (${MIN_YEAR}-${MAX_YEAR}).`,
        minimum: MIN_YEAR,
        maximum: MAX_YEAR,
      },
    },
    required: ["year"],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(
    args,
    { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {},
  ) {
    const year = parseYear(args.year);
    const { from, to } = yearRange(year);

    const [throughYear, beforeYear] = await Promise.all([
      loadCanonicalPortfolioSummary(cache, {
        throughDate: to,
        activeInvestmentsOnly: false,
      }),
      loadCanonicalPortfolioSummary(cache, {
        throughDate: `${year - 1}-12-31`,
        activeInvestmentsOnly: false,
      }),
    ]);
    const beforeById = new Map(
      beforeYear.summaries.map((item) => [item.id, item]),
    );
    const rows = [];
    const unsupportedAssetClasses = new Set();
    let totalProceeds = toDecimal(0);
    let totalRealizedGain = toDecimal(0);
    for (const current of throughYear.summaries) {
      const previous = beforeById.get(current.id);
      const proceeds = toDecimal(current.totalSellProceeds ?? 0).minus(
        previous?.totalSellProceeds ?? 0,
      );
      const realizedGainSupported = UNIT_BASED_CLASSES.has(current.asset_class);
      const realizedGain = realizedGainSupported
        ? toDecimal(current.realizedGain ?? 0).minus(
            previous?.realizedGain ?? 0,
          )
        : null;
      if (proceeds.isZero() && (!realizedGain || realizedGain.isZero()))
        continue;
      if (!realizedGainSupported) {
        unsupportedAssetClasses.add(current.asset_class || "unknown");
      }
      rows.push({
        investmentId: current.id,
        name: current.name,
        symbol: current.symbol || null,
        assetClass: current.asset_class,
        currency: throughYear.currency,
        proceeds: roundToCents(proceeds).toNumber(),
        realizedGain: realizedGain
          ? roundToCents(realizedGain).toNumber()
          : null,
        realizedGainSupported,
      });
      totalProceeds = totalProceeds.plus(proceeds);
      if (realizedGain)
        totalRealizedGain = totalRealizedGain.plus(realizedGain);
    }

    rows.sort(
      (a, b) =>
        (b.realizedGain ?? Number.NEGATIVE_INFINITY) -
        (a.realizedGain ?? Number.NEGATIVE_INFINITY),
    );

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        year,
        from,
        to,
        totalProceeds: roundToCents(totalProceeds).toNumber(),
        totalRealizedGain: roundToCents(totalRealizedGain).toNumber(),
        positionsSold: rows.length,
        unsupportedAssetClasses: [...unsupportedAssetClasses].sort(),
        currency: throughYear.currency,
        disclaimer: `${DISCLAIMER_APPROX} For unit-based assets, realized gain uses Vision's configured cost-basis method; proceeds remain a separate gross-sale metric. Vision does not yet calculate realized gain for non-unit assets, which are returned with realizedGain null.`,
        renderAs: "bar",
        xField: "name",
        yField: "realizedGain",
      },
    };
  },
};

/**
 * Potentially tax-deductible outflows in a year, classified into specific
 * Belgian deduction types by the explicit category-name classifier
 * (services/tax/deductionClassifier.js). Categories the classifier does not
 * recognize are excluded — precision over recall.
 */
export const getDeductibles = {
  name: "getDeductibles",
  description: `Potentially tax-deductible outflows grouped by category in a given year, each classified into a specific Belgian deduction type (${DEDUCTION_TYPES.join(", ")}) via an explicit category-name classifier. Unrecognized categories are excluded. Use for "what can I deduct".`,
  parameters: {
    type: "object",
    properties: {
      year: {
        type: "integer",
        description: `Calendar year (${MIN_YEAR}-${MAX_YEAR}).`,
        minimum: MIN_YEAR,
        maximum: MAX_YEAR,
      },
    },
    required: ["year"],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows } = {}) {
    const year = parseYear(args.year);

    // Shared classify-and-aggregate step (also serves the REST review card).
    const candidates = await computeDeductionCandidates({ year });

    // Flatten the nested groups back into the tool's flat per-category rows.
    const data = candidates.byDeductionType
      .flatMap((group) =>
        group.categories.map((c) => ({
          category: c.category,
          deductionType: group.deductionType,
          total: c.total,
          count: c.count,
        })),
      )
      .sort((a, b) => b.total - a.total);

    // Per-deduction-type roll-up WITHOUT the nested categories — the tool's
    // existing meta contract (grouping by type, not by raw category).
    const byDeductionType = candidates.byDeductionType.map(
      ({ deductionType, total, categoryCount }) => ({
        deductionType,
        total,
        categoryCount,
      }),
    );

    const grandTotal = addAll(byDeductionType.map((t) => t.total));

    return {
      ok: true,
      data: data.slice(0, maxRows),
      meta: {
        year,
        from: candidates.from,
        to: candidates.to,
        grandTotal: roundMoney(grandTotal),
        categoryCount: data.length,
        deductionTypes: DEDUCTION_TYPES,
        byDeductionType,
        currency: "EUR",
        disclaimer: `${DISCLAIMER_APPROX} Categories are mapped to Belgian deduction types by an explicit name-based classifier (not substring guessing); unrecognized categories are excluded, so genuine deductibles with unusual names may be missed. Every classification is still an approximation the user must confirm — this is not tax advice.`,
        renderAs: "bar",
        xField: "category",
        yField: "total",
      },
    };
  },
};
