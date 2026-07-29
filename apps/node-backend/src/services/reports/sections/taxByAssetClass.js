/**
 * Tax by Asset Class section renderer.
 *
 * Grouped bar chart: taxes vs fees per asset class + summary table.
 */

import { escapeHtml, fmtCurrency, svgGenericGroupedBarChart } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherTax.js').TaxReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTaxByAssetClass(data, { currency }) {
  const byAssetClass = data?.byAssetClass ?? {};

  const classes = Object.entries(byAssetClass)
    .map(([label, vals]) => ({
      label,
      taxes: vals.taxes ?? 0,
      fees:  vals.fees  ?? 0,
    }))
    .filter(c => c.taxes > 0 || c.fees > 0)
    .sort((a, b) => (b.taxes + b.fees) - (a.taxes + a.fees));

  if (!classes.length) {
    return `
      <div class="page">
        <div class="section-title">Tax by Asset Class</div>
        <div class="section-subtitle">Taxes and fees broken down by asset class</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No data</strong>No tax or fee data found by asset class for the selected period.</div>
      </div>`;
  }

  const groups = classes.map(c => ({ label: c.label, taxes: c.taxes, fees: c.fees }));
  const seriesDefs = [
    { key: 'taxes', color: 'hsl(var(--chart-1))', label: 'Taxes' },
    { key: 'fees',  color: 'hsl(var(--chart-2))', label: 'Fees'  },
  ];
  const chart = svgGenericGroupedBarChart(groups, seriesDefs);

  const tableRows = classes.map(c => {
    const total = c.taxes + c.fees;
    return `<tr>
      <td>${escapeHtml(c.label)}</td>
      <td class="num neg">${fmtCurrency(c.taxes, currency)}</td>
      <td class="num neg">${fmtCurrency(c.fees, currency)}</td>
      <td class="num neg">${fmtCurrency(total, currency)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="section-title">Tax by Asset Class</div>
      <div class="section-subtitle">Taxes and fees across ${classes.length} asset class${classes.length === 1 ? '' : 'es'}</div>
      <hr class="section-divider">
      <div class="chart-wrap">${chart}</div>
      <table class="data-table">
        <thead><tr>
          <th>Asset Class</th>
          <th class="num">Taxes</th>
          <th class="num">Fees</th>
          <th class="num">Total</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}
