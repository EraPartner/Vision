/**
 * Sankey flow diagram aggregation.
 *
 * Builds a directed graph of money flow from income sources to spending
 * categories for a given year. The frontend (d3-sankey) computes the
 * visual layout client-side — this service returns only the raw graph.
 *
 * Graph shape:
 *   nodes: [{ id, label, value }]
 *   links: [{ source, target, value }]
 *
 * Flow model:
 *   Income + funding gap → spending hub → each spending category
 *   Remaining income (income − total spending) → savings / unspent
 *
 * @param {object} opts
 * @param {string} [opts.targetCurrency='EUR']
 * @param {number} [opts.year]  Defaults to current calendar year.
 */

import { getSankeyAggregates } from "../../../repositories/infoRepositorySankey.js";
import { convertRowsToEur } from "../../currency/currencyConversionService.js";
import { buildEnvelope } from "./_envelope.js";
import { assertNoNaN } from "./_invariants.js";
import { roundMoney } from "../../../lib/money.js";
import { toAppTz } from "../../../lib/timezone.js";

const INCOME_NODE_ID = "__income__";
const SPENDING_NODE_ID = "__spending__";
const FUNDING_GAP_NODE_ID = "__funding_gap__";
const SAVINGS_NODE_ID = "__savings__";
const UNCATEGORISED_NODE_ID = "__uncategorised__";
const OTHER_NODE_ID = "__other__";
const TOP_N = 12;

/**
 * Shape of a row from the SQL aggregate above: `amount` is a SUM(ABS(...))
 * NUMERIC, so pg returns it as a string.
 * @typedef {{ category_id: number|null, category_name: string|null, currency: string, is_income: boolean, amount: string }} SankeyRow
 */

/**
 * @param {{ targetCurrency?: string, year?: number, excludedCategoryIds?: number[], excludedRecipientIds?: number[] }} [opts]
 */
export async function computeSankeyFlow({
  targetCurrency = "EUR",
  year,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
} = {}) {
  const targetYear = year ?? toAppTz(new Date()).year;
  const yearStart = `${targetYear}-01-01`;
  const yearEnd = `${targetYear}-12-31`;

  // Aggregate in SQL: this endpoint converts with latest rates only (one rate
  // per currency below), so SUM(ABS(amount)) per (category, currency, is_income)
  // is identical to summing the per-row converted amounts — but returns ~tens of
  // rows instead of a whole year of transactions. Each group is sign-homogeneous
  // (grouped on amount > 0), so ABS distributes over the sum.
  const groupedRows = await getSankeyAggregates({
    yearStart,
    yearEnd,
    excludedCategoryIds,
    excludedRecipientIds,
  });

  if (!groupedRows.length) {
    return buildEnvelope(
      { nodes: [], links: [], year: targetYear },
      { source: "live" },
    );
  }

  // Convert to target currency
  const rows = await convertRowsToEur(
    groupedRows.map((/** @type {SankeyRow} */ r) => ({
      ...r,
      amount: Math.abs(parseFloat(r.amount)),
    })),
    targetCurrency,
  );

  // Accumulate totals
  let totalIncome = 0;
  /** @type {Map<string, { id: string, label: string, value: number }>} */
  const spendingByCategory = new Map();

  for (const row of rows) {
    const eur = parseFloat(String(row.amount_eur ?? row.amount));
    if (row.is_income) {
      totalIncome += eur;
    } else {
      const id =
        row.category_id == null
          ? UNCATEGORISED_NODE_ID
          : `cat:${row.category_id}`;
      const label =
        row.category_id == null
          ? UNCATEGORISED_NODE_ID
          : String(row.category_name ?? row.category_id);
      const current = spendingByCategory.get(id);
      spendingByCategory.set(id, {
        id,
        label,
        value: (current?.value ?? 0) + eur,
      });
    }
  }

  if (totalIncome === 0 && spendingByCategory.size === 0) {
    return buildEnvelope(
      { nodes: [], links: [], year: targetYear },
      { source: "live" },
    );
  }

  // Take top N spending categories
  const allSortedCategories = [...spendingByCategory.values()].sort(
    (a, b) => b.value - a.value,
  );
  const sortedCategories = allSortedCategories.slice(0, TOP_N);

  // Merge the rest into "Other"
  if (allSortedCategories.length > TOP_N) {
    const otherTotal = allSortedCategories
      .slice(TOP_N)
      .reduce((acc, category) => acc + category.value, 0);
    if (otherTotal > 0) {
      sortedCategories.push({
        id: OTHER_NODE_ID,
        label: OTHER_NODE_ID,
        value: otherTotal,
      });
    }
  }

  // Reconcile the wire graph in integer cents. Rounding nodes and links
  // independently can make d3-sankey recompute a different node thickness
  // (for example three 0.335 category totals). One cent representation keeps
  // every internal node exactly flow-conserving.
  const categoriesInCents = sortedCategories
    .map(({ id, label, value }) => ({ id, label, cents: toCents(value) }))
    .filter(({ cents }) => cents > 0);
  const incomeCents = toCents(totalIncome);
  const spendingCents = categoriesInCents.reduce(
    (acc, category) => acc + category.cents,
    0,
  );
  const savingsCents = Math.max(0, incomeCents - spendingCents);
  const fundingGapCents = Math.max(0, spendingCents - incomeCents);
  const incomeAppliedToSpendingCents = Math.min(incomeCents, spendingCents);

  // Build nodes
  const nodes = [
    {
      id: INCOME_NODE_ID,
      label: INCOME_NODE_ID,
      value: fromCents(incomeCents),
    },
    ...(fundingGapCents > 0
      ? [
          {
            id: FUNDING_GAP_NODE_ID,
            label: FUNDING_GAP_NODE_ID,
            value: fromCents(fundingGapCents),
          },
        ]
      : []),
    {
      id: SPENDING_NODE_ID,
      label: SPENDING_NODE_ID,
      value: fromCents(spendingCents),
    },
    ...categoriesInCents.map(({ id, label, cents }) => ({
      id,
      label,
      value: fromCents(cents),
    })),
  ];

  if (savingsCents > 0) {
    nodes.push({
      id: SAVINGS_NODE_ID,
      label: SAVINGS_NODE_ID,
      value: fromCents(savingsCents),
    });
  }

  // Build links
  const links = [
    ...(incomeAppliedToSpendingCents > 0
      ? [
          {
            source: INCOME_NODE_ID,
            target: SPENDING_NODE_ID,
            value: fromCents(incomeAppliedToSpendingCents),
          },
        ]
      : []),
    ...(fundingGapCents > 0
      ? [
          {
            source: FUNDING_GAP_NODE_ID,
            target: SPENDING_NODE_ID,
            value: fromCents(fundingGapCents),
          },
        ]
      : []),
    ...categoriesInCents.map(({ id, cents }) => ({
      source: SPENDING_NODE_ID,
      target: id,
      value: fromCents(cents),
    })),
    ...(savingsCents > 0
      ? [
          {
            source: INCOME_NODE_ID,
            target: SAVINGS_NODE_ID,
            value: fromCents(savingsCents),
          },
        ]
      : []),
  ];

  const data = { nodes, links, year: targetYear };
  assertNoNaN(data, "computeSankey");
  return buildEnvelope(data, { source: "live" });
}

/** @param {number} n */
function toCents(n) {
  return Math.round(roundMoney(n) * 100);
}

/** @param {number} cents */
function fromCents(cents) {
  return cents / 100;
}

export default { computeSankeyFlow };
