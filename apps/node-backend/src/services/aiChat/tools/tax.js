/**
 * Tax-domain AI-chat tools.
 *
 * Vision has no dedicated tax schema (no tax table, no `is_tax_deductible`
 * column). These tools compose pragmatic approximations from
 * transactionRepository + portfolioTransactionRepository. Every result
 * carries a `disclaimer` in meta so the LLM is forced to communicate the
 * approximation honestly.
 */

import { transactionRepository } from '../../../repositories/transactionRepository.js';
import settings from '../../../config/config.js';
import { toDecimal, roundToCents, addAll, roundMoney } from '../../../lib/money.js';
import { toYmd } from '../../calculations/portfolioMath.js';
import { DEDUCTION_TYPES } from '../../tax/deductionClassifier.js';
import { computeDeductionCandidates } from '../../tax/deductionCandidatesService.js';
import { loadActiveInvestments, loadTransactionsForInvestments } from './_portfolioFetch.js';
import { parsePositiveInt } from './_validate.js';

const MIN_YEAR = 1970;
const MAX_YEAR = 3000;

const DISCLAIMER_APPROX =
  'Approximation only. Vision does not apply Belgian tax rules, withholdings, exemptions, or lot-level cost basis. Figures are derived heuristically from ledger data — verify with your accountant.';

/** @param {number} year */
function yearRange(year) {
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  };
}

/** @param {unknown} value */
function parseYear(value) {
  return parsePositiveInt(value, 'year', { min: MIN_YEAR, max: MAX_YEAR });
}

// Year test on the calendar day, not epoch-ms: a pg DATE arrives as a
// server-local-midnight Date whose getTime() east of UTC falls in the
// PREVIOUS UTC year for Jan-1 rows, so comparing against Date.UTC bounds
// misattributed them to the prior tax year. toYmd uses local getters for
// Dates and passes 'YYYY-MM-DD' strings through unchanged.
/**
 * @param {string|Date} dateValue
 * @param {number} year
 */
function inYear(dateValue, year) {
  return toYmd(dateValue).slice(0, 4) === String(year);
}

/**
 * Gross taxable-income summary: transaction inflows + portfolio
 * income streams (dividend, interest, rent_income, appreciation).
 */
export const getTaxableIncomeSummary = {
  name: 'getTaxableIncomeSummary',
  description: 'Approximate gross taxable income for a given year, split by source (transactions, dividends, interest, rent, appreciation). Use for "how much did I earn in 2025". Does NOT compute actual tax owed.',
  parameters: {
    type: 'object',
    properties: {
      year: {
        type: 'integer',
        description: `Calendar year (${MIN_YEAR}-${MAX_YEAR}).`,
        minimum: MIN_YEAR,
        maximum: MAX_YEAR,
      },
    },
    required: ['year'],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const year = parseYear(args.year);
    const { from, to } = yearRange(year);

    const txns = await transactionRepository.getAll({
      startDate: from,
      endDate: to,
      limit: 100_000,
      offset: 0,
      active: true,
    });

    let transactionIncome = toDecimal(0);
    for (const row of txns) {
      const amount = toDecimal(row.amount ?? 0);
      if (amount.gt(0)) transactionIncome = transactionIncome.plus(amount);
    }

    const investments = await loadActiveInvestments(cache);

    const ids = investments.map((inv) => inv.id);
    const portfolioTxns = await loadTransactionsForInvestments(cache, null, ids);

    const buckets = {
      dividend: toDecimal(0),
      interest: toDecimal(0),
      rent_income: toDecimal(0),
      appreciation: toDecimal(0),
    };

    for (const t of portfolioTxns) {
      if (!inYear(t.date, year)) continue;
      if (!(t.type in buckets)) continue;
      const bucketKey = /** @type {keyof typeof buckets} */ (t.type);
      buckets[bucketKey] = buckets[bucketKey].plus(toDecimal(t.amount ?? 0).abs());
    }

    const rows = [
      { source: 'Transaction income (gross)', amount: roundToCents(transactionIncome).toNumber() },
      { source: 'Dividends', amount: roundToCents(buckets.dividend).toNumber() },
      { source: 'Interest', amount: roundToCents(buckets.interest).toNumber() },
      { source: 'Rent income', amount: roundToCents(buckets.rent_income).toNumber() },
      { source: 'Appreciation (realized)', amount: roundToCents(buckets.appreciation).toNumber() },
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
        currency: 'EUR',
        disclaimer: DISCLAIMER_APPROX,
        renderAs: 'bar',
        xField: 'source',
        yField: 'amount',
      },
    };
  },
};

