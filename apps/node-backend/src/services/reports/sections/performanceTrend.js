/**
 * Performance Trend section renderer.
 *
 * Overlays portfolio value, invested capital, and inflation-adjusted value
 * on a line chart, with a monthly return-% mini-table below.
 */

import { fmtCurrency, fmtMonthLabel, fmtPct, signClass, svgLineChart } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherPortfolio.js').PortfolioReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderPerformanceTrend(data, { currency }) {
  const snapshots = data?.snapshots ?? [];

  if (!snapshots.length) {
    return `
      <div class="page">
        <div class="section-title">Performance Trend</div>
        <div class="section-subtitle">Portfolio value vs. invested capital over time</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No snapshot data</strong>Performance snapshots are generated nightly. Check back tomorrow.</div>
      </div>`;
  }

  // Deduplicate by month (take latest snapshot per month)
  const byMonth = new Map();
  for (const snap of snapshots) {
    const d   = new Date(snap.snapshot_date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth.set(key, snap);
  }
  const monthly = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, snap]) => snap);

  const labels      = monthly.map(s => { const d = new Date(s.snapshot_date); return fmtMonthLabel(d.getFullYear(), d.getMonth() + 1); });
  const valueVals   = monthly.map(s => Number(s.value ?? 0));
  const investVals  = monthly.map(s => Number(s.invested ?? 0));
  const inflVals    = monthly.map(s => Number(s.inflation_adjusted_value ?? s.value ?? 0));

  const series = [
    { label: 'Portfolio Value',       color: 'hsl(var(--chart-1))', values: valueVals  },
    { label: 'Invested Capital',      color: 'hsl(var(--chart-2))', values: investVals },
    { label: 'Inflation-Adj. Value',  color: 'hsl(var(--chart-4))', values: inflVals   },
  ];

  const chart = svgLineChart(series, { labels, height: 180 });

  // Monthly return-% mini-table (last 12 months max)
  const tableSnaps = monthly.slice(-12);
  const tableRows = tableSnaps.map(s => {
    const val     = Number(s.value ?? 0);
    const inv     = Number(s.invested ?? 0);
    const ret     = Number(s.return_pct ?? 0);
    const gl      = val - inv;
    const cls     = signClass(gl);
    const d       = new Date(s.snapshot_date);
    return `<tr>
      <td>${fmtMonthLabel(d.getFullYear(), d.getMonth() + 1)}</td>
      <td class="num">${fmtCurrency(inv, currency)}</td>
      <td class="num">${fmtCurrency(val, currency)}</td>
      <td class="num ${cls}">${fmtCurrency(gl, currency)}</td>
      <td class="num ${cls}">${fmtPct(ret, true)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="section-title">Performance Trend</div>
      <div class="section-subtitle">Portfolio value vs. invested capital (${monthly.length} data points)</div>
      <hr class="section-divider">
      <div class="chart-wrap">${chart}</div>
      ${tableRows ? `
        <table class="data-table">
          <thead><tr>
            <th>Month</th>
            <th class="num">Invested</th>
            <th class="num">Value</th>
            <th class="num">P/L</th>
            <th class="num">Return %</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>` : ''}
    </div>`;
}
