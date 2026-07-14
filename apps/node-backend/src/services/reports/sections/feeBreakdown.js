/**
 * Fee Breakdown section renderer.
 *
 * Fees per asset class; horizontal bars + table.
 */

import { escapeHtml, fmtCurrency, fmtPct, svgHorizontalBars } from '../sectionHelpers.js';

/**
 * @param {object | null} data  fetchTaxData result
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderFeeBreakdown(data, { currency }) {
  const byAssetClass = data?.byAssetClass ?? {};

  const rows = Object.entries(byAssetClass)
    .map(([ac, vals]) => ({ label: ac, fees: vals.fees ?? 0, taxes: vals.taxes ?? 0 }))
    .filter(r => r.fees > 0)
    .sort((a, b) => b.fees - a.fees);

  const totalFees  = (data?.totals?.feesTotal ?? 0);

  if (!rows.length && totalFees === 0) {
    return `
      <div class="page">
        <div class="section-title">Fee Breakdown</div>
        <div class="section-subtitle">Broker and management fees by asset class</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No fee data</strong>No fees found for the selected period.</div>
      </div>`;
  }

  const barItems = rows.map(r => ({
    label:    r.label,
    value:    r.fees,
    fmtValue: fmtCurrency(r.fees, currency),
  }));

  const tableRows = rows.map(r => {
    const share = totalFees > 0 ? (r.fees / totalFees) * 100 : 0;
    return `<tr>
      <td>${escapeHtml(r.label)}</td>
      <td class="num neg">${fmtCurrency(r.fees, currency)}</td>
      <td class="num">${fmtPct(share, false)}</td>
    </tr>`;
  }).join('');

  const chartHtml = barItems.length
    ? `<div class="chart-wrap">${svgHorizontalBars(barItems, { maxItems: 8 })}</div>`
    : '';

  return `
    <div class="page">
      <div class="section-title">Fee Breakdown</div>
      <div class="section-subtitle">Total fees: ${fmtCurrency(totalFees, currency)}</div>
      <hr class="section-divider">
      ${chartHtml}
      ${tableRows ? `
        <table class="data-table">
          <thead><tr>
            <th>Asset Class</th>
            <th class="num">Fees Paid</th>
            <th class="num">Share</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>` : `<p style="color:hsl(var(--muted));font-size:12px;">Fee detail by asset class unavailable — total: ${fmtCurrency(totalFees, currency)}</p>`}
    </div>`;
}
