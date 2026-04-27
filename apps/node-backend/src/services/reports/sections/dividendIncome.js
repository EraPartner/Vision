/**
 * Dividend Income section renderer.
 *
 * Monthly bar chart of dividend income + top dividend-paying investments table.
 */

import { escapeHtml, fmtCurrency, fmtMonthLabel, svgGenericGroupedBarChart } from '../sectionHelpers.js';

/**
 * @param {object | null} data  fetchPortfolioData result
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderDividendIncome(data, { currency }) {
  const byMonth      = data?.dividends?.byMonth      ?? [];
  const byInvestment = data?.dividends?.byInvestment ?? [];

  if (!byMonth.length && !byInvestment.length) {
    return `
      <div class="page">
        <div class="section-title">Dividend Income</div>
        <div class="section-subtitle">Dividend cash flows over the selected period</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No dividend data</strong>No dividend transactions found for the selected period.</div>
      </div>`;
  }

  const totalDividends = byMonth.reduce((s, m) => s + m.amount, 0);

  const groups = byMonth.map(m => ({
    label:  fmtMonthLabel(m.year, m.month),
    amount: m.amount,
  }));
  const seriesDefs = [
    { key: 'amount', color: 'hsl(var(--chart-3))', label: 'Dividends' },
  ];
  const chart = svgGenericGroupedBarChart(groups, seriesDefs);

  const top10 = byInvestment.slice(0, 10);
  const tableRows = top10.map(inv => `<tr>
    <td>${escapeHtml(inv.name ?? '—')}</td>
    <td>${escapeHtml(inv.symbol ?? '—')}</td>
    <td>${escapeHtml(inv.assetClass ?? '—')}</td>
    <td class="num">${fmtCurrency(inv.total, currency)}</td>
  </tr>`).join('');

  return `
    <div class="page">
      <div class="section-title">Dividend Income</div>
      <div class="section-subtitle">Total: ${fmtCurrency(totalDividends, currency)} across ${byMonth.length} month${byMonth.length === 1 ? '' : 's'}</div>
      <hr class="section-divider">
      <div class="chart-wrap">${chart}</div>
      ${tableRows ? `
        <table class="data-table">
          <thead><tr>
            <th>Investment</th><th>Symbol</th><th>Type</th>
            <th class="num">Total Dividends</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>` : ''}
    </div>`;
}
