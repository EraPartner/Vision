/**
 * Tax Monthly Trend section renderer.
 *
 * Monthly grouped bar chart of taxes vs fees + mini-table.
 */

import { fmtCurrency, fmtMonthLabel, svgGenericGroupedBarChart } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherTax.js').TaxReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTaxMonthlyTrend(data, { currency }) {
  const byMonth = data?.byMonth ?? [];

  if (!byMonth.length) {
    return `
      <div class="page">
        <div class="section-title">Monthly Tax Trend</div>
        <div class="section-subtitle">Taxes and fees over time</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No monthly data</strong>No tax transactions found for the selected period.</div>
      </div>`;
  }

  const sorted = [...byMonth].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  /** @param {import('../dataFetcherTax.js').TaxMonthBucket} m */
  const monthTaxes = (m) => (m.tob ?? 0) + (m.wht ?? 0) + (m.sell ?? 0) + (m.other ?? 0);

  const groups = sorted.map(m => ({
    label: fmtMonthLabel(m.year, m.month),
    taxes: monthTaxes(m),
    fees:  m.fees ?? 0,
  }));

  const seriesDefs = [
    { key: 'taxes', color: 'hsl(var(--chart-1))', label: 'Taxes' },
    { key: 'fees',  color: 'hsl(var(--chart-2))', label: 'Fees'  },
  ];
  const chart = svgGenericGroupedBarChart(groups, seriesDefs);

  const tableRows = sorted.map(m => {
    const taxes = monthTaxes(m);
    const total = taxes + (m.fees ?? 0);
    return `<tr>
      <td>${fmtMonthLabel(m.year, m.month)}</td>
      <td class="num neg">${fmtCurrency(taxes, currency)}</td>
      <td class="num neg">${fmtCurrency(m.fees ?? 0, currency)}</td>
      <td class="num neg">${fmtCurrency(total, currency)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="section-title">Monthly Tax Trend</div>
      <div class="section-subtitle">Taxes and fees across ${sorted.length} month${sorted.length === 1 ? '' : 's'}</div>
      <hr class="section-divider">
      <div class="chart-wrap">${chart}</div>
      <table class="data-table">
        <thead><tr>
          <th>Month</th>
          <th class="num">Taxes</th>
          <th class="num">Fees</th>
          <th class="num">Total</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}