/**
 * Realized capital activity from `sell` portfolio transactions in a year.
 *
 * We do NOT track lots, so this reports gross proceeds and taxes paid,
 * not true realized gains. The LLM must present this as "proceeds", not
 * "capital gains" — the disclaimer enforces that.
 */
export const getCapitalGainsForYear = {
  name: 'getCapitalGainsForYear',
  description: 'Sell transactions from the portfolio in a given year, with gross proceeds and taxes paid per investment. Use for "what did I sell in 2025". Does NOT compute actual capital gains — no lot-level cost basis.',
  parameters: {
    type: 'object',
    properties: {
      year: {
        type: 'integer',
        description: `Calendar year (${MIN_YEAR}-${MAX_YEAR}).`,
        minimum: MIN_YEAR,
        maximum: MAX_YEAR,
      },
    },
    required: ['year'],
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {import('./_validate.js').ToolContext} [context]
   */
  async run(args, { maxRows = settings.aiChat.maxToolRows, cache = undefined } = {}) {
    const year = parseYear(args.year);
    const { from, to } = yearRange(year);

    const investments = await loadActiveInvestments(cache);

    const ids = investments.map((inv) => inv.id);
    const sells = await loadTransactionsForInvestments(cache, null, ids, { type: 'sell' });

    const byInvestment = new Map();
    let totalProceeds = toDecimal(0);
    let totalTaxesPaid = toDecimal(0);

    for (const t of sells) {
      if (!inYear(t.date, year)) continue;
      const proceeds = toDecimal(t.amount ?? 0).abs();
      const taxes = toDecimal(t.taxes ?? 0).abs();
      const fees = toDecimal(t.fees ?? 0).abs();

      const entry = byInvestment.get(t.investment_id) || {
        investmentId: t.investment_id,
        proceeds: toDecimal(0),
        taxes: toDecimal(0),
        fees: toDecimal(0),
        count: 0,
      };
      entry.proceeds = entry.proceeds.plus(proceeds);
      entry.taxes = entry.taxes.plus(taxes);
      entry.fees = entry.fees.plus(fees);
      entry.count += 1;
      byInvestment.set(t.investment_id, entry);

      totalProceeds = totalProceeds.plus(proceeds);
      totalTaxesPaid = totalTaxesPaid.plus(taxes);
    }

    const invById = new Map(investments.map((inv) => [inv.id, inv]));
    const rows = [];
    for (const entry of byInvestment.values()) {
      const inv = invById.get(entry.investmentId);
      rows.push({
        investmentId: entry.investmentId,
        name: inv?.name || `#${entry.investmentId}`,
        symbol: inv?.symbol || null,
        assetClass: inv?.asset_class || null,
        currency: inv?.currency || 'EUR',
        proceeds: roundToCents(entry.proceeds).toNumber(),
        taxesPaid: roundToCents(entry.taxes).toNumber(),
        feesPaid: roundToCents(entry.fees).toNumber(),
        sellCount: entry.count,
      });
    }

    rows.sort((a, b) => b.proceeds - a.proceeds);

    return {
      ok: true,
      data: rows.slice(0, maxRows),
      meta: {
        year,
        from,
        to,
        totalProceeds: roundToCents(totalProceeds).toNumber(),
        totalTaxesPaid: roundToCents(totalTaxesPaid).toNumber(),
        positionsSold: rows.length,
        currency: 'EUR',
        disclaimer: `${DISCLAIMER_APPROX} In particular: "proceeds" is the gross sell amount, not a realized gain, because Vision does not track purchase lots.`,
        renderAs: 'bar',
        xField: 'name',
        yField: 'proceeds',
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
  name: 'getDeductibles',
  description: `Potentially tax-deductible outflows grouped by category in a given year, each classified into a specific Belgian deduction type (${DEDUCTION_TYPES.join(', ')}) via an explicit category-name classifier. Unrecognized categories are excluded. Use for "what can I deduct".`,
  parameters: {
    type: 'object',
    properties: {
      year: {
        type: 'integer',
        description: `Calendar year (${MIN_YEAR}-${MAX_YEAR}).`,
        minimum: MIN_YEAR,
        maximum: MAX_YEAR,
      },
    },
    required: ['year'],
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
      ({ deductionType, total, categoryCount }) => ({ deductionType, total, categoryCount }),
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
        currency: 'EUR',
        disclaimer: `${DISCLAIMER_APPROX} Categories are mapped to Belgian deduction types by an explicit name-based classifier (not substring guessing); unrecognized categories are excluded, so genuine deductibles with unusual names may be missed. Every classification is still an approximation the user must confirm — this is not tax advice.`,
        renderAs: 'bar',
        xField: 'category',
        yField: 'total',
      },
    };
  },
};
