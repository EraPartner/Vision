/**
 * Tax Type Breakdown section renderer.
 *
 * svgHorizontalBars of TOB / dividend WHT / sell taxes / fees / other; table with absolute + %.
 */

import { fmtCurrency, fmtPct, svgHorizontalBars } from '../sectionHelpers.js';

/**
 * @param {object | null} data  fetchTaxData result
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTaxTypeBreakdown(data, { currency }) {
  const totals = data?.totals ?? {};

  const components = [
    { label: 'TOB (Transaction Tax)',      amount: totals.tobTotal         ?? 0 },
    { label: 'Dividend WHT',               amount: totals.dividendWHTTotal ?? 0 },
    { label: 'Capital Gains / Sell Tax',   amount: totals.sellTaxTotal     ?? 0 },
    { label: 'Broker / Management Fees',   amount: totals.feesTotal        ?? 0 },
    { label: 'Other Taxes',                amount: totals.otherTaxTotal    ?? 0 },
  ].filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);

  if (!components.length) {
    return `
      <div class="page">
        <div class="section-title">Tax Type Breakdown</div>
        <div class="section-subtitle">Distribution of taxes and fees by type</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No tax data</strong>No tax transactions found for the selected period.</div>
      </div>`;
  }

  const total = components.reduce((s, c) => s + c.amount, 0);

  const barItems = components.map(c => ({
    label:    c.label,
    value:    c.amount,
    fmtValue: fmtCurrency(c.amount, currency),
  }));

  /* eslint-disable vision-local-money/no-raw-money-arithmetic */
  const tableRows = components.map(c => `<tr>
    <td>${c.label}</td>
    <td class="num neg">${fmtCurrency(c.amount, currency)}</td>
    <td class="num">${total > 0 ? fmtPct((c.amount / total) * 100, false) : '—'}</td>
  </tr>`).join('');
  /* eslint-enable vision-local-money/no-raw-money-arithmetic */

  return `
    <div class="page">
      <div class="section-title">Tax Type Breakdown</div>
      <div class="section-subtitle">Total cost: ${fmtCurrency(total, currency)} across ${components.length} categories</div>
      <hr class="section-divider">
      <div class="chart-wrap">${svgHorizontalBars(barItems, { maxItems: 8 })}</div>
      <table class="data-table">
        <thead><tr>
          <th>Tax / Fee Type</th>
          <th class="num">Amount</th>
          <th class="num">Share</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}
