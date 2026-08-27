/**
 * Asset Class Detail section renderer.
 *
 * Shows a grouped bar chart (invested vs value per class) and a per-class P/L table.
 */

import { buildAssetClassBuckets, emptySection, escapeHtml, fmtCurrency, fmtPct, sectionPage, signClass, svgGenericGroupedBarChart } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherPortfolio.js').PortfolioReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderAssetClassDetail(data, { currency }) {
  const latest    = (data?.snapshots ?? []).at(-1);
  const breakdown = data?.breakdown ?? [];

  if (!latest && !breakdown.length) {
    return emptySection({
      title: 'Asset Class Detail',
      subtitle: 'Invested vs. current value per asset class',
      heading: 'No data',
      message: 'Add investments to see the asset class breakdown.',
    });
  }

  const classes = buildAssetClassBuckets(latest, breakdown).sort((a, b) => b.value - a.value);

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

  return sectionPage({
    title: 'Asset Class Detail',
    subtitle: 'Invested capital vs. current value per asset class',
    content: `
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
      </table>`,
  });
}
