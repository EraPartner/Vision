/**
 * Tax Type Breakdown section renderer.
 *
 * svgHorizontalBars of TOB / dividend WHT / sell taxes / fees / other; table with absolute + %.
 */

import { emptySection, escapeHtml, fmtCurrency, fmtPct, sectionPage, svgHorizontalBars } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherTax.js').TaxReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTaxTypeBreakdown(data, { currency }) {
  const components = [
    { label: 'TOB (Transaction Tax)',      amount: data?.tobTotal         ?? 0 },
    { label: 'Dividend WHT',               amount: data?.dividendWHTTotal ?? 0 },
    { label: 'Capital Gains / Sell Tax',   amount: data?.sellTaxTotal     ?? 0 },
    { label: 'Broker / Management Fees',   amount: data?.feesTotal        ?? 0 },
    { label: 'Other Taxes',                amount: data?.otherTaxTotal    ?? 0 },
  ].filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);

  if (!components.length) {
    return emptySection({ title: 'Tax Type Breakdown', subtitle: 'Distribution of taxes and fees by type', heading: 'No tax data', message: 'No tax transactions found for the selected period.' });
  }

  const total = components.reduce((s, c) => s + c.amount, 0);

  const barItems = components.map(c => ({
    label:    c.label,
    value:    c.amount,
    fmtValue: fmtCurrency(c.amount, currency),
  }));

  /* eslint-disable vision-local-money/no-raw-money-arithmetic */
  const tableRows = components.map(c => `<tr>
    <td>${escapeHtml(c.label)}</td>
    <td class="num neg">${fmtCurrency(c.amount, currency)}</td>
    <td class="num">${total > 0 ? fmtPct((c.amount / total) * 100, true) : '—'}</td>
  </tr>`).join('');
  /* eslint-enable vision-local-money/no-raw-money-arithmetic */

  return sectionPage({
    title: 'Tax Type Breakdown',
    subtitle: `Total cost: ${fmtCurrency(total, currency)} across ${components.length} categories`,
    content: `
      <div class="chart-wrap">${svgHorizontalBars(barItems, { maxItems: 8 })}</div>
      <table class="data-table">
        <thead><tr>
          <th>Tax / Fee Type</th>
          <th class="num">Amount</th>
          <th class="num">Share</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`,
  });
}
