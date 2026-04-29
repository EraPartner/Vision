/**
 * Top Investments by Cost section renderer.
 *
 * Table sorted by total taxes + fees per investment.
 */

import { escapeHtml, fmtCurrency } from '../sectionHelpers.js';

/**
 * @param {object | null} data  fetchTaxData result
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTopInvestmentsByCost(data, { currency }) {
  const byInvestment = data?.byInvestment ?? [];

  if (!byInvestment.length) {
    return `
      <div class="page">
        <div class="section-title">Top Investments by Tax Cost</div>
        <div class="section-subtitle">Investments with the highest tax and fee burden</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No data</strong>No per-investment tax data found for the selected period.</div>
      </div>`;
  }

  const sorted = [...byInvestment]
    .sort((a, b) => ((b.taxes ?? 0) + (b.fees ?? 0)) - ((a.taxes ?? 0) + (a.fees ?? 0)))
    .slice(0, 15);

  const tableRows = sorted.map((inv, idx) => {
    const taxes = inv.taxes ?? 0;
    const fees  = inv.fees  ?? 0;
    const tob   = inv.tobTotal          ?? 0;
    const wht   = inv.dividendWHTTotal  ?? 0;
    const sell  = inv.sellTaxTotal      ?? 0;
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    const total = taxes + fees;
    return `<tr>
      <td style="color:hsl(var(--muted));font-size:10px;">${idx + 1}</td>
      <td>${escapeHtml(inv.name ?? '—')}</td>
      <td>${escapeHtml(inv.symbol ?? '—')}</td>
      <td class="num neg">${fmtCurrency(tob, currency)}</td>
      <td class="num neg">${fmtCurrency(wht, currency)}</td>
      <td class="num neg">${fmtCurrency(sell, currency)}</td>
      <td class="num neg">${fmtCurrency(fees, currency)}</td>
      <td class="num neg" style="font-weight:600;">${fmtCurrency(total, currency)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="section-title">Top Investments by Tax Cost</div>
      <div class="section-subtitle">Highest tax and fee burden (top ${sorted.length} of ${byInvestment.length})</div>
      <hr class="section-divider">
      <table class="data-table">
        <thead><tr>
          <th>#</th>
          <th>Investment</th>
          <th>Symbol</th>
          <th class="num">TOB</th>
          <th class="num">Div. WHT</th>
          <th class="num">Sell Tax</th>
          <th class="num">Fees</th>
          <th class="num">Total Cost</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}
