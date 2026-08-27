/**
 * Dividend Income section renderer.
 *
 * Monthly bar chart of dividend income + top dividend-paying investments table.
 */

import { emptySection, escapeHtml, fmtCurrency, fmtMonthLabel, sectionPage, svgGenericGroupedBarChart } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherPortfolio.js').PortfolioReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderDividendIncome(data, { currency }) {
  const byMonth      = data?.dividends?.byMonth      ?? [];
  const byInvestment = data?.dividends?.byInvestment ?? [];

  if (!byMonth.length && !byInvestment.length) {
    return emptySection({ title: 'Dividend Income', subtitle: 'Dividend cash flows over the selected period', heading: 'No dividend data', message: 'No dividend transactions found for the selected period.' });
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

  return sectionPage({
    title: 'Dividend Income',
    subtitle: `Total: ${fmtCurrency(totalDividends, currency)} across ${byMonth.length} month${byMonth.length === 1 ? '' : 's'}`,
    content: `
      <div class="chart-wrap">${chart}</div>
      ${tableRows ? `
        <table class="data-table">
          <thead><tr>
            <th>Investment</th><th>Symbol</th><th>Type</th>
            <th class="num">Total Dividends</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>` : ''}`,
  });
}
