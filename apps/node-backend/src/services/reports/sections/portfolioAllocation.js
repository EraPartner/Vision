/**
 * Portfolio Allocation section renderer.
 *
 * Shows asset-class breakdown via horizontal bars + a legend table.
 */

import { escapeHtml, fmtCurrency, fmtPct, svgHorizontalBars } from '../sectionHelpers.js';

/** @type {Record<string, string>} */
const ASSET_CLASS_LABELS = {
  stock:       'Stocks',
  etf:         'ETFs',
  crypto:      'Crypto',
  metals:      'Metals',
  savings:     'Savings',
  bond:        'Bonds',
  real_estate: 'Real Estate',
  other:       'Other',
};

/**
 * @param {import('../dataFetcherPortfolio.js').PortfolioReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderPortfolioAllocation(data, { currency }) {
  const snapshots = data?.snapshots ?? [];
  const latest    = snapshots.length ? snapshots[snapshots.length - 1] : null;

  if (!latest && !data?.breakdown?.length) {
    return `
      <div class="page">
        <div class="section-title">Asset Allocation</div>
        <div class="section-subtitle">Distribution across asset classes</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No allocation data</strong>Add investments to see the allocation breakdown.</div>
      </div>`;
  }

  // Build asset-class buckets from latest snapshot fields
  /** @type {Array<{ label: string; value: number; invested: number }>} */
  const classes = [];

  if (latest) {
    /**
     * @param {string} label
     * @param {string} value
     * @param {string} invested
     */
    const add = (label, value, invested) => {
      const v = Number(value ?? 0);
      const i = Number(invested ?? 0);
      if (v > 0 || i > 0) classes.push({ label, value: v, invested: i });
    };
    add('Stocks & ETFs', latest.stocks_etfs_value, latest.stocks_etfs_invested);
    add('Crypto',        latest.crypto_value,      latest.crypto_invested);
    add('Metals',        latest.metals_value,      latest.metals_invested);
    if (Number(latest.cash_value ?? 0) > 0) classes.push({ label: 'Cash / Savings', value: Number(latest.cash_value), invested: Number(latest.cash_value) });
  } else {
    // Fall back to breakdown summaries
    /** @type {Map<string, { label: string; value: number; invested: number }>} */
    const grouped = new Map();
    for (const inv of (data.breakdown ?? [])) {
      const ac = inv.assetClass ?? inv.asset_class ?? 'other';
      const label = ASSET_CLASS_LABELS[ac] ?? ac;
      if (!grouped.has(label)) grouped.set(label, { label, value: 0, invested: 0 });
      grouped.get(label).value    += Number(inv.currentValue ?? 0);
      grouped.get(label).invested += Number(inv.totalInvested ?? inv.total_invested ?? 0);
    }
    classes.push(...grouped.values());
  }

  classes.sort((a, b) => b.value - a.value);
  const total = classes.reduce((s, c) => s + c.value, 0);

  const barItems = classes.map(c => ({
    label:    c.label,
    value:    c.value,
    fmtValue: fmtCurrency(c.value, currency),
  }));

  const tableRows = classes.map(c => {
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    const pct = total > 0 ? (c.value / total) : 0;
    const gl  = c.value - c.invested;
    return `<tr>
      <td>${escapeHtml(c.label)}</td>
      <td class="num">${fmtCurrency(c.value,    currency)}</td>
      <td class="num">${fmtCurrency(c.invested, currency)}</td>
      <td class="num">${fmtPct(pct)}</td>
      <td class="num ${gl >= 0 ? 'pos' : 'neg'}">${fmtCurrency(gl, currency)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="section-title">Asset Allocation</div>
      <div class="section-subtitle">Distribution of portfolio value across asset classes</div>
      <hr class="section-divider">
      <div class="chart-wrap">${svgHorizontalBars(barItems, { maxItems: 8 })}</div>
      <table class="data-table">
        <thead><tr>
          <th>Asset Class</th>
          <th class="num">Value</th>
          <th class="num">Invested</th>
          <th class="num">Allocation</th>
          <th class="num">Unrealised P/L</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}
