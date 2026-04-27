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
  const excludedCategoryIds = data.exclusions?.categoryIds ?? [];
  const hasExclusions = excludedCategoryIds.length > 0;

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

  // When exclusions are active, build a client-side filtered list alongside the full set
  const excludedIdSet = new Set(excludedCategoryIds);
  const filteredSorted = hasExclusions
    ? sorted.filter(c => c.id == null || !excludedIdSet.has(c.id))
    : null;

  // Build chart section — single chart normally, dual comparison when filters active
  let chartHtml;
  if (hasExclusions && filteredSorted) {
    const allItems = sorted.slice(0, MAX_CHART_ITEMS).map(c => ({
      label: c.name ?? 'Uncategorised',
      value: Math.abs(c.total),
      fmtValue: fmtCurrency(Math.abs(c.total), currency),
    }));
    const filteredItems = filteredSorted.slice(0, MAX_CHART_ITEMS).map(c => ({
      label: c.name ?? 'Uncategorised',
      value: Math.abs(c.total),
      fmtValue: fmtCurrency(Math.abs(c.total), currency),
    }));
    chartHtml = `
      <div class="chart-pair">
        <div>
          <div class="chart-pair-label">With active filters (${filteredSorted.length} categor${filteredSorted.length === 1 ? 'y' : 'ies'})</div>
          ${svgHorizontalBars(filteredItems)}
        </div>
        <div>
          <div class="chart-pair-label">All data (${sorted.length} categor${sorted.length === 1 ? 'y' : 'ies'})</div>
          ${svgHorizontalBars(allItems)}
        </div>
      </div>`;
  } else {
    const chartItems = sorted.slice(0, MAX_CHART_ITEMS).map(c => ({
      label: c.name ?? 'Uncategorised',
      value: Math.abs(c.total),
      fmtValue: fmtCurrency(Math.abs(c.total), currency),
    }));
    chartHtml = `<div class="chart-wrap">${svgHorizontalBars(chartItems)}</div>`;
  }

  // Table: filtered rows when exclusions active, full set otherwise
  const tableSource = filteredSorted ?? sorted;
  const tableRows = tableSource.slice(0, MAX_TABLE_ROWS).map((c, i) => {
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

  const note = tableSource.length > MAX_TABLE_ROWS
    ? `<p style="font-size:10px;color:hsl(var(--muted));margin-top:8px">Showing top ${MAX_TABLE_ROWS} of ${tableSource.length} categories by spend.</p>`
    : '';

  const filterNoticeHtml = hasExclusions
    ? `<div class="filter-notice">Table shows ${filteredSorted?.length ?? 0} categories matching active filters. ${excludedCategoryIds.length} categor${excludedCategoryIds.length === 1 ? 'y' : 'ies'} excluded — see "All data" chart above.</div>`
    : '';

  return `
    <div class="page page-break">
      <div class="section-title">Category Breakdown</div>
      <div class="section-subtitle">Top spending categories (all time)</div>
      <hr class="section-divider">
      ${chartHtml}
    </div>
    <div class="page-continuation">
      ${filterNoticeHtml}
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
