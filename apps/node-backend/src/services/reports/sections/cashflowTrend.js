/**
 * Section renderer: Cashflow Trend.
 *
 * Grouped bar chart (income vs. expenses per month) for the requested period,
 * followed by a monthly summary table.
 */

import {
  escapeHtml,
  fmtCurrency,
  fmtMonthLabel,
  svgGroupedBarChart,
  signClass,
} from '../sectionHelpers.js';
import { filterMonthsByPeriod } from '../dataFetcher.js';

/**
 * @param {Pick<import('../dataFetcher.js').FinancialReportData, 'monthly'>} data
 * @param {{ currency: string; period: import('../dataFetcher.js').Period }} opts
 * @returns {string}
 */
export function renderCashflowTrend(data, { currency, period }) {
  const months = filterMonthsByPeriod(data.monthly?.months ?? [], period);

  if (!months.length) {
    return `
      <div class="page page-break">
        <div class="section-title">Cashflow Trend</div>
        <div class="section-subtitle">Monthly income vs. expenses</div>
        <hr class="section-divider">
        <div class="empty-notice">No data for selected period.</div>
      </div>`;
  }

  // Build chart groups — use all months in chronological order
  const groups = months.map(m => ({
    label: fmtMonthLabel(m.year, m.month),
    income: m.total_income,
    spending: m.total_spending, // negative; svgGroupedBarChart uses Math.abs
  }));

  const chartSvg = svgGroupedBarChart(groups);

  // Monthly table (most recent first)
  const tableRows = [...months].reverse().map(m => {
    const net = m.net_amount;
    const sc = signClass(net);
    return `
      <tr>
        <td>${escapeHtml(fmtMonthLabel(m.year, m.month))}</td>
        <td class="num pos">${escapeHtml(fmtCurrency(m.total_income, currency))}</td>
        <td class="num neg">${escapeHtml(fmtCurrency(Math.abs(m.total_spending), currency))}</td>
        <td class="num ${sc}">${escapeHtml(fmtCurrency(net, currency))}</td>
        <td class="num">${m.transaction_count}</td>
      </tr>`;
  }).join('');

  return `
    <div class="page page-break">
      <div class="section-title">Cashflow Trend</div>
      <div class="section-subtitle">Monthly income vs. expenses — ${escapeHtml(String(months.length))} month${months.length !== 1 ? 's' : ''}</div>
      <hr class="section-divider">
      <div class="chart-wrap">${chartSvg}</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Month</th>
            <th class="num">Income</th>
            <th class="num">Expenses</th>
            <th class="num">Net</th>
            <th class="num">Txns</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}
