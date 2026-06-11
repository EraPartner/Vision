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
import { convertRowsToEur } from '../../currency/currencyConversionService.js';
import { buildEnvelope } from './_envelope.js';
import { roundMoney } from '../../../lib/money.js';

const INCOME_NODE_ID = '__income__';
const SAVINGS_NODE_ID = '__savings__';
const TOP_N = 12;

/**
 * @param {{ targetCurrency?: string, year?: number, excludedCategoryIds?: any[], excludedRecipientIds?: any[] }} [opts]
 */
export async function computeSankeyFlow({
  targetCurrency = 'EUR',
  year,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
} = {}) {
  const targetYear = year ?? new Date().getFullYear();
  const yearStart = `${targetYear}-01-01`;
  const yearEnd = `${targetYear}-12-31`;

  /** @type {any[]} */
  const params = [yearStart, yearEnd];
  const clauses = [];

  if (excludedCategoryIds.length > 0) {
    params.push(excludedCategoryIds);
    clauses.push(`AND COALESCE(t.category_id, r.default_category_id) != ALL($${params.length})`);
  }

  if (excludedRecipientIds.length > 0) {
    params.push(excludedRecipientIds);
    clauses.push(`AND t.recipient_id != ALL($${params.length})`);
  }

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
    LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
    WHERE t.is_active = true
      AND t.date BETWEEN $1 AND $2
      ${clauses.join('\n      ')}
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
    result.rows.map((r) => ({ ...r, amount: Math.abs(parseFloat(r.amount)) })),
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

  return buildEnvelope({ nodes, links, year: targetYear }, { source: 'live' });
}

function round(n) {
  return roundMoney(n);
}

export default { computeSankeyFlow };
