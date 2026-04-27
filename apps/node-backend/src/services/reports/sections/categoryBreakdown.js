/**
 * Section renderer: Category Breakdown.
 *
 * Horizontal bar chart of spending by category (all-time; period filtering is
 * not available from this aggregation), followed by a ranked table.
 */

import {
  escapeHtml,
  fmtCurrency,
  svgHorizontalBars,
} from '../sectionHelpers.js';

const MAX_CHART_ITEMS = 10;
const MAX_TABLE_ROWS = 20;

/**
 * @param {{ categories: { categories: object[] } | null; exclusions?: { categoryIds: number[]; recipientIds: number[] } }} data
 * @param {{ currency: string; period: import('../dataFetcher.js').Period }} opts
 * @returns {string}
 */
export function renderCategoryBreakdown(data, { currency }) {
  const cats = data.categories?.categories ?? [];
  const excludedCategoryCount = data.exclusions?.categoryIds?.length ?? 0;

  if (!cats.length) {
    return `
      <div class="page page-break">
        <div class="section-title">Category Breakdown</div>
        <div class="section-subtitle">Spending by category</div>
        <hr class="section-divider">
        <div class="empty-notice">No category data available.</div>
      </div>`;
  }

  // Sort by absolute total (largest spend first)
  const sorted = [...cats].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

  // Chart uses top N by amount; value = absolute spend
  const chartItems = sorted.slice(0, MAX_CHART_ITEMS).map(c => ({
    label: c.name ?? 'Uncategorised',
    value: Math.abs(c.total),
    fmtValue: fmtCurrency(Math.abs(c.total), currency),
  }));

  const chartSvg = svgHorizontalBars(chartItems);

  // Table: show more rows, sorted by transaction count (frequency) as secondary view
  const tableRows = sorted.slice(0, MAX_TABLE_ROWS).map((c, i) => {
    const rank = i + 1;
    const total = Math.abs(c.total);
    const avg = c.count > 0 ? total / c.count : 0;
    return `
      <tr>
        <td style="color:hsl(var(--muted));font-size:10px">${rank}</td>
        <td>${escapeHtml(c.name ?? 'Uncategorised')}</td>
        <td class="num neg">${escapeHtml(fmtCurrency(total, currency))}</td>
        <td class="num">${c.count}</td>
        <td class="num">${escapeHtml(fmtCurrency(avg, currency))}</td>
      </tr>`;
  }).join('');

  const note = cats.length > MAX_TABLE_ROWS
    ? `<p style="font-size:10px;color:hsl(var(--muted));margin-top:8px">Showing top ${MAX_TABLE_ROWS} of ${cats.length} categories by spend.</p>`
    : '';

  const filterNoticeHtml = excludedCategoryCount > 0
    ? `<div class="filter-notice">Note: ${excludedCategoryCount} categor${excludedCategoryCount === 1 ? 'y' : 'ies'} excluded by active filters and not shown in this breakdown.</div>`
    : '';

  return `
    <div class="page page-break">
      <div class="section-title">Category Breakdown</div>
      <div class="section-subtitle">Top spending categories (all time)</div>
      <hr class="section-divider">
      ${filterNoticeHtml}
      <div class="chart-wrap">${chartSvg}</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Category</th>
            <th class="num">Total Spent</th>
            <th class="num">Txns</th>
            <th class="num">Avg/Txn</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${note}
    </div>`;
}
