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
 *   "Income" → each spending category (by EUR total)
 *   Remaining income (income − total spending) → "Savings / Unspent"
 *
 * @param {object} opts
 * @param {string} [opts.targetCurrency='EUR']
 * @param {number} [opts.year]  Defaults to current calendar year.
 */

import { query } from '../../../database/connection.js';
import { buildExclusionClauses } from '../../../lib/filterBuilder.js';
import { getIncludeTransfers } from '../../../repositories/infoRepositoryHelpers.js';
import { convertRowsToEur } from '../../currency/currencyConversionService.js';
import { buildEnvelope } from './_envelope.js';
import { assertNoNaN } from './_invariants.js';
import { roundMoney } from '../../../lib/money.js';
import { toAppTz } from '../../../lib/timezone.js';

const INCOME_NODE_ID = '__income__';
const SAVINGS_NODE_ID = '__savings__';
const TOP_N = 12;

/**
 * Shape of a row from the SQL aggregate above: `amount` is a SUM(ABS(...))
 * NUMERIC, so pg returns it as a string.
 * @typedef {{ category_name: string, currency: string, is_income: boolean, amount: string }} SankeyRow
 */

/**
 * @param {{ targetCurrency?: string, year?: number, excludedCategoryIds?: number[], excludedRecipientIds?: number[] }} [opts]
 */
export async function computeSankeyFlow({
  targetCurrency = 'EUR',
  year,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
} = {}) {
  const targetYear = year ?? toAppTz(new Date()).year;
  const yearStart = `${targetYear}-01-01`;
  const yearEnd = `${targetYear}-12-31`;

  /** @type {any[]} */
  const params = [yearStart, yearEnd];

  // Canonical exclusion clauses (lib/filterBuilder.buildExclusionClauses),
  // shared with every other money surface: the 3-level effective-category
  // COALESCE (own → recipient default → PRIMARY recipient's default, matching
  // transactionRepository and the category JOIN below) and the ALIAS-AWARE
  // recipient form, both carrying the `-1` NULL sentinel.
  //
  // This file used to hand-roll both, and drifted from the canonical pair in
  // two ways. `!= ALL($n)` without the sentinel evaluates to NULL — not true —
  // for a NULL effective category, so *every uncategorised row* was silently
  // dropped as soon as any exclusion was applied: excluding one spending
  // category erased an unrelated €3000 uncategorised income row and rendered
  // "Income 0" with money still flowing out of it. And the bare
  // `t.recipient_id != ALL(...)` was not alias-aware, so excluding a PRIMARY
  // recipient left its aliases' rows in the graph. Routing through the shared
  // builder keeps sankey out of the exclusion-drift business for good.
  //
  // The date filter owns $1/$2, so the exclusion placeholders start at $3.
  const excl = buildExclusionClauses({
    excludedCategoryIds,
    excludedRecipientIds,
    startParamIdx: params.length + 1,
  });
  params.push(...excl.params);
  const exclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : '';

  // ADR-083: internal transfers are excluded from income/spending by default —
  // a savings transfer's two legs would otherwise inflate BOTH sides of the
  // flow graph (fake income in, fake spending out). Governed by the same
  // runtime `includeTransfers` setting every other aggregation honours, so a
  // user who opted in to seeing transfers sees them here too.
  const includeTransfers = await getIncludeTransfers();

  // Aggregate in SQL: this endpoint converts with latest rates only (one rate
  // per currency below), so SUM(ABS(amount)) per (category, currency, is_income)
  // is identical to summing the per-row converted amounts — but returns ~tens of
  // rows instead of a whole year of transactions. Each group is sign-homogeneous
  // (grouped on amount > 0), so ABS distributes over the sum.
  const result = await query(
    `
    SELECT
      COALESCE(c.general || ': ' || c.detail, 'Uncategorised') AS category_name,
      t.currency,
      (t.amount > 0) AS is_income,
      SUM(ABS(t.amount)) AS amount
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id
    WHERE t.is_active = true
      ${includeTransfers ? '' : 'AND t.is_transfer = false'}
      AND t.date BETWEEN $1 AND $2
      ${exclusionWhere}
    GROUP BY 1, 2, 3
    `,
    params,
  );

  if (!result.rows.length) {
    return buildEnvelope(
      { nodes: [], links: [], year: targetYear },
      { source: 'live' },
    );
  }

  // Convert to target currency
  const rows = await convertRowsToEur(
    result.rows.map((/** @type {SankeyRow} */ r) => ({ ...r, amount: Math.abs(parseFloat(r.amount)) })),
    targetCurrency,
  );

  // Accumulate totals
  let totalIncome = 0;
  const spendingByCategory = new Map();

  for (const row of rows) {
    const eur = parseFloat(String(row.amount_eur ?? row.amount));
    if (row.is_income) {
      totalIncome += eur;
    } else {
      const name = row.category_name;
      spendingByCategory.set(name, (spendingByCategory.get(name) ?? 0) + eur);
    }
  }

  if (totalIncome === 0 && spendingByCategory.size === 0) {
    return buildEnvelope(
      { nodes: [], links: [], year: targetYear },
      { source: 'live' },
    );
  }

  // Take top N spending categories
  const allSortedCategories = [...spendingByCategory.entries()]
    .sort((a, b) => b[1] - a[1]);
  const sortedCategories = allSortedCategories.slice(0, TOP_N);

  // Merge the rest into "Other"
  if (allSortedCategories.length > TOP_N) {
    const otherTotal = allSortedCategories
      .slice(TOP_N)
      .reduce((acc, [, v]) => acc + v, 0);
    if (otherTotal > 0) {
      sortedCategories.push(['Other', otherTotal]);
    }
  }

  const totalSpending = sortedCategories.reduce((acc, [, v]) => acc + v, 0);
  const savings = Math.max(0, totalIncome - totalSpending);

  // Build nodes
  const nodes = [
    { id: INCOME_NODE_ID, label: 'Income', value: round(totalIncome) },
    ...sortedCategories.map(([name, value]) => ({
      id: `cat:${name}`,
      label: name,
      value: round(value),
    })),
  ];

  if (savings > 0.5) {
    nodes.push({ id: SAVINGS_NODE_ID, label: 'Savings / Unspent', value: round(savings) });
  }

  // Build links
  const links = [
    ...sortedCategories.map(([name, value]) => ({
      source: INCOME_NODE_ID,
      target: `cat:${name}`,
      value: round(value),
    })),
    ...(savings > 0.5
      ? [{ source: INCOME_NODE_ID, target: SAVINGS_NODE_ID, value: round(savings) }]
      : []),
  ];

  const data = { nodes, links, year: targetYear };
  assertNoNaN(data, 'computeSankey');
  return buildEnvelope(data, { source: 'live' });
}

/** @param {number} n */
function round(n) {
  return roundMoney(n);
}

export default { computeSankeyFlow };
