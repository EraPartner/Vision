/**
 * Top Holdings section renderer.
 *
 * Renders a table of the top 15 investments by current value.
 */

import { escapeHtml, fmtCurrency, fmtPct, signClass } from '../sectionHelpers.js';

/** @type {Record<string, string>} */
const ASSET_CLASS_LABELS = {
  stock:       'Stock',
  etf:         'ETF',
  crypto:      'Crypto',
  metals:      'Metals',
  savings:     'Savings',
  bond:        'Bond',
  real_estate: 'Real Estate',
  other:       'Other',
};

/**
 * @param {import('../dataFetcherPortfolio.js').PortfolioReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTopHoldings(data, { currency }) {
  const breakdown = data?.breakdown ?? [];

  if (!breakdown.length) {
    return `
      <div class="page">
        <div class="section-title">Top Holdings</div>
        <div class="section-subtitle">Largest positions by current value</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No holdings data</strong>Add investments to see the top holdings.</div>
      </div>`;
  }

  const sorted = [...breakdown]
    .sort((a, b) => (Number(b.currentValue ?? 0)) - (Number(a.currentValue ?? 0)))
    .slice(0, 15);

  const totalValue = breakdown.reduce((s, inv) => s + Number(inv.currentValue ?? 0), 0);

  const rows = sorted.map((inv, idx) => {
    const val      = Number(inv.currentValue ?? 0);
    const invested = Number(inv.totalInvested   ?? inv.total_invested   ?? 0);
    const gl       = Number(inv.gainLoss        ?? inv.gain_loss        ?? 0);
    const glPct    = Number(inv.gainLossPercent ?? inv.gain_loss_pct    ?? (invested > 0 ? (gl / invested) * 100 : 0));
    const share    = totalValue > 0 ? (val / totalValue) * 100 : 0;
    const ac       = inv.assetClass ?? inv.asset_class ?? 'other';
    const glCls    = signClass(gl);

    return `<tr>
      <td style="color:hsl(var(--muted));font-size:10px;">${idx + 1}</td>
      <td>${escapeHtml(inv.name ?? '—')}</td>
      <td>${escapeHtml(inv.symbol ?? '—')}</td>
      <td><span class="badge badge-neutral">${escapeHtml(ASSET_CLASS_LABELS[ac] ?? ac)}</span></td>
      <td class="num">${fmtCurrency(invested, currency)}</td>
      <td class="num">${fmtCurrency(val, currency)}</td>
      <td class="num ${glCls}">${fmtCurrency(gl, currency)}</td>
      <td class="num ${glCls}">${fmtPct(glPct, true)}</td>
      <td class="num" style="color:hsl(var(--muted))">${share.toFixed(1)}%</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="section-title">Top Holdings</div>
      <div class="section-subtitle">Largest positions by current value (top ${sorted.length} of ${breakdown.length})</div>
      <hr class="section-divider">
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
      </table>
    </div>`;
}
