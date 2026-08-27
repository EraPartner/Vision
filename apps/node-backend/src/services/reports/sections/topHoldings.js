/**
 * Top Holdings section renderer.
 *
 * Renders a table of the top 15 investments by current value.
 */

import { assetClassLabel, emptySection, escapeHtml, fmtCurrency, fmtPct, sectionPage, signClass } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherPortfolio.js').PortfolioReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTopHoldings(data, { currency }) {
  const breakdown = data?.breakdown ?? [];

  if (!breakdown.length) {
    return emptySection({
      title: 'Top Holdings',
      subtitle: 'Largest positions by current value',
      heading: 'No holdings data',
      message: 'Add investments to see the top holdings.',
    });
  }

  const sorted = [...breakdown]
    .sort((a, b) => (Number(b.currentValue ?? 0)) - (Number(a.currentValue ?? 0)))
    .slice(0, 15);

  const totalValue = breakdown.reduce((s, inv) => s + Number(inv.currentValue ?? 0), 0);

  const rows = sorted.map((inv, idx) => {
    const val      = Number(inv.currentValue ?? 0);
    const invested = Number(inv.totalInvested ?? 0);
    const gl       = Number(inv.gainLoss ?? 0);
    const glPct    = Number(inv.gainLossPercent ?? (invested > 0 ? (gl / invested) * 100 : 0));
    const share    = totalValue > 0 ? (val / totalValue) * 100 : 0;
    const ac       = inv.assetClass;
    const glCls    = signClass(gl);

    return `<tr>
      <td style="color:hsl(var(--muted));font-size:10px;">${idx + 1}</td>
      <td>${escapeHtml(inv.name ?? '—')}</td>
      <td>${escapeHtml(inv.symbol ?? '—')}</td>
      <td><span class="badge badge-neutral">${escapeHtml(assetClassLabel(ac))}</span></td>
      <td class="num">${fmtCurrency(invested, currency)}</td>
      <td class="num">${fmtCurrency(val, currency)}</td>
      <td class="num ${glCls}">${fmtCurrency(gl, currency)}</td>
      <td class="num ${glCls}">${fmtPct(glPct, true)}</td>
      <td class="num" style="color:hsl(var(--muted))">${share.toFixed(1)}%</td>
    </tr>`;
  }).join('');

  return sectionPage({
    title: 'Top Holdings',
    subtitle: `Largest positions by current value (top ${sorted.length} of ${breakdown.length})`,
    content: `
      <table class="data-table">
        <thead><tr>
          <th>#</th>
          <th>Investment</th>
          <th>Symbol</th>
          <th>Type</th>
          <th class="num">Invested</th>
          <th class="num">Value</th>
          <th class="num">P/L</th>
          <th class="num">Return</th>
          <th class="num">Share</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`,
  });
}
