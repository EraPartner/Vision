/**
 * Top Investments by Cost section renderer.
 *
 * Table sorted by total taxes + fees per investment.
 */

import { emptySection, escapeHtml, fmtCurrency, sectionPage } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherTax.js').TaxReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTopInvestmentsByCost(data, { currency }) {
  const byInvestment = data?.byInvestment ?? [];

  if (!byInvestment.length) {
    return emptySection({ title: 'Top Investments by Tax Cost', subtitle: 'Investments with the highest tax and fee burden', heading: 'No data', message: 'No per-investment tax data found for the selected period.' });
  }

  const sorted = [...byInvestment]
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
    .slice(0, 15);

  const tableRows = sorted.map((inv, idx) => {
    const fees  = inv.fees  ?? 0;
    const tob   = inv.tob   ?? 0;
    const wht   = inv.wht   ?? 0;
    const sell  = inv.sell  ?? 0;
    const total = inv.total ?? 0;
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

  return sectionPage({
    title: 'Top Investments by Tax Cost',
    subtitle: `Highest tax and fee burden (top ${sorted.length} of ${byInvestment.length})`,
    content: `
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
      </table>`,
  });
}
