/**
 * Asset Class Detail section renderer.
 *
 * Shows a grouped bar chart (invested vs value per class) and a per-class P/L table.
 */

import { escapeHtml, fmtCurrency, fmtPct, signClass, svgGenericGroupedBarChart } from '../sectionHelpers.js';

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
 * @param {object | null} data  fetchPortfolioData result
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderAssetClassDetail(data, { currency }) {
  const latest    = (data?.snapshots ?? []).at(-1);
  const breakdown = data?.breakdown ?? [];

  if (!latest && !breakdown.length) {
    return `
      <div class="page">
        <div class="section-title">Asset Class Detail</div>
        <div class="section-subtitle">Invested vs. current value per asset class</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No data</strong>Add investments to see the asset class breakdown.</div>
      </div>`;
  }

  // Build asset-class rows
  const classMap = new Map();

  if (latest) {
    const add = (key, label, value, invested) => {
      const v = Number(value ?? 0);
      const i = Number(invested ?? 0);
      if (v > 0 || i > 0) classMap.set(key, { label, value: v, invested: i });
    };
    add('stocks_etfs', 'Stocks & ETFs', latest.stocks_etfs_value, latest.stocks_etfs_invested);
    add('crypto',      'Crypto',        latest.crypto_value,      latest.crypto_invested);
    add('metals',      'Metals',        latest.metals_value,      latest.metals_invested);
    const cash = Number(latest.cash_value ?? 0);
    if (cash > 0) classMap.set('cash', { label: 'Cash / Savings', value: cash, invested: cash });
  } else {
    for (const inv of breakdown) {
      const ac    = inv.assetClass ?? inv.asset_class ?? 'other';
      const label = ASSET_CLASS_LABELS[ac] ?? ac;
      if (!classMap.has(ac)) classMap.set(ac, { label, value: 0, invested: 0 });
      classMap.get(ac).value    += Number(inv.currentValue ?? inv.current_value ?? 0);
      classMap.get(ac).invested += Number(inv.totalInvested ?? inv.total_invested ?? 0);
    }
  }

  const classes = [...classMap.values()].sort((a, b) => b.value - a.value);

  const groups = classes.map(c => ({ label: c.label, value: c.value, invested: c.invested }));
  const seriesDefs = [
    { key: 'invested', color: 'hsl(var(--chart-2))', label: 'Invested' },
    { key: 'value',    color: 'hsl(var(--chart-1))', label: 'Value'    },
  ];
  const chart = svgGenericGroupedBarChart(groups, seriesDefs);

  const total = classes.reduce((s, c) => s + c.value, 0);
  const tableRows = classes.map(c => {
    const gl  = c.value - c.invested;
    const pct = c.invested > 0 ? (gl / c.invested) * 100 : 0;
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    const share = total > 0 ? (c.value / total) * 100 : 0;
    const cls = signClass(gl);
    return `<tr>
      <td>${escapeHtml(c.label)}</td>
      <td class="num">${fmtCurrency(c.invested, currency)}</td>
      <td class="num">${fmtCurrency(c.value,    currency)}</td>
      <td class="num ${cls}">${fmtCurrency(gl, currency)}</td>
      <td class="num ${cls}">${fmtPct(pct, true)}</td>
      <td class="num" style="color:hsl(var(--muted))">${share.toFixed(1)}%</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="section-title">Asset Class Detail</div>
      <div class="section-subtitle">Invested capital vs. current value per asset class</div>
      <hr class="section-divider">
      <div class="chart-wrap">${chart}</div>
      <table class="data-table">
        <thead><tr>
          <th>Asset Class</th>
          <th class="num">Invested</th>
          <th class="num">Value</th>
          <th class="num">P/L</th>
          <th class="num">Return</th>
          <th class="num">Share</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}
